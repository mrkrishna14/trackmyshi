const test = require("node:test");
const assert = require("node:assert/strict");
const { identify, findPosting, MODEL } = require("../src/extract");

const bundle = { caption: "cap", transcript: "before November 15", ocr: [{ t: 1, text: "Nov 15" }], creator: "jakemok.io", uploadDate: "2026-10-23" };
const context = { today: "2026-11-01" };

const opportunity = {
  company: "Jane Street",
  program: "FOCUS",
  reel_cycle: null,
  creator_deadline_date: "2026-11-15",
  creator_deadline_quote: "before November 15",
  creator_deadline_source: "transcript",
  program_dates: "January 11-14",
};

const posting = {
  application_url: "https://janestreet.example/apply",
  official_url: "https://janestreet.example/focus",
  official_deadline_date: "2026-11-12",
  official_deadline_quote: "due November 12, 2026",
  deadline_time: null,
  deadline_timezone: null,
  cycle: "Winter 2027",
  posting_status: "open",
};

function fakeClient(...responses) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => (calls.push(structuredClone(params)), responses.shift()) } },
  };
}
const usage = (input, output, searches = 0) => ({ input_tokens: input, output_tokens: output, server_tool_use: { web_search_requests: searches } });
const json = (value) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }], usage: usage(100, 20) });
const submit = (input) => ({ type: "tool_use", id: "t1", name: "submit_posting", input });

test.describe("identify", () => {
  test("reads the reel once, without tools, and returns its opportunities", async () => {
    const client = fakeClient(json({ opportunities: [opportunity], none_reason: null }));
    const result = await identify(bundle, context, client);
    assert.deepEqual(result.opportunities, [opportunity]);
    assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20, web_searches: 0, requests: 1 });
    const params = client.calls[0];
    assert.equal(params.model, MODEL);
    assert.equal(params.tools, undefined);
    assert.equal(params.output_config.format.type, "json_schema");
    assert.match(params.messages[0].content, /Today is 2026-11-01[\s\S]*before November 15/);
  });

  test("an empty list keeps its reason", async () => {
    const result = await identify(bundle, context, fakeClient(json({ opportunities: [], none_reason: "a meme" })));
    assert.deepEqual(result.opportunities, []);
    assert.equal(result.noneReason, "a meme");
  });

  test("malformed, truncated or failed responses are errors, never guessed opportunities", async () => {
    await assert.rejects(identify(bundle, context, fakeClient(json({ opportunities: [{ ...opportunity, company: 3 }], none_reason: null }))), { reason: "extraction_invalid", message: /company/ });
    await assert.rejects(identify(bundle, context, fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "nope" }], usage: usage(1, 1) })), { reason: "extraction_invalid", message: /not JSON/ });
    await assert.rejects(identify(bundle, context, fakeClient({ stop_reason: "max_tokens", content: [], usage: usage(1, 1) })), { reason: "extraction_invalid", message: /max_tokens/ });
    const broken = { beta: { messages: { create: async () => { throw new Error("529 overloaded"); } } } };
    await assert.rejects(identify(bundle, context, broken), { reason: "extraction_failed", message: /overloaded/ });
  });
});

test.describe("findPosting", () => {
  test("searches for one opportunity, resumes after pause_turn and returns the posting with evidence", async () => {
    const fetchResult = {
      type: "web_fetch_tool_result",
      tool_use_id: "f1",
      content: { type: "web_fetch_result", url: "https://janestreet.example/focus", content: { type: "document", source: { type: "text", data: "Applications due November 12, 2026" } } },
    };
    const searchResult = { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://janestreet.example/apply" }] };
    const client = fakeClient(
      { stop_reason: "pause_turn", content: [searchResult], usage: usage(1000, 100, 2) },
      { stop_reason: "tool_use", content: [fetchResult, submit(posting)], usage: usage(2000, 300) }
    );
    const result = await findPosting(opportunity, bundle, context, client);
    assert.deepEqual(result.posting, posting);
    assert.deepEqual(result.usage, { input_tokens: 3000, output_tokens: 400, web_searches: 2, requests: 2 });
    assert.equal(result.pageTexts["https://janestreet.example/focus"], "Applications due November 12, 2026");
    assert.ok(result.toolText.includes("https://janestreet.example/apply"));

    const first = client.calls[0];
    assert.equal(first.tools.find((t) => t.name === "web_search").max_uses, 4);
    assert.match(first.messages[0].content, /official application page for: Jane Street, FOCUS/);
    assert.equal(client.calls[1].messages.at(-1).role, "assistant", "the paused turn is sent back as-is");
  });

  test("finishing without submit_posting, or a malformed posting, is extraction_invalid", async () => {
    await assert.rejects(
      findPosting(opportunity, bundle, context, fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "I think it's x.com" }], usage: usage(1, 1) })),
      { reason: "extraction_invalid" }
    );
    await assert.rejects(
      findPosting(opportunity, bundle, context, fakeClient({ stop_reason: "tool_use", content: [submit({ ...posting, posting_status: "maybe" })], usage: usage(1, 1) })),
      { reason: "extraction_invalid", message: /posting_status/ }
    );
  });

  test("endless pause_turn gives up", async () => {
    const paused = () => ({ stop_reason: "pause_turn", content: [], usage: usage(1, 1) });
    await assert.rejects(findPosting(opportunity, bundle, context, fakeClient(paused(), paused(), paused(), paused(), paused())), { reason: "extraction_invalid", message: /no posting/ });
  });
});
