const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tempDir } = require("./helpers");
const { ocr, MODEL } = require("../src/ocr");

let frames;
test.before(() => {
  const dir = tempDir();
  frames = [0.5, 1.5, 2.5].map((t, i) => {
    const p = path.join(dir, `frame-${i}.jpg`);
    fs.writeFileSync(p, "fake jpeg");
    return { t, path: p };
  });
});

function fakeClient(response) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, ...response };
        },
      },
    },
  };
  return { client, calls };
}

const textResponse = (text) => ({ content: [{ type: "text", text }] });

test("sends every frame and maps the text back to its timestamp", async () => {
  const { client, calls } = fakeClient(
    textResponse(JSON.stringify({ frames: [{ index: 0, text: "if ur watching\nbefore Nov 15" }, { index: 2, text: " jane street " }] }))
  );
  const result = await ocr(frames, client);
  assert.deepEqual(result.frames, [
    { t: 0.5, text: "if ur watching\nbefore Nov 15" },
    { t: 1.5, text: "" },
    { t: 2.5, text: "jane street" },
  ]);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });

  const params = calls[0];
  assert.equal(params.model, MODEL);
  assert.equal(params.output_config.format.type, "json_schema");
  const images = params.messages[0].content.filter((block) => block.type === "image");
  assert.equal(images.length, 3);
  assert.equal(images[0].source.media_type, "image/jpeg");
});

test("no frames means no call", async () => {
  const { client, calls } = fakeClient(textResponse("{}"));
  assert.deepEqual(await ocr([], client), { frames: [], usage: null });
  assert.equal(calls.length, 0);
});

test("malformed responses are errors, never guessed text", async () => {
  const cases = [
    ["not json", /not JSON/],
    [JSON.stringify({ text: "x" }), /no frames array/],
    [JSON.stringify({ frames: [{ index: 7, text: "x" }] }), /malformed frame/],
    [JSON.stringify({ frames: [{ index: 0, text: 5 }] }), /malformed frame/],
  ];
  for (const [text, error] of cases) {
    await assert.rejects(ocr(frames, fakeClient(textResponse(text)).client), error);
  }
});

test("a refusal or truncated response is an error", async () => {
  await assert.rejects(ocr(frames, fakeClient({ stop_reason: "refusal", content: [] }).client), /stopped with refusal/);
  await assert.rejects(ocr(frames, fakeClient({ stop_reason: "max_tokens", ...textResponse("{") }).client), /stopped with max_tokens/);
});
