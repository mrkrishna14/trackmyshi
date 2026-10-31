const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { tempDir, makeVideo } = require("./helpers");
const media = require("../src/media");

test("probe reports duration and whether there is an audio track", async () => {
  const dir = tempDir();
  const withAudio = await media.probe(makeVideo(dir));
  assert.ok(Math.abs(withAudio.durationSec - 4) < 0.5);
  assert.equal(withAudio.hasAudio, true);
  assert.equal((await media.probe(makeVideo(dir, { audio: false }))).hasAudio, false);
});

test("extractAudio writes a small mp3", async () => {
  const dir = tempDir();
  const audioPath = await media.extractAudio(makeVideo(dir), dir);
  assert.match(audioPath, /audio\.mp3$/);
  assert.ok(fs.statSync(audioPath).size > 0);
});

test("sampleFrames takes evenly spaced frames across the whole clip", async () => {
  const dir = tempDir();
  const frames = await media.sampleFrames(makeVideo(dir), 4, dir);
  assert.equal(frames.length, media.FRAME_COUNT);
  assert.deepEqual(frames.map((f) => f.t), [0.3, 0.8, 1.3, 1.8, 2.3, 2.8, 3.3, 3.8]);
  for (const frame of frames) assert.ok(fs.statSync(frame.path).size > 0);
});
