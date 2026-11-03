// The only Anthropic code besides src/ocr.js. Two steps, modelled on how answer engines fan a
// question out into focused searches:
//   identify(bundle, context) -> { opportunities, noneReason, usage }
//     one call, no tools: which opportunities the reel promotes, as the reel states them.
//   findPosting(opportunity, bundle, context) -> { posting, toolText, pageTexts, usage }
//     one focused agent run per opportunity with web search and fetch: its official page.
// Nothing here is trusted yet: src/verify.js checks every quote, date and link in code.
// Both throw ExtractionError on a refusal, a missing or malformed result, or an API failure.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5-5";
// Each pause_turn means the server-side tool loop hit its iteration limit; resume a few times.
const MAX_REQUESTS = 4;

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const STR = { type: "string" };

class ExtractionError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// --- identify -------------------------------------------------------------------------------

const IDENTIFY_SYSTEM = `You read Instagram reels aimed at students and list the opportunities they promote: internships, jobs, fellowships, programs, competitions and scholarships. You get the caption, the audio transcript and the text visible on screen.

For each specific opportunity (a named organisation, and a program or role):
- company and program as the reel names them. If the reel names only the organisation, describe the role it mentions (e.g. "Software Engineering Internship").
- reel_cycle: the season and year the reel talks about (e.g. "Summer 2026"), only if the reel says it.
- creator_deadline_*: the application deadline as the creator states it, quoted character for character from the named source, with the date as YYYY-MM-DD. "If you're watching this before <date>" or "apply before <date>" states a deadline. When the quote has no year, use the next occurrence on or after the post date. Leave these null if the reel gives no deadline; never estimate.
- program_dates: when the program itself runs, if stated. These are not deadlines.

A generic list ("comment for my list of 50 internships") with no named organisation is not a specific opportunity. If there are none, return an empty list and say why in none_reason.`;

const OPPORTUNITY_FIELDS = {
  company: STR,
  program: STR,
  reel_cycle: nullable(STR),
  creator_deadline_date: nullable(STR),
  creator_deadline_quote: nullable(STR),
  creator_deadline_source: nullable({ type: "string", enum: ["caption", "transcript", "ocr"] }),
  program_dates: nullable(STR),
};

const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    opportunities: {
      type: "array",
      items: { type: "object", properties: OPPORTUNITY_FIELDS, required: Object.keys(OPPORTUNITY_FIELDS), additionalProperties: false },
    },
    none_reason: nullable(STR),
  },
  required: ["opportunities", "none_reason"],
  additionalProperties: false,
};

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
async function identify(bundle, context, client = new Anthropic()) {
  const response = await request(client, {
    max_tokens: 8000,
    system: IDENTIFY_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: IDENTIFY_SCHEMA } },
    messages: [{ role: "user", content: reelText(bundle, context) }],
  });
  if (response.stop_reason !== "end_turn") throw new ExtractionError("extraction_invalid", `identify stopped with ${response.stop_reason}`);
  let parsed;
  try {
    parsed = JSON.parse(response.content.find((b) => b.type === "text")?.text);
  } catch {
    throw new ExtractionError("extraction_invalid", "identify response is not JSON");
  }
  if (!Array.isArray(parsed?.opportunities)) throw new ExtractionError("extraction_invalid", "identify result has no opportunities array");
  parsed.opportunities.forEach((o) => checkFields(o, OPPORTUNITY_FIELDS, "opportunity"));
  if (parsed.none_reason !== null && typeof parsed.none_reason !== "string") throw new ExtractionError("extraction_invalid", "none_reason is malformed");
  return { opportunities: parsed.opportunities, noneReason: parsed.none_reason, usage: usageOf([response]) };
}

// --- findPosting ----------------------------------------------------------------------------

const FIND_SYSTEM = `You find the official application page for one opportunity a student saw in an Instagram reel, the way a careful researcher would.

1. Search. Try these as needed, stopping once you have the page:
   - "<company> <program> <current cycle> apply"
   - "<company> careers <program>"
   - the company's application system: site:boards.greenhouse.io, site:jobs.lever.co, site:jobs.ashbyhq.com or "myworkdayjobs <company>"
2. Choose the best candidate: the specific posting for this program on the company's own careers site, or the same posting on its application system (many companies list each posting on Greenhouse, Lever, Ashby or Workday too, and those links are best because they can be checked). A general careers or "students" landing page is only a fallback when no specific posting exists. Job boards (LinkedIn, Indeed, Built In, Handshake, Glassdoor) are a last resort, only when nothing official exists.
3. Fetch the page you will report and read it. Check that it is this program, which cycle it is for, whether it is accepting applications, and whether it states an application deadline.
4. If that page is closed, expired or for a past cycle, search once more for the current posting before settling for it.
5. Call submit_posting exactly once.

Rules:
- Report only URLs that appeared in your search or fetch results. Never construct one.
- Quotes must be copied character for character from the fetched page; code checks them and discards any that don't match.
- A deadline is the last date to apply, as YYYY-MM-DD. Program, event, start and interview dates are not deadlines. If the page gives none (rolling or not stated), leave the deadline fields null. Never estimate.
- Recruiting runs ahead of the season: in autumn, students apply for next summer. If the reel is about a cycle that has ended, find the same program's current-cycle posting. If only the old one exists, report it with its cycle.
- posting_status is "open" only if the fetched page shows this posting accepting applications, "closed" if it says closed, filled or no longer accepting, otherwise "unknown".
- If you can't find any page for it, submit with the URLs null.`;

