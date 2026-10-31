const test = require("node:test");
const assert = require("node:assert/strict");
const { verifySignature, parseEvents } = require("../src/webhook");
const { sign } = require("./helpers");
const fixture = require("./fixtures/reel-share.json");

const SECRET = "test-secret";

function messaging(message, senderId = "111") {
  return { object: "instagram", entry: [{ messaging: [{ sender: { id: senderId }, message }] }] };
}

test("verifySignature accepts a correct signature over the raw bytes", () => {
  const raw = Buffer.from(JSON.stringify(fixture));
  assert.equal(verifySignature(raw, sign(raw, SECRET), SECRET), true);
});

test("verifySignature rejects wrong secret, tampered body, bad or missing header, missing secret", () => {
  const raw = Buffer.from(JSON.stringify(fixture));
  const header = sign(raw, SECRET);
  assert.equal(verifySignature(raw, sign(raw, "other"), SECRET), false);
  assert.equal(verifySignature(Buffer.from(raw.toString() + " "), header, SECRET), false);
  assert.equal(verifySignature(raw, undefined, SECRET), false);
  assert.equal(verifySignature(raw, "sha1=abc", SECRET), false);
  assert.equal(verifySignature(raw, "sha256=abc", SECRET), false);
  assert.equal(verifySignature(raw, header, undefined), false);
});

test("parseEvents extracts the reel from the real payload shape", () => {
  assert.deepEqual(parseEvents(fixture), [
    {
      kind: "reel",
      mid: "aWdfZAG1faXRlbTpJR01lc3NhZA2VfSUQ6dGVzdC1taWQtMQ",
      senderId: "1000000000000001",
      reelUrl: "https://www.instagram.com/reel/De2uJ0aP1zu/",
      caption: "let’s focus up guys\n#janestreet #quant #college #internship #software",
    },
  ]);
});

test("parseEvents returns text messages as kind text", () => {
  assert.deepEqual(parseEvents(messaging({ mid: "m1", text: "undo" })), [
    { kind: "text", mid: "m1", senderId: "111", text: "undo" },
  ]);
});

test("parseEvents drops echoes, deletions, reads, reactions and non-reel attachments", () => {
  const reel = [{ type: "ig_reel", payload: { url: "https://www.instagram.com/reel/x/" } }];
  assert.deepEqual(parseEvents(messaging({ mid: "m1", is_echo: true, attachments: reel })), []);
  assert.deepEqual(parseEvents(messaging({ mid: "m2", is_deleted: true })), []);
  assert.deepEqual(parseEvents(messaging({ mid: "m3", attachments: [{ type: "image", payload: { url: "u" } }] })), []);
  assert.deepEqual(parseEvents({ entry: [{ messaging: [{ sender: { id: "1" }, read: { mid: "m4" } }] }] }), []);
  assert.deepEqual(parseEvents({ entry: [{ messaging: [{ sender: { id: "1" }, reaction: { mid: "m5" } }] }] }), []);
});

test("parseEvents tolerates malformed bodies without throwing", () => {
  for (const body of [null, {}, "x", { entry: "oops" }, { entry: [null, { messaging: {} }] }]) {
    assert.deepEqual(parseEvents(body), []);
  }
  assert.deepEqual(parseEvents(messaging({ mid: "m1", attachments: "nope" })), []);
});
