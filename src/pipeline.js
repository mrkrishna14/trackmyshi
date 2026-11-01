const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const db = require("./db");
const queue = require("./queue");
const { fetchReel } = require("./fetchReel");
const media = require("./media");
const { transcribe } = require("./transcribe");
const { ocr } = require("./ocr");
const { extract } = require("./extract");
const { verifyExtraction } = require("./verify");

async function receiveReel(reel) {
  if (!(await db.insertShare(reel))) {
    console.log(`share mid=${reel.mid} duplicate delivery ignored`);
    return;
  }
  queue.enqueue(() => processShare(reel.mid));
}

// Each stage reads the row, does its work and saves the next status, so a share re-queued after
// a restart resumes at the stage it reached. Calendar -> reply arrive in modules 4-5.
async function processShare(mid) {
  let share = await db.getShare(mid);
  if (!share) return;
  console.log(`share mid=${mid} picked up status=${share.status}`);
  try {
    if (share.status === "received") share = await fetchStage(share);
    if (share.status === "fetched") share = await extractStage(share);
  } catch (err) {
    console.log(`share mid=${mid} stage threw: ${err.stack || err.message}`);
    await db.setStatus(mid, "failed", "internal_error");
  }
}

async function fetchStage(share) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "due-"));
  try {
    const { bundle, problems } = await buildBundle(share, dir);
    await db.setStatus(share.mid, "fetched", problems.join(",") || null, { bundle });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return db.getShare(share.mid);
}

async function extractStage(share) {
  // Earlier problems (e.g. a failed fetch) stay on the row so the reply can mention them.
  const problems = share.failure_reason ? share.failure_reason.split(",") : [];
  const { extraction, reason } = await runExtraction(share);
  if (reason) await db.setStatus(share.mid, "failed", [...problems, reason].join(","));
  else await db.setStatus(share.mid, "extracted", problems.join(",") || null, { extraction });
  return db.getShare(share.mid);
}

// "Today" in the westernmost US timezone, so a deadline later today still counts as upcoming.
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

// Runs the agent, then the code checks. Returns { extraction } or { reason } for a failure.
// `deps` is a parameter so tests can replace the vendor and the checks.
async function runExtraction(share, deps = { extract, verifyExtraction, today: todayIso() }) {
  const { mid, bundle } = share;
  const today = deps.today;
  // Years missing from a quote are read relative to when the reel was posted.
  const reference = bundle.uploadDate || share.received_at.toISOString().slice(0, 10);
  const start = Date.now();
  let result;
  try {
    result = await deps.extract(bundle, { today });
  } catch (err) {
    log(mid, `extraction failed in ${seconds(start)}: ${err.message}`);
    return { reason: err.reason || "extraction_failed" };
  }
  const { input_tokens, output_tokens, web_searches, requests } = result.usage;
  log(mid, `extraction ran in ${seconds(start)}: ${requests} request(s), ${web_searches} search(es), in=${input_tokens} out=${output_tokens} tokens`);

  const extraction = await deps.verifyExtraction(result, bundle, { today, reference });
  if (extraction.items.length === 0) log(mid, `no opportunity found: ${extraction.none_reason}`);
  for (const [i, item] of extraction.items.entries()) {
    const date = item.deadline ? `${item.deadline.date}${item.deadline.time ? ` ${item.deadline.time} ${item.deadline.timezone}` : ""}` : "none";
    const link = item.link ? `${item.link.source} ${item.link.url}` : "none";
    log(mid, `item ${i} ${item.company} / ${item.program}: date=${date} (${item.date_status}${item.note ? `: ${item.note}` : ""}) link=${link}`);
  }
  return { extraction };
}

const log = (mid, message) => console.log(`share mid=${mid} ${message}`);
const seconds = (start) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

// Turns a share into everything extraction will read. Every step that fails leaves its part
// empty and adds a reason to `problems` instead of stopping: the caption alone often has the
// deadline, and the reply (module 5) tells the student what couldn't be read.
// `deps` is a parameter so tests can replace the binaries and vendors.
async function buildBundle(share, dir, deps = { fetchReel, media, transcribe, ocr }) {
  const { mid } = share;
  const problems = [];
  const bundle = { caption: share.caption, transcript: null, ocr: null, creator: null, uploadDate: null, durationSec: null };

  let video, durationSec, hasAudio;
  const start = Date.now();
  try {
    video = await deps.fetchReel(share.reel_url, dir);
    Object.assign(bundle, { creator: video.creator, uploadDate: video.uploadDate });
    // A file ffprobe can't read counts as a failed fetch.
    ({ durationSec, hasAudio } = await deps.media.probe(video.videoPath));
    bundle.durationSec = Math.round(durationSec);
    const { size } = await fs.stat(video.videoPath);
    log(mid, `fetched ${bundle.durationSec}s video in ${seconds(start)} (${(size / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    problems.push(err.reason || "fetch_failed");
    log(mid, `fetch failed in ${seconds(start)}, continuing with caption only: ${err.message}`);
    return { bundle, problems };
  }

  const transcriptPart = (async () => {
    if (!hasAudio) {
      bundle.transcript = "";
      return;
    }
    const begin = Date.now();
    try {
      const audioPath = await deps.media.extractAudio(video.videoPath, dir);
      bundle.transcript = (await deps.transcribe(audioPath)).text;
      log(mid, `transcribed ${bundle.durationSec}s of audio in ${seconds(begin)} (${bundle.transcript.length} chars)`);
    } catch (err) {
      problems.push("transcribe_failed");
      log(mid, `transcription failed in ${seconds(begin)}: ${err.message}`);
    }
  })();

  const ocrPart = (async () => {
    const begin = Date.now();
    try {
      const frames = await deps.media.sampleFrames(video.videoPath, durationSec, dir);
      const result = await deps.ocr(frames);
      bundle.ocr = result.frames;
      const tokens = result.usage ? ` in=${result.usage.input_tokens} out=${result.usage.output_tokens} tokens` : "";
      log(mid, `ocr read ${frames.length} frames in ${seconds(begin)}${tokens}`);
    } catch (err) {
      problems.push("ocr_failed");
      log(mid, `ocr failed in ${seconds(begin)}: ${err.message}`);
    }
  })();

  await Promise.all([transcriptPart, ocrPart]);
  problems.sort(); // the two parts finish in either order
  return { bundle, problems };
}

async function requeueInProgress() {
  const mids = await db.inProgressMids();
  for (const mid of mids) queue.enqueue(() => processShare(mid));
  console.log(`requeued ${mids.length} in-progress share(s)`);
}

module.exports = { receiveReel, requeueInProgress, buildBundle, runExtraction };
