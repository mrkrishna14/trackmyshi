const test = require("node:test");
const assert = require("node:assert/strict");
const { extract, MODEL } = require("../src/extract");

const bundle = { caption: "cap", transcript: "before November 15", ocr: [{ t: 1, text: "Nov 15" }], creator: "jakemok.io", uploadDate: "2026-10-23" };
const context = { today: "2026-11-01" };

const goodItem = {
  company: "Jane Street",
  program: "FOCUS",
  application_url: "https://janestreet.example/apply",
  official_url: "https://janestreet.example/focus",
  official_deadline_date: "2026-11-12",
  official_deadline_quote: "due November 12, 2026",
  deadline_time: null,
  deadline_timezone: null,
  creator_deadline_date: "2026-11-15",
  creator_deadline_quote: "before November 15",
  creator_deadline_source: "transcript",
  program_dates: null,
  cycle: "Winter 2027",
  reel_cycle: null,
};

function fakeClient(...responses) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => (calls.push(structuredClone(params)), responses.shift()) } },
  };
}
const usage = (input, output, searches = 0) => ({ input_tokens: input, output_tokens: output, server_tool_use: { web_search_requests: searches } });
const submit = (input) => ({ type: "tool_use", id: "t1", name: "submit_result", input });

test("resumes after pause_turn, sums usage and returns the submitted items with evidence", async () => {
  const fetchResult = {
    type: "web_fetch_tool_result",
    tool_use_id: "f1",
    content: { type: "web_fetch_result", url: "https://janestreet.example/focus", content: { type: "document", source: { type: "text", data: "Applications due November 12, 2026" } } },
  };
  const searchResult = { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://janestreet.example/apply" }] };
  const client = fakeClient(
    { stop_reason: "pause_turn", content: [searchResult], usage: usage(1000, 100, 2) },
    { stop_reason: "tool_use", content: [fetchResult, submit({ items: [goodItem], none_reason: null })], usage: usage(2000, 300) }
  );

  const result = await extract(bundle, context, client);
  assert.deepEqual(result.items, [goodItem]);
  assert.deepEqual(result.usage, { input_tokens: 3000, output_tokens: 400, web_searches: 2, requests: 2 });
  assert.equal(result.pageTexts["https://janestreet.example/focus"], "Applications due November 12, 2026");
  assert.ok(result.toolText.includes("https://janestreet.example/apply"));

  assert.equal(client.calls[0].model, MODEL);
  assert.ok(client.calls[0].tools.some((t) => t.type === "web_search_20260209"));
  assert.match(client.calls[0].messages[0].content, /Today is 2026-11-01/);
  assert.match(client.calls[0].messages[0].content, /before November 15/);
  assert.equal(client.calls[1].messages.at(-1).role, "assistant", "the paused turn is sent back as-is");
});

test("an empty result keeps its reason", async () => {
  const client = fakeClient({ stop_reason: "tool_use", content: [submit({ items: [], none_reason: "a vlog, no opportunity" })], usage: usage(1, 1) });
  const result = await extract(bundle, context, client);
  assert.deepEqual(result.items, []);
  assert.equal(result.noneReason, "a vlog, no opportunity");
});

test("finishing without submit_result is extraction_invalid", async () => {
  const client = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "I think it's Nov 15" }], usage: usage(1, 1) });
  await assert.rejects(extract(bundle, context, client), { reason: "extraction_invalid" });
});

test("a malformed result is extraction_invalid", async () => {
  const client = fakeClient({ stop_reason: "tool_use", content: [submit({ items: [{ ...goodItem, company: 7 }], none_reason: null })], usage: usage(1, 1) });
  await assert.rejects(extract(bundle, context, client), { reason: "extraction_invalid", message: /company/ });
});

test("an API error is extraction_failed", async () => {
  const client = { beta: { messages: { create: async () => { throw new Error("529 overloaded"); } } } };
  await assert.rejects(extract(bundle, context, client), { reason: "extraction_failed", message: /overloaded/ });
});

test("endless pause_turn gives up", async () => {
  const paused = () => ({ stop_reason: "pause_turn", content: [], usage: usage(1, 1) });
  const client = fakeClient(paused(), paused(), paused(), paused(), paused());
  await assert.rejects(extract(bundle, context, client), { reason: "extraction_invalid", message: /no result/ });
});