const POSTING_FIELDS = {
  application_url: nullable(STR),
  official_url: nullable(STR),
  official_deadline_date: nullable(STR),
  official_deadline_quote: nullable(STR),
  deadline_time: nullable(STR),
  deadline_timezone: nullable(STR),
  cycle: nullable(STR),
  posting_status: { type: "string", enum: ["open", "closed", "unknown"] },
};

const SUBMIT_TOOL = {
  name: "submit_posting",
  description:
    "Report the page found. application_url is where a student applies; official_url is the page the deadline quote was copied from (often the same). deadline_time is 24-hour HH:MM and deadline_timezone an IANA name, only when the page states them. cycle is the season and year the posting is for, e.g. \"Summer 2027\".",
  strict: true,
  input_schema: { type: "object", properties: POSTING_FIELDS, required: Object.keys(POSTING_FIELDS), additionalProperties: false },
};

const FIND_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 4 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, max_content_tokens: 8000 },
  SUBMIT_TOOL,
];

function opportunityText(opportunity, bundle, context) {
  return [
    `Today is ${context.today}. The reel was posted on ${bundle.uploadDate || "an unknown date"} by @${bundle.creator || "unknown"}.`,
    `Find the official application page for: ${opportunity.company}, ${opportunity.program}.`,
    opportunity.reel_cycle ? `The reel says it is for ${opportunity.reel_cycle}.` : null,
    opportunity.program_dates ? `Program dates mentioned: ${opportunity.program_dates}.` : null,
    `Reel caption, for context:\n<caption>\n${(bundle.caption || "").slice(0, 1500)}\n</caption>`,
  ].filter(Boolean).join("\n");
}

async function findPosting(opportunity, bundle, context, client = new Anthropic()) {
  const messages = [{ role: "user", content: opportunityText(opportunity, bundle, context) }];
  const responses = [];
  for (let i = 0; i < MAX_REQUESTS; i++) {
    const response = await request(client, {
      max_tokens: 16000,
      system: FIND_SYSTEM,
      tools: FIND_TOOLS,
      output_config: { effort: "medium" },
      // Each search and fetch re-reads the conversation so far; caching bills those re-reads at a tenth.
      cache_control: { type: "ephemeral" },
      messages,
    });
    responses.push(response);
    const submit = response.content.find((b) => b.type === "tool_use" && b.name === "submit_posting");
    if (submit) {
      checkFields(submit.input, POSTING_FIELDS, "posting");
      return { posting: submit.input, ...evidence(responses.flatMap((r) => r.content)), usage: usageOf(responses) };
    }
    if (response.stop_reason !== "pause_turn") {
      throw new ExtractionError("extraction_invalid", `find stopped with ${response.stop_reason} and no result`);
    }
    messages.push({ role: "assistant", content: response.content });
  }
  throw new ExtractionError("extraction_invalid", `no posting after ${MAX_REQUESTS} requests`);
}

// --- shared ---------------------------------------------------------------------------------

async function request(client, params) {
  try {
    return await client.beta.messages.create({
      model: MODEL,
      // Retries a classifier decline on Anthropic's recommended fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...params,
    });
  } catch (err) {
    throw new ExtractionError("extraction_failed", `claude request failed: ${err.message}`);
  }
}

// Structured outputs and strict tools should already guarantee the shape; this is the contract.
function checkFields(object, fields, what) {
  for (const [field, schema] of Object.entries(fields)) {
    const value = object?.[field];
    const ok = schema.anyOf
      ? value === null || typeof value === "string"
      : typeof value === "string" && (!schema.enum || schema.enum.includes(value));
    if (!ok) throw new ExtractionError("extraction_invalid", `${what} field ${field} is malformed`);
  }
}

function usageOf(responses) {
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0, requests: responses.length };
  for (const r of responses) {
    // Cached reads are billed at a tenth of the input price; counted as input/10 for cost tracking.
    usage.input_tokens += (r.usage?.input_tokens || 0) + (r.usage?.cache_creation_input_tokens || 0) * 1.25 + (r.usage?.cache_read_input_tokens || 0) * 0.1;
    usage.output_tokens += r.usage?.output_tokens || 0;
    usage.web_searches += r.usage?.server_tool_use?.web_search_requests || 0;
  }
  return usage;
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

module.exports = { identify, findPosting, ExtractionError, MODEL };
