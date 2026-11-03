const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const db = require("./db");
const queue = require("./queue");
const { fetchReel } = require("./fetchReel");
const media = require("./media");
const { transcribe } = require("./transcribe");
const { ocr } = require("./ocr");
const { identify, findPosting } = require("./extract");
const { verifyExtraction, freshEntry } = require("./verify");
const { writeEvents, deleteEvents } = require("./calendar");
const { sendText } = require("./instagram");
const replies = require("./replies");

async function receiveReel(reel) {
  if (!(await db.insertShare(reel))) {
    console.log(`share mid=${reel.mid} duplicate delivery ignored`);
    return;
  }
  queue.enqueue(() => processShare(reel.mid));
}

// Each stage reads the row, does its work and saves the next status, so a share re-queued after
// a restart resumes at the stage it reached.
async function processShare(mid) {
  let share = await db.getShare(mid);
  if (!share) return;
  console.log(`share mid=${mid} picked up status=${share.status}`);
  try {
    if (share.status === "received") share = await fetchStage(share);
    if (share.status === "fetched") share = await extractStage(share);
    if (share.status === "extracted") share = await calendarStage(share);
    if (share.status === "calendared") share = await replyStage(share);
  } catch (err) {
    console.log(`share mid=${mid} stage threw: ${err.stack || err.message}`);
    await fail(share, "internal_error");
  }
}

// Every failure ends in the row's reasons and an honest DM. A failed DM is only logged.
async function fail(share, reason) {
  const problems = share.failure_reason ? share.failure_reason.split(",") : [];
  await db.setStatus(share.mid, "failed", [...problems, reason].join(","));
  await send(share.mid, share.sender_id, replies.failureReply(reason)).catch(() => {});
}

async function send(mid, recipientId, text) {
  try {
    return await sendText(recipientId, text);
  } catch (err) {
    log(mid, `reply failed: ${err.message}`);
    throw err;
  }
}

// Sends one message per opportunity, in order, and records each message id. If Meta refuses
// one partway, the ones already sent are kept on the row and the share fails.
async function replyStage(share) {
  const sent = [];
  for (const message of replies.shareReplies(share)) {
    try {
      sent.push({ index: message.index, reply_mid: await send(share.mid, share.sender_id, message.text) });
    } catch (err) {
      await db.setStatus(share.mid, "failed", [share.failure_reason, err.reason || "reply_failed"].filter(Boolean).join(","), { replies: sent });
      return db.getShare(share.mid);
    }
  }
  log(share.mid, `replied with ${sent.length} message(s)`);
  await db.setStatus(share.mid, "replied", share.failure_reason, { replies: sent });
  return db.getShare(share.mid);
}

// Text messages: "undo" removes a share's events, anything else gets one help line.
async function receiveText(event) {
  if (!(await db.insertText(event.mid, event.senderId))) {
    console.log(`text mid=${event.mid} duplicate delivery ignored`);
    return;
  }
  queue.enqueue(() => handleText(event));
}

const isUndo = (text) => /^\s*undo\W*$/i.test(text);

async function handleText(event) {
  const { mid, senderId } = event;
  if (!isUndo(event.text)) {
    console.log(`text mid=${mid} sender=${senderId} not a command, sending help`);
    await send(mid, senderId, replies.HELP).catch(() => {});
    return;
  }
  const target = await db.shareToUndo(senderId, event.replyToMid);
  console.log(`text mid=${mid} sender=${senderId} undo ${event.replyToMid ? "as a reply" : "without a reply"} -> ${target ? `share ${target.share.mid} item ${target.index ?? "all"}` : "nothing"}`);
  if (!target) {
    await send(mid, senderId, replies.undoReply(null, [])).catch(() => {});
    return;
  }
  const { share, index } = target;
  const events = share.event_ids || [];
  const removed = index === null ? events : events.filter((e) => e.index === index);
  try {
    await deleteEvents(removed.map((e) => e.id));
  } catch (err) {
    log(share.mid, `undo failed: ${err.message}`);
    await send(mid, senderId, "Sorry, I couldn't remove that just now. Try undo again in a few minutes.").catch(() => {});
    return;
  }
  const remaining = events.filter((e) => !removed.includes(e));
  await db.setStatus(share.mid, remaining.length ? "replied" : "undone", share.failure_reason, { event_ids: remaining });
  await send(mid, senderId, replies.undoReply(share, removed)).catch(() => {});
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
  if (reason) await fail(share, reason);
  else await db.setStatus(share.mid, "extracted", problems.join(",") || null, { extraction });
  return db.getShare(share.mid);
}

async function calendarStage(share) {
  const problems = share.failure_reason ? share.failure_reason.split(",") : [];
  const { events, reason } = await runCalendar(share);
  if (reason) await fail(share, reason);
  else await db.setStatus(share.mid, "calendared", problems.join(",") || null, { event_ids: events });
  return db.getShare(share.mid);
}

