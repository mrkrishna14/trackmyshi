// ocr(frames) -> { frames: [{ t, text }], usage }. One Claude vision call that copies on-screen
// text verbatim. The only place that knows about Anthropic until extraction arrives in module 3.
// Throws on a refusal, truncation or any response that fails validation; the caller records it.
const fs = require("fs/promises");
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5-5";

const PROMPT = `These are frames from an Instagram reel, in order. For each frame, copy every piece of text visible on screen exactly as written: overlays, captions, subtitles, signs, URLs, handles, dates and times.

Copy, don't interpret. Keep the original spelling, punctuation, capitalisation and line order. Never correct, complete, summarise or guess text that is cut off or unreadable; leave it out. If a frame has no readable text, return an empty string for it.`;

const SCHEMA = {
  type: "object",
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, text: { type: "string" } },
        required: ["index", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["frames"],
  additionalProperties: false,
};

let defaultClient;

// `client` is a parameter so tests can pass a fake.
async function ocr(frames, client = (defaultClient ??= new Anthropic())) {
  if (frames.length === 0) return { frames: [], usage: null };

  const content = [];
  for (const [index, frame] of frames.entries()) {
    content.push({ type: "text", text: `Frame ${index} (${frame.t}s):` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(frame.path)).toString("base64") },
    });
  }
  content.push({ type: "text", text: PROMPT });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Retries a classifier decline on Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason !== "end_turn") throw new Error(`ocr stopped with ${response.stop_reason}`);
  const text = response.content.find((block) => block.type === "text")?.text;
  return { frames: parseFrames(text, frames), usage: response.usage };
}

// Structured outputs should already guarantee the shape; this check is the contract either way.
function parseFrames(text, frames) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ocr response is not JSON");
  }
  if (!Array.isArray(parsed?.frames)) throw new Error("ocr response has no frames array");

  const texts = new Array(frames.length).fill("");
  for (const item of parsed.frames) {
    if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= frames.length || typeof item.text !== "string") {
      throw new Error("ocr response has a malformed frame entry");
    }
    texts[item.index] = item.text.trim();
  }
  return frames.map((frame, i) => ({ t: frame.t, text: texts[i] }));
}

module.exports = { ocr, MODEL };
