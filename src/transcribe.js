// transcribe(audioPath) -> { text }. The only place that knows about OpenAI.
// Throws on any failure, including a response without a text field; the caller records it.
const fs = require("fs");
const path = require("path");

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const ATTEMPTS = 2;

async function transcribe(audioPath) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const form = new FormData();
    form.append("file", await fs.openAsBlob(audioPath), path.basename(audioPath));
    form.append("model", "whisper-1");
    form.append("response_format", "json");

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      lastError = new Error(`whisper request failed: ${err.message}`);
      continue;
    }

    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (typeof body?.text !== "string") throw new Error("whisper response has no text field");
      return { text: body.text.trim() };
    }

    const detail = (await res.text().catch(() => "")).slice(0, 200);
    lastError = new Error(`whisper returned ${res.status}: ${detail}`);
    // Only rate limits and server errors are worth a second try.
    if (res.status !== 429 && res.status < 500) break;
  }
  throw lastError;
}

module.exports = { transcribe };
