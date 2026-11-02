const test = require("node:test");
const assert = require("node:assert/strict");
const { decideDate, quoteIn, quoteStatesDate, quoteStatesTime, nextOccurrence, pickLink, htmlToText } = require("../src/verify");

// Jake's real reel bundle (trimmed), as saved by module 2.
const bundle = {
  caption: "let’s focus up guys\n#janestreet #quant #college #internship #software",
  transcript:
    "Hey, so if you're watching this before November 15 and you're a student interested in working for Jane Streets, then listen up. This runs from January 11 to 14, and this is for first-year undergrads.",
  ocr: [{ t: 2.7, text: "if ur watching before Nov 15 🍂\nBEFORE NOVEMBER 15\nJane Street" }],
  creator: "jakemok.io",
  uploadDate: "2026-10-23",
};
const today = "2026-11-01";
const reference = "2026-10-23";
const page = "Jane Street FOCUS 2027. Applications are due November 12, 2026 at 11:59 PM ET. The program runs January 11–14, 2027.";

function item(overrides = {}) {
  return {
    company: "Jane Street",
    program: "FOCUS",
    application_url: null,
    official_url: "https://www.janestreet.com/join-jane-street/programs-and-events/focus/",
    official_deadline_date: null,
    official_deadline_quote: null,
    deadline_time: null,
    deadline_timezone: null,
    creator_deadline_date: "2026-11-15",
    creator_deadline_quote: "if you're watching this before November 15",
    creator_deadline_source: "transcript",
    program_dates: "January 11-14, 2027",
    ...overrides,
  };
}
const decide = (it, officialText = page) => decideDate(it, { bundle, officialText, today, reference });

test("quotes match through case, whitespace and curly-quote differences, but not paraphrases", () => {
  assert.ok(quoteIn("IF YOU’RE watching   this before November 15", bundle.transcript));
  assert.ok(!quoteIn("apply before November 15", bundle.transcript));
  assert.ok(!quoteIn("", bundle.transcript));
});

test("quoteStatesDate requires an explicit month and day, and a matching year if one is given", () => {
  assert.deepEqual(quoteStatesDate("before November 15.", "2026-11-15"), { ok: true, hasYear: false });
  assert.deepEqual(quoteStatesDate("Apply by Nov. 15th, 2026", "2026-11-15"), { ok: true, hasYear: true });
  assert.deepEqual(quoteStatesDate("Deadline: 11/15/2026", "2026-11-15"), { ok: true, hasYear: true });
  assert.equal(quoteStatesDate("Applications due Sept 3", "2026-09-03").ok, true);
  assert.equal(quoteStatesDate("Apply by Nov 15, 2025", "2026-11-15").ok, false, "wrong year");
  assert.equal(quoteStatesDate("apply by this Friday", "2026-11-06").ok, false, "relative date");
  assert.equal(quoteStatesDate("Applications close November 1", "2026-11-15").ok, false, "different day");
  assert.equal(quoteStatesDate("Applications close November 150", "2026-11-15").ok, false);
});

test("quoteStatesTime accepts 12- and 24-hour forms of the claimed time only", () => {
  assert.ok(quoteStatesTime("due November 12 at 11:59 PM ET", "23:59"));
  assert.ok(quoteStatesTime("due 11:59 p.m. Eastern", "23:59"));
  assert.ok(quoteStatesTime("closes at 17:00", "17:00"));
  assert.ok(quoteStatesTime("closes at 5pm", "17:00"));
  assert.ok(!quoteStatesTime("due 11:59 AM", "23:59"));
  assert.ok(!quoteStatesTime("due November 12", "23:59"));
});

test("nextOccurrence rolls a yearless date into the following year once it has passed", () => {
  assert.equal(nextOccurrence("2026-11-15", "2026-10-23"), "2026-11-15");
  assert.equal(nextOccurrence("2026-01-11", "2026-10-23"), "2027-01-11");
});

test("the official page date wins over the creator's, with the mismatch noted", () => {
  const d = decide(item({
    official_deadline_date: "2026-11-12",
    official_deadline_quote: "Applications are due November 12, 2026 at 11:59 PM ET",
    deadline_time: "23:59",
    deadline_timezone: "America/New_York",
  }));
  assert.equal(d.status, "verified_official");
  assert.deepEqual(d.deadline, { date: "2026-11-12", time: "23:59", timezone: "America/New_York" });
  assert.match(d.note, /creator said 2026-11-15, official page says 2026-11-12/);
});

test("without an official date the creator's verified date is used", () => {
  const d = decide(item());
  assert.equal(d.status, "verified_creator");
  assert.equal(d.source, "transcript");
  assert.deepEqual(d.deadline, { date: "2026-11-15", time: null, timezone: null });
});

test("an official quote that isn't on the page is ignored", () => {
  const d = decide(item({ official_deadline_date: "2026-11-20", official_deadline_quote: "Applications are due November 20, 2026" }));
  assert.equal(d.status, "verified_creator");
});

