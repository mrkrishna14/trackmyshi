const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tempDir } = require("./helpers");
const { FetchError } = require("../src/fetchReel");
const { buildBundle } = require("../src/pipeline");

const share = { mid: "m1", reel_url: "https://www.instagram.com/reel/x/", caption: "apply by Nov 15 #janestreet" };

// Fake binaries and vendors; each test overrides the piece it is about.
function deps(overrides = {}) {
  const calls = [];
  const base = {
    fetchReel: async (url, dir) => {
      const videoPath = path.join(dir, "reel.mp4");
      fs.writeFileSync(videoPath, "video");
      return { videoPath, creator: "jakemok.io", uploadDate: "2026-10-23" };
    },
    media: {
      probe: async () => ({ durationSec: 43.6, hasAudio: true }),
      extractAudio: async (videoPath, dir) => path.join(dir, "audio.mp3"),
      sampleFrames: async () => [{ t: 2.7, path: "f0.jpg" }],
    },
    transcribe: async () => ({ text: "apply before November 15" }),
    ocr: async () => ({ frames: [{ t: 2.7, text: "before Nov 15" }], usage: null }),
  };
  const merged = { ...base, ...overrides, media: { ...base.media, ...overrides.media } };
  for (const name of ["transcribe", "ocr"]) {
    const fn = merged[name];
    merged[name] = (...args) => (calls.push(name), fn(...args));
  }
  return { deps: merged, calls };
}

test("a fetched reel gives caption, transcript, OCR and metadata with no problems", async () => {
  const { bundle, problems } = await buildBundle(share, tempDir(), deps().deps);
  assert.deepEqual(bundle, {
    caption: share.caption,
    transcript: "apply before November 15",
    ocr: [{ t: 2.7, text: "before Nov 15" }],
    creator: "jakemok.io",
    uploadDate: "2026-10-23",
    durationSec: 44,
  });
  assert.deepEqual(problems, []);
});

test("a failed fetch still returns a caption-only bundle with the fetch reason", async () => {
  const { deps: d, calls } = deps({
    fetchReel: async () => {
      throw new FetchError("reel_private_or_deleted", "This content isn't available");
    },
  });
  const { bundle, problems } = await buildBundle(share, tempDir(), d);
  assert.equal(bundle.caption, share.caption);
  assert.equal(bundle.transcript, null);
  assert.equal(bundle.ocr, null);
  assert.deepEqual(problems, ["reel_private_or_deleted"]);
  assert.deepEqual(calls, [], "no vendor calls without a video");
});

test("a video ffprobe can't read counts as a failed fetch", async () => {
  const { deps: d } = deps({ media: { probe: async () => { throw new Error("Invalid data found"); } } });
  const { problems } = await buildBundle(share, tempDir(), d);
  assert.deepEqual(problems, ["fetch_failed"]);
});

test("transcription and OCR fail independently and keep the other part", async () => {
  let result = await buildBundle(share, tempDir(), deps({ transcribe: async () => { throw new Error("whisper returned 401"); } }).deps);
  assert.equal(result.bundle.transcript, null);
  assert.deepEqual(result.bundle.ocr, [{ t: 2.7, text: "before Nov 15" }]);
  assert.deepEqual(result.problems, ["transcribe_failed"]);

  result = await buildBundle(share, tempDir(), deps({ ocr: async () => { throw new Error("ocr response is not JSON"); } }).deps);
  assert.equal(result.bundle.transcript, "apply before November 15");
  assert.equal(result.bundle.ocr, null);
  assert.deepEqual(result.problems, ["ocr_failed"]);
});

test("a silent video gets an empty transcript without calling Whisper", async () => {
  const { deps: d, calls } = deps({ media: { probe: async () => ({ durationSec: 10, hasAudio: false }) } });
  const { bundle, problems } = await buildBundle(share, tempDir(), d);
  assert.equal(bundle.transcript, "");
  assert.deepEqual(problems, []);
  assert.deepEqual(calls, ["ocr"]);
});