// Writes each item's calendar entry that is still valid. Returns { events } or { reason }.
async function runCalendar(share, deps = { writeEvents, today: todayIso() }) {
  const { mid } = share;
  const entries = share.extraction.items
    .map((item, index) => ({ item, index, entry: freshEntry(item, deps.today) }))
    .filter(({ entry }) => entry);
  const skipped = share.extraction.items.filter((item) => item.calendar).length - entries.length;
  if (skipped) log(mid, `calendar skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} no longer valid`);
  const start = Date.now();
  try {
    const events = await deps.writeEvents(share, entries);
    for (const e of events) log(mid, `calendar wrote ${e.kind} ${e.date} "${e.summary}" id=${e.id.slice(0, 12)}`);
    if (events.length === 0) log(mid, "nothing to put on the calendar");
    return { events };
  } catch (err) {
    log(mid, `calendar failed in ${seconds(start)}: ${err.message}`);
    return { reason: err.reason || "calendar_failed" };
  }
}

// "Today" in the westernmost US timezone, so a deadline later today still counts as upcoming.
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

// A posting search that failed or found nothing: the opportunity is still reported, linkless.
const NO_POSTING = {
  application_url: null, official_url: null, official_deadline_date: null, official_deadline_quote: null,
  deadline_time: null, deadline_timezone: null, cycle: null, posting_status: "unknown",
};
const FIND_CONCURRENCY = 3;

// Runs fn over items with at most `limit` in flight, keeping order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const addUsage = (a, b) => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  web_searches: a.web_searches + b.web_searches,
  requests: a.requests + b.requests,
});

// Reads the reel once for its opportunities, then searches for each one's posting in parallel,
// then runs the code checks. Returns { extraction } or { reason } for a failure. A failed
// search loses only that opportunity's link. `deps` is a parameter so tests (and the eval
// script) can replace the vendor and the checks.
async function runExtraction(share, deps = { identify, findPosting, verifyExtraction, today: todayIso() }) {
  const { mid, bundle } = share;
  const today = deps.today;
  // Years missing from a quote are read relative to when the reel was posted.
  const reference = bundle.uploadDate || share.received_at.toISOString().slice(0, 10);
  const start = Date.now();
  let found;
  try {
    found = await deps.identify(bundle, { today });
  } catch (err) {
    log(mid, `extraction failed in ${seconds(start)}: ${err.message}`);
    return { reason: err.reason || "extraction_failed" };
  }
  log(mid, `identified ${found.opportunities.length} opportunit${found.opportunities.length === 1 ? "y" : "ies"} in ${seconds(start)}`);

  let usage = found.usage;
  const pageTexts = {};
  const toolTexts = [];
  const searches = await mapLimit(found.opportunities, FIND_CONCURRENCY, async (opportunity, i) => {
    const begin = Date.now();
    try {
      const result = await deps.findPosting(opportunity, bundle, { today });
      usage = addUsage(usage, result.usage);
      Object.assign(pageTexts, result.pageTexts);
      toolTexts.push(result.toolText);
      log(mid, `item ${i} search took ${seconds(begin)}: ${result.usage.web_searches} search(es), in=${result.usage.input_tokens} out=${result.usage.output_tokens} tokens`);
      return result.posting;
    } catch (err) {
      log(mid, `item ${i} search failed in ${seconds(begin)}: ${err.message}`);
      return { ...NO_POSTING, search_failed: true };
    }
  });
  const result = {
    items: found.opportunities.map((opportunity, i) => ({ ...opportunity, ...searches[i] })),
    noneReason: found.noneReason,
    toolText: toolTexts.join("\n"),
    pageTexts,
    usage,
  };
  const { input_tokens, output_tokens, web_searches, requests } = usage;
  log(mid, `extraction ran in ${seconds(start)}: ${requests} request(s), ${web_searches} search(es), in=${input_tokens} out=${output_tokens} tokens`);

  const extraction = await deps.verifyExtraction(result, bundle, { today, reference });
  if (extraction.items.length === 0) log(mid, `no opportunity found: ${extraction.none_reason}`);
  for (const [i, item] of extraction.items.entries()) {
    const entry = item.calendar;
    const date = entry ? `${entry.kind} ${entry.date}${entry.time ? ` ${entry.time} ${entry.timezone}` : ""}` : "none";
    const link = item.link ? `${item.link.kind}/${item.link.source} ${item.link.url}` : "none";
    log(mid, `item ${i} ${item.company} / ${item.program}: date=${date} (${item.date_status}${item.note ? `: ${item.note}` : ""}) posting=${item.posting_status} link=${link}`);
    // The evidence behind the date, so every calendared date can be audited from the logs.
    const c = item.claimed;
    log(mid, `item ${i} evidence: official=${c.official_url} quote=${JSON.stringify(c.official_deadline_quote)} creator(${c.creator_deadline_source})=${JSON.stringify(c.creator_deadline_quote)}`);
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
    log(mid, `fetched ${share.reel_url} (${bundle.durationSec}s video) in ${seconds(start)} (${(size / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    problems.push(err.reason || "fetch_failed");
    log(mid, `fetch of ${share.reel_url} failed in ${seconds(start)}, continuing with caption only: ${err.message}`);
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

module.exports = { receiveReel, receiveText, requeueInProgress, buildBundle, runExtraction, runCalendar, isUndo };