test("a fabricated creator quote with no official date calendars nothing", () => {
  const d = decide(item({ creator_deadline_quote: "apply before November 15" }));
  assert.equal(d.status, "unconfirmed");
  assert.equal(d.deadline, null);
});

test("a yearless official date that disagrees with the creator is a conflict", () => {
  const d = decide(
    item({ official_deadline_date: "2026-11-12", official_deadline_quote: "Applications due November 12" }),
    "Applications due November 12"
  );
  assert.equal(d.status, "conflict");
  assert.equal(d.deadline, null);
});

test("an official date already past while the creator's is ahead is a conflict, not a calendared date", () => {
  const d = decide(
    item({ official_deadline_date: "2026-10-30", official_deadline_quote: "Applications closed October 30, 2026" }),
    "Applications closed October 30, 2026"
  );
  assert.equal(d.status, "conflict");
  assert.equal(d.deadline, null);
});

test("a deadline that has passed is reported, never calendared", () => {
  const d = decideDate(item(), { bundle, officialText: "", today: "2026-11-20", reference });
  assert.equal(d.status, "passed");
  assert.equal(d.deadline, null);
});

test("a time is only kept when the official quote states it", () => {
  const d = decide(item({
    official_deadline_date: "2026-11-12",
    official_deadline_quote: "Applications are due November 12, 2026",
    deadline_time: "17:00",
    deadline_timezone: "America/New_York",
  }));
  assert.deepEqual(d.deadline, { date: "2026-11-12", time: null, timezone: null });
});

test("no dates at all is status none", () => {
  assert.equal(decide(item({ creator_deadline_date: null, creator_deadline_quote: null, creator_deadline_source: null })).status, "none");
});

test("htmlToText drops scripts and tags", () => {
  assert.equal(htmlToText("<p>Due <b>Nov&nbsp;12</b></p><script>x()</script>").replace(/\s+/g, " ").trim(), "Due Nov 12");
});

test.describe("pickLink", () => {
  const realFetch = global.fetch;
  test.afterEach(() => (global.fetch = realFetch));
  const statusFor = (map) => (global.fetch = async (url) => new Response("", { status: map[url] ?? 200 }));

  const official = "https://www.janestreet.com/join-jane-street/programs-and-events/focus/";
  const toolText = JSON.stringify([{ type: "web_search_tool_result", content: [{ url: official }] }]);

  test("keeps a URL the agent found in search results when the page exists", async () => {
    statusFor({});
    assert.deepEqual(await pickLink(item({ application_url: official }), bundle, toolText), { url: official, source: "web", http: 200 });
  });

  test("drops a URL the agent never saw, even if it resolves", async () => {
    statusFor({});
    assert.equal(await pickLink(item({ application_url: "https://made-up.example/apply", official_url: null }), bundle, toolText), null);
  });

  test("drops a dead page and falls back to the next candidate", async () => {
    const apply = "https://janestreet.example/apply";
    statusFor({ [apply]: 404 });
    const link = await pickLink(item({ application_url: apply }), bundle, JSON.stringify([apply, official]));
    assert.equal(link.url, official);
  });

  test("a bot-blocked page still counts as existing", async () => {
    statusFor({ [official]: 403 });
    assert.equal((await pickLink(item({ application_url: official }), bundle, toolText)).http, 403);
  });

  test("a URL written in the caption is named as coming from the caption", async () => {
    statusFor({});
    const withUrl = { ...bundle, caption: "apply here: https://jobs.example.com/focus." };
    const link = await pickLink(item({ official_url: null }), withUrl, "[]");
    assert.deepEqual(link, { url: "https://jobs.example.com/focus", source: "caption", http: 200 });
  });
});

test.describe("calendarEntry", () => {
  const { calendarEntry } = require("../src/verify");
  const link = { url: "https://careers.microsoft.com/pm-intern", source: "web", http: 200 };

  test("a verified deadline is calendared as a deadline", () => {
    const date = { status: "verified_official", deadline: { date: "2026-11-12", time: "23:59", timezone: "America/New_York" } };
    assert.deepEqual(calendarEntry(date, link, today), { kind: "deadline", date: "2026-11-12", time: "23:59", timezone: "America/New_York" });
  });

  test("a link with no deadline anywhere becomes a reminder three days out", () => {
    assert.deepEqual(calendarEntry({ status: "none", deadline: null }, link, today), { kind: "reminder", date: "2026-11-04", time: null, timezone: null });
  });

  test("no link, or a date that exists but can't be trusted, gives no entry", () => {
    assert.equal(calendarEntry({ status: "none", deadline: null }, null, today), null);
    for (const status of ["unconfirmed", "conflict", "passed"]) {
      assert.equal(calendarEntry({ status, deadline: null }, link, today), null, status);
    }
  });

  test("reminders roll over month ends", () => {
    assert.equal(calendarEntry({ status: "none", deadline: null }, link, "2026-12-30").date, "2027-01-02");
  });
});
