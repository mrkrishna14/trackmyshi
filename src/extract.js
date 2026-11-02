// extract(bundle, context) -> { items, noneReason, toolText, pageTexts, usage }.
// One Claude agent run with web search and fetch: it reads the reel, finds the official
// application page and reports deadlines with exact quotes. Nothing here is trusted yet:
// src/verify.js checks every quote, date and link in code before anything is used.
// Throws ExtractionError on a refusal, a missing or malformed result, or an API failure.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5-5";
// Each pause_turn means the server-side tool loop hit its iteration limit; resume a few times.
const MAX_REQUESTS = 4;

const SYSTEM = `You find application deadlines and official application links for opportunities promoted in Instagram reels aimed at students: internships, jobs, fellowships, programs, competitions and scholarships.

You get the reel's caption, its audio transcript and the text visible on screen. For each opportunity the reel promotes:
1. Work out the organisation and the program from the reel.
2. Search the web for the official application page: the organisation's own careers or program page, or its applicant-tracking page (Greenhouse, Lever, Workday, Ashby and similar). Prefer the current application cycle. Use aggregators, news articles and the creator's link pages only as leads to the official page.
3. Fetch the official page and read its application deadline.
4. Call submit_result exactly once with what you found.

When a reel lists several opportunities, cover every one: find each one's application page even when there is no deadline to look up. Budget about two searches per opportunity, and don't search for a deadline the reel doesn't mention if the application page is already found.

Rules:
- Every quote must be copied character for character from the fetched page or from the reel text. Code checks each quote against the source and discards any that don't match.
- A deadline is the last date to apply. Program dates, event dates, start dates and interview dates are not deadlines; put them in program_dates.
- A creator saying "if you're watching this before <date>" or "apply before <date>" is stating the application deadline.
- If the official page gives no deadline (rolling or not stated), leave the official deadline fields null but still report application_url. Never estimate a date.
- Recruiting runs ahead of the season: in autumn, students apply for next summer. If the reel is about a cycle that has already ended (an old reel), find the same program's current-cycle posting instead. If there isn't one, report the old posting with its cycle so it isn't mistaken for an open one.
- Dates are YYYY-MM-DD. When a quote has no year, use the next occurrence of that date on or after the reel's post date.
- If the reel promotes no specific opportunity, submit an empty items list and say why in none_reason.`;

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const STR = { type: "string" };

const ITEM_FIELDS = {
  company: STR,
  program: STR,
  application_url: nullable(STR),
  official_url: nullable(STR),
  official_deadline_date: nullable(STR),
  official_deadline_quote: nullable(STR),
  deadline_time: nullable(STR),
  deadline_timezone: nullable(STR),
  creator_deadline_date: nullable(STR),
  creator_deadline_quote: nullable(STR),
  creator_deadline_source: nullable({ type: "string", enum: ["caption", "transcript", "ocr"] }),
  program_dates: nullable(STR),
  cycle: nullable(STR),
  reel_cycle: nullable(STR),
  posting_status: { type: "string", enum: ["open", "closed", "unknown"] },
};

const SUBMIT_TOOL = {
  name: "submit_result",
  description:
    "Report the opportunities in the reel. application_url is where a student applies; official_url is the page the official deadline quote was copied from (often the same). deadline_time is 24-hour HH:MM and deadline_timezone an IANA name, both only when the official page states them. creator_deadline_* is the deadline as the creator states it in the reel, with the source it was quoted from. cycle is the season and year the posting is for, e.g. \"Summer 2027\", as stated on the page or in the reel. reel_cycle is the season and year the reel itself talks about, only if the reel says it; it differs from cycle when you found a newer posting for an old reel. posting_status is open only if you saw the specific posting accepting applications; closed if it says closed, filled or no longer accepting; otherwise unknown.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: ITEM_FIELDS, required: Object.keys(ITEM_FIELDS), additionalProperties: false },
      },
      none_reason: nullable(STR),
    },
    required: ["items", "none_reason"],
    additionalProperties: false,
  },
};

// Caps, not targets: a single-program reel stops after a search or two, while a reel listing
// six internships needs about two searches each.
const TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 12 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12, max_content_tokens: 20000 },
  SUBMIT_TOOL,
];

class ExtractionError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

function reelText(bundle, context) {
  const ocr = (bundle.ocr || []).filter((f) => f.text).map((f) => `[${f.t}s] ${f.text}`).join("\n");
  return [
    `Today is ${context.today}. The reel was posted on ${bundle.uploadDate || "an unknown date"} by @${bundle.creator || "unknown"}.`,
    `<caption>\n${bundle.caption || ""}\n</caption>`,
    `<transcript>\n${bundle.transcript ?? "(not available)"}\n</transcript>`,
    `<on_screen_text>\n${bundle.ocr ? ocr : "(not available)"}\n</on_screen_text>`,
  ].join("\n\n");
}

// `client` is a parameter so tests can pass a fake.
async function extract(bundle, context, client = new Anthropic()) {
  const messages = [{ role: "user", content: reelText(bundle, context) }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0, requests: 0 };
  const blocks = [];

  for (let i = 0; i < MAX_REQUESTS; i++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM,
        tools: TOOLS,
        output_config: { effort: "medium" },
        messages,
      });
    } catch (err) {
      throw new ExtractionError("extraction_failed", `claude request failed: ${err.message}`);
    }

    usage.requests++;
    usage.input_tokens += response.usage?.input_tokens || 0;
    usage.output_tokens += response.usage?.output_tokens || 0;
    usage.web_searches += response.usage?.server_tool_use?.web_search_requests || 0;
    blocks.push(...response.content);

    const submit = response.content.find((b) => b.type === "tool_use" && b.name === "submit_result");
    if (submit) return { ...parseResult(submit.input), ...evidence(blocks), usage };
    if (response.stop_reason !== "pause_turn") {
      throw new ExtractionError("extraction_invalid", `extraction stopped with ${response.stop_reason} and no result`);
    }
    messages.push({ role: "assistant", content: response.content });
  }
  throw new ExtractionError("extraction_invalid", `no result after ${MAX_REQUESTS} requests`);
}

// Strict tool use should already guarantee this shape; the check is the contract either way.
function parseResult(input) {
  if (!Array.isArray(input?.items)) throw new ExtractionError("extraction_invalid", "result has no items array");
  for (const item of input.items) {
    for (const [field, schema] of Object.entries(ITEM_FIELDS)) {
      const value = item?.[field];
      const ok = schema.anyOf
        ? value === null || typeof value === "string"
        : typeof value === "string" && (!schema.enum || schema.enum.includes(value));
      if (!ok) throw new ExtractionError("extraction_invalid", `item field ${field} is malformed`);
    }
  }
  if (input.none_reason !== null && typeof input.none_reason !== "string") {
    throw new ExtractionError("extraction_invalid", "none_reason is malformed");
  }
  return { items: input.items, noneReason: input.none_reason };
}

// What the agent actually saw: every tool result as text (to prove a URL came from a search or
// fetch rather than from the model) and the text of each fetched page (to check quotes).
function evidence(blocks) {
  const results = blocks.filter((b) => b.type.endsWith("_tool_result"));
  const pageTexts = {};
  for (const block of results) {
    const page = block.type === "web_fetch_tool_result" ? block.content : null;
    const data = page?.content?.source?.type === "text" ? page.content.source.data : null;
    if (page?.url && data) pageTexts[page.url] = data;
  }
  return { toolText: JSON.stringify(results), pageTexts };
}

module.exports = { extract, ExtractionError, MODEL };
