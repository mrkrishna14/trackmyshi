// ffmpeg/ffprobe helpers: probe a video, pull its audio, and sample frames for OCR.
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);
const OPTS = { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 };

// Evenly spaced rather than scene-change frames: deadline text is often overlaid on a static
// talking-head shot, which scene detection skips.
const FRAME_COUNT = 8;

async function probe(videoPath) {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", videoPath],
    OPTS
  );
  const info = JSON.parse(stdout);
  return {
    durationSec: Number(info.format?.duration) || 0,
    hasAudio: (info.streams || []).some((s) => s.codec_type === "audio"),
  };
}

// Mono 16 kHz at 32 kbps: a 90s reel is ~360 KB, far under Whisper's 25 MB limit.
async function extractAudio(videoPath, dir) {
  const audioPath = path.join(dir, "audio.mp3");
  await run("ffmpeg", ["-v", "error", "-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audioPath], OPTS);
  return audioPath;
}

// Frames are capped at 1024px tall, which keeps text readable and image tokens predictable.
async function sampleFrames(videoPath, durationSec, dir) {
  const frames = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const t = Math.round(((i + 0.5) / FRAME_COUNT) * durationSec * 10) / 10;
    const framePath = path.join(dir, `frame-${i}.jpg`);
    await run(
      "ffmpeg",
      ["-v", "error", "-y", "-ss", String(t), "-i", videoPath, "-frames:v", "1", "-vf", "scale=-2:'min(1024,ih)'", "-q:v", "3", framePath],
      OPTS
    );
    frames.push({ t, path: framePath });
  }
  return frames;
}

module.exports = { probe, extractAudio, sampleFrames, FRAME_COUNT };
