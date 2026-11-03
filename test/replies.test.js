const test = require("node:test");
const assert = require("node:assert/strict");
const { shareReply, failureReply, undoReply, formatDate, formatTime } = require("../src/replies");

const link = { url: "https://www.janestreet.com/join-jane-street/programs-and-events/focus/", source: "web", http: 200 };
const focus = {
  company: "Jane Street",
  program: "FOCUS",
  date_status: "verified_creator",
  date_source: "transcript",
  link,
  note: null,
  updated_from: null,
  calendar: { kind: "deadline", date: "2026-11-15", time: null, timezone: null },
};
const share = (items, events = [], failure_reason = null) => ({ extraction: { items }, event_ids: events, failure_reason });
const deadlineEvent = { id: "a", index: 0, kind: "deadline", date: "2026-11-15", summary: "Deadline: Jane Street FOCUS" };

test("formats dates and times the way a student reads them", () => {
  assert.equal(formatDate("2026-11-15"), "Sun, Nov 15");
  assert.equal(formatTime("23:59", "America/New_York", "2026-11-12"), "11:59 PM EST");
  assert.equal(formatTime("09:00", "America/Los_Angeles", "2026-07-01"), "9:00 AM PDT");
});

test("a calendared deadline from the reel says where the date came from and offers undo", () => {
  const text = shareReply(share([focus], [deadlineEvent]));
  assert.equal(
    text,
    "✅ Jane Street FOCUS: deadline Sun, Nov 15 (end of day). Added to your calendar. The date is from the reel; I couldn't confirm it on an official page.\n" +
      "Apply: https://www.janestreet.com/join-jane-street/programs-and-events/focus/\n\nReply undo to remove what I added."
  );
});

test("an official deadline with a time shows the time and no caveat", () => {
  const item = { ...focus, date_source: "official", calendar: { kind: "deadline", date: "2026-11-12", time: "23:59", timezone: "America/New_York" } };
  const text = shareReply(share([item], [{ ...deadlineEvent, date: "2026-11-12" }]));
  assert.match(text, /deadline Thu, Nov 12 at 11:59 PM EST\. Added to your calendar\.\n/);
  assert.doesNotMatch(text, /couldn't confirm/);
});

test("a reminder for an old reel says this is this year's posting", () => {
  const item = { ...focus, company: "BlackRock", program: "Summer Internship", date_status: "none", updated_from: "Summer 2026", calendar: { kind: "reminder", date: "2026-11-04" } };
  const text = shareReply(share([item], [{ id: "b", index: 0, kind: "reminder", date: "2026-11-04", summary: "Apply soon: BlackRock Summer Internship" }]));
  assert.match(text, /^🔔 BlackRock Summer Internship: no official deadline.*reminder for Wed, Nov 4\. This reel was about Summer 2026, which has ended, so this is this year's posting\./);
});

test("each uncalendared case is explained honestly", () => {
  const cases = [
    [{ date_status: "conflict" }, /give different deadlines, so I didn't add it/],
    [{ date_status: "passed" }, /deadline has already passed/],
    [{ date_status: "unconfirmed" }, /couldn't confirm the deadline, so I didn't add it/],
    [{ date_status: "none", note: "posting is for Summer 2026, which has ended", link: null }, /from a past season/],
    [{ date_status: "none" }, /no deadline listed, and I couldn't confirm the posting is still open/],
    [{ date_status: "none", link: null }, /couldn't find the application page or a deadline/],
  ];
  for (const [overrides, expected] of cases) {
    const text = shareReply(share([{ ...focus, calendar: null, ...overrides }]));
    assert.match(text, expected);
    assert.doesNotMatch(text, /undo/, "nothing to undo when nothing was added");
  }
});

test("no opportunity, and a video that couldn't be opened, are said plainly", () => {
  assert.equal(shareReply(share([])), "I didn't find an internship, job or program with a deadline in this reel.");
  assert.match(shareReply(share([], [], "reel_private_or_deleted")), /^I couldn't open the video, so I only read the caption\.\n\n/);
  assert.match(shareReply(share([focus], [deadlineEvent], "ocr_failed")), /^I couldn't read all of the video/);
});

test("long lists stay under 1000 characters with a count of what's left out", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ ...focus, company: `Company ${i}`, program: "Very Long Internship Program Name ".repeat(3) }));
  const events = items.map((_, i) => ({ ...deadlineEvent, index: i }));
  const text = shareReply(share(items, events));
  assert.ok(text.length <= 1000);
  assert.match(text, /…and \d+ more\./);
  assert.match(text, /Reply undo to remove what I added\.$/);
});

test("failure and undo replies", () => {
  assert.match(failureReply("extraction_failed"), /something went wrong/);
  assert.match(failureReply("google_reauth_needed"), /Google Calendar/);
  assert.equal(undoReply(null, []), "There's nothing to undo.");
  assert.equal(undoReply({ status: "undone" }, []), "I already removed that one.");
  assert.equal(
    undoReply({ status: "replied" }, [deadlineEvent, { summary: "Apply soon: BlackRock Summer Internship" }]),
    "Removed from your calendar: Jane Street FOCUS, BlackRock Summer Internship."
  );
});

test("events saved without an item index are matched by kind, date and company", () => {
  const { index, ...legacy } = deadlineEvent;
  assert.match(shareReply(share([focus], [legacy])), /^✅ Jane Street FOCUS: deadline Sun, Nov 15/);
  assert.doesNotMatch(shareReply(share([{ ...focus, company: "Citadel" }], [legacy])), /✅/);
});
