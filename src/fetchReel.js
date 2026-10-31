// Downloads a reel from its public page URL with yt-dlp. The caller owns `dir` and deletes it.
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);

// Up to 1280px tall keeps on-screen text legible for OCR without pulling 4K files.
const ARGS = [
  "--no-playlist",
  "--no-progress",
  "--write-info-json",
  "-f", "b[height<=1280]/bv*[height<=1280]+ba/b",
  "--merge-output-format", "mp4",
  "--max-filesize", "200M",
  "--socket-timeout", "30",
];

class FetchError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

// yt-dlp's wording is the only signal for why a fetch failed. "login required" is ambiguous:
// Instagram says it both for private accounts and when it blocks logged-out requests.
function classifyFetchError(stderr) {
  if (/login required|rate-limit/i.test(stderr)) return "fetch_login_required";
  if (/private|not available|isn't available|unavailable|HTTP Error 404|deleted|removed/i.test(stderr)) {
    return "reel_private_or_deleted";
  }
  return "fetch_failed";
}

function firstErrorLine(stderr) {
  const line = stderr.split("\n").find((l) => l.startsWith("ERROR")) || stderr.trim().split("\n").pop() || "";
  return line.slice(0, 300);
}

// "20261028" -> "2026-10-28"
function isoDate(yyyymmdd) {
  return /^\d{8}$/.test(yyyymmdd || "") ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : null;
}

async function fetchReel(reelUrl, dir) {
  try {
    await run("yt-dlp", [...ARGS, "-o", path.join(dir, "reel.%(ext)s"), reelUrl], {
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message);
    throw new FetchError(err.killed ? "fetch_failed" : classifyFetchError(stderr), firstErrorLine(stderr));
  }

  const files = await fs.readdir(dir);
  const video = files.find((f) => f.startsWith("reel.") && !/\.(json|part|ytdl)$/.test(f));
  if (!video) throw new FetchError("fetch_failed", "yt-dlp exited cleanly but wrote no video file");

  const info = JSON.parse(await fs.readFile(path.join(dir, "reel.info.json"), "utf8"));
  return {
    videoPath: path.join(dir, video),
    // Instagram puts the handle in `channel`; `uploader` comes back empty.
    creator: info.channel || info.uploader_id || null,
    uploadDate: isoDate(info.upload_date),
  };
}

module.exports = { fetchReel, classifyFetchError, FetchError };
