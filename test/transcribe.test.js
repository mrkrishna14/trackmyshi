const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tempDir } = require("./helpers");
const { transcribe } = require("../src/transcribe");

const realFetch = global.fetch;
let audioPath;

test.before(() => {
  audioPath = path.join(tempDir(), "audio.mp3");
  fs.writeFileSync(audioPath, "fake mp3 bytes");
});
test.beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
});
test.afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
});

function fakeFetch(...responses) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return responses.shift();
  };
  return calls;
}

test("sends the audio to whisper-1 and returns the text", async () => {
  const calls = fakeFetch(Response.json({ text: "  apply before November 15  " }));
  assert.deepEqual(await transcribe(audioPath), { text: "apply before November 15" });
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.body.get("model"), "whisper-1");
  assert.equal(calls[0].init.body.get("file").name, "audio.mp3");
});

test("retries once on a server error", async () => {
  const calls = fakeFetch(new Response("busy", { status: 503 }), Response.json({ text: "ok" }));
  assert.deepEqual(await transcribe(audioPath), { text: "ok" });
  assert.equal(calls.length, 2);
});

test("does not retry a client error", async () => {
  const calls = fakeFetch(new Response("bad key", { status: 401 }), Response.json({ text: "never" }));
  await assert.rejects(transcribe(audioPath), /whisper returned 401/);
  assert.equal(calls.length, 1);
});

test("a response without text is an error, not an empty transcript", async () => {
  fakeFetch(Response.json({ transcript: "wrong field" }));
  await assert.rejects(transcribe(audioPath), /no text field/);
});

test("a missing key fails before any request", async () => {
  delete process.env.OPENAI_API_KEY;
  const calls = fakeFetch();
  await assert.rejects(transcribe(audioPath), /OPENAI_API_KEY is not set/);
  assert.equal(calls.length, 0);
});
