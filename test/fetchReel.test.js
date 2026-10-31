const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { PATH_WITH_STUBS, tempDir, makeVideo } = require("./helpers");
const { fetchReel, classifyFetchError } = require("../src/fetchReel");

const REEL_URL = "https://www.instagram.com/reel/De2uJ0aP1zu/";

test.describe("fetchReel with a stubbed yt-dlp", () => {
  let realPath;
  test.before(() => {
    realPath = process.env.PATH;
    process.env.PATH = PATH_WITH_STUBS;
  });
  test.after(() => {
    process.env.PATH = realPath;
    delete process.env.STUB_YTDLP;
  });

  test("returns the video path, creator handle and ISO upload date", async () => {
    const dir = tempDir();
    process.env.STUB_YTDLP = "ok";
    process.env.STUB_VIDEO = makeVideo(tempDir());
    const result = await fetchReel(REEL_URL, dir);
    assert.equal(result.videoPath, `${dir}/reel.mp4`);
    assert.ok(fs.existsSync(result.videoPath));
    assert.equal(result.creator, "jakemok.io");
    assert.equal(result.uploadDate, "2026-10-23");
  });

  test("a private or deleted reel fails with reel_private_or_deleted", async () => {
    process.env.STUB_YTDLP = "private";
    await assert.rejects(fetchReel(REEL_URL, tempDir()), { reason: "reel_private_or_deleted" });
  });

  test("any other yt-dlp error fails with fetch_failed", async () => {
    delete process.env.STUB_YTDLP;
    await assert.rejects(fetchReel(REEL_URL, tempDir()), { reason: "fetch_failed", message: /disabled in tests/ });
  });
});

test("classifyFetchError keeps Instagram's ambiguous login message separate", () => {
  assert.equal(
    classifyFetchError("ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required"),
    "fetch_login_required"
  );
  assert.equal(classifyFetchError("ERROR: [Instagram] x: This content isn't available"), "reel_private_or_deleted");
  assert.equal(classifyFetchError("ERROR: unable to download video data: HTTP Error 404: Not Found"), "reel_private_or_deleted");
  assert.equal(classifyFetchError("ERROR: Unable to extract shared data"), "fetch_failed");
});
