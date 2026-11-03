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

const { runExtraction } = require("../src/pipeline");
const { ExtractionError } = require("../src/extract");

test.describe("runExtraction", () => {
  const fetchedShare = { mid: "m2", bundle: { caption: "cap", uploadDate: "2026-10-23" }, received_at: new Date("2026-10-30T12:00:00Z") };
  const usage = (n) => ({ input_tokens: n, output_tokens: n, web_searches: n, requests: 1 });
  const opp = (company) => ({ company, program: "Intern", reel_cycle: null, creator_deadline_date: null, creator_deadline_quote: null, creator_deadline_source: null, program_dates: null });
  const passThrough = async (result, bundle, ctx) => ({ items: result.items.map((i) => ({ ...i, claimed: i })), none_reason: result.noneReason, usage: result.usage, ctx, evidence: result });

  test("searches each opportunity separately, at most three at once, and merges the results in order", async () => {
    let active = 0;
    let peak = 0;
    const { extraction } = await runExtraction(fetchedShare, {
      today: "2026-11-01",
      identify: async () => ({ opportunities: ["A", "B", "C", "D", "E"].map(opp), noneReason: null, usage: usage(1) }),
      findPosting: async (o) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (o.company === "C") throw new ExtractionError("extraction_failed", "529");
        return { posting: { application_url: `https://${o.company.toLowerCase()}.com/x`, posting_status: "open" }, toolText: `[${o.company}]`, pageTexts: { [o.company]: "page" }, usage: usage(10) };
      },
      verifyExtraction: passThrough,
    });
    assert.equal(peak, 3);
    assert.deepEqual(extraction.items.map((i) => i.company), ["A", "B", "C", "D", "E"]);
    assert.equal(extraction.items[0].application_url, "https://a.com/x");
    assert.equal(extraction.items[2].application_url, null, "a failed search keeps the opportunity without a link");
    assert.equal(extraction.items[2].search_failed, true);
    assert.deepEqual(extraction.usage, { input_tokens: 41, output_tokens: 41, web_searches: 41, requests: 5 });
    assert.deepEqual(Object.keys(extraction.evidence.pageTexts).sort(), ["A", "B", "D", "E"]);
    assert.deepEqual(extraction.ctx, { today: "2026-11-01", reference: "2026-10-23" });
  });

  test("falls back to the received date when the post date is unknown", async () => {
    const { extraction } = await runExtraction({ ...fetchedShare, bundle: { caption: "cap", uploadDate: null } }, {
      today: "2026-11-01",
      identify: async () => ({ opportunities: [], noneReason: "nothing", usage: usage(1) }),
      findPosting: async () => assert.fail("no opportunities, no searches"),
      verifyExtraction: passThrough,
    });
    assert.equal(extraction.ctx.reference, "2026-10-30");
    assert.equal(extraction.none_reason, "nothing");
  });

  test("a failure to read the reel becomes its reason, without searching or checking", async () => {
    const result = await runExtraction(fetchedShare, {
      today: "2026-11-01",
      identify: async () => { throw new ExtractionError("extraction_invalid", "not JSON"); },
      findPosting: async () => assert.fail("should not search"),
      verifyExtraction: async () => assert.fail("should not check"),
    });
    assert.deepEqual(result, { reason: "extraction_invalid" });
  });
});

const { runCalendar } = require("../src/pipeline");
const { CalendarError } = require("../src/calendar");

test.describe("runCalendar", () => {
  const item = (calendar, extra = {}) => ({ company: "Jane Street", program: "FOCUS", cycle: null, calendar, ...extra });
  const share = {
    mid: "m3",
    extraction: {
      items: [
        item({ kind: "deadline", date: "2026-11-15", time: null, timezone: null }),
        item({ kind: "reminder", date: "2026-11-04", time: null, timezone: null }, { program: "Finance (Summer 2026)" }),
        item(null),
      ],
    },
  };

  test("writes only entries that are still valid and returns the events", async () => {
    let passed;
    const { events } = await runCalendar(share, {
      today: "2026-11-01",
      writeEvents: async (s, entries) => ((passed = entries), entries.map((e) => ({ id: "abcdef1234567", kind: e.entry.kind, date: e.entry.date, summary: "s" }))),
    });
    assert.equal(passed.length, 1, "the Summer 2026 reminder and the item without an entry are skipped");
    assert.equal(events[0].date, "2026-11-15");
  });

  test("a calendar error becomes its reason", async () => {
    const result = await runCalendar(share, {
      today: "2026-11-01",
      writeEvents: async () => { throw new CalendarError("google_reauth_needed", "revoked"); },
    });
    assert.deepEqual(result, { reason: "google_reauth_needed" });
  });
});

test("isUndo accepts undo however it's typed, and nothing else", () => {
  const { isUndo } = require("../src/pipeline");
  for (const t of ["undo", "Undo", " UNDO! ", "undo."]) assert.ok(isUndo(t), t);
  for (const t of ["undo the last two", "please undo", "hi", ""]) assert.ok(!isUndo(t), t);
});
