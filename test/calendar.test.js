const test = require("node:test");
const assert = require("node:assert/strict");
const { writeEvents, deleteEvents, eventBody, eventId, resetCache } = require("../src/calendar");

const share = { mid: "m1", sender_id: "2014204712601413", reel_url: "https://www.instagram.com/reel/De2uJ0aP1zu/" };
const link = { url: "https://www.janestreet.com/apply-focus-nyc/", source: "web", http: 200 };
const focus = { company: "Jane Street", program: "FOCUS", program_dates: "January 11-14, 2027", note: null, date_source: "transcript", link };
const deadline = { kind: "deadline", date: "2026-11-15", time: null, timezone: null };
const reminder = { kind: "reminder", date: "2026-11-04", time: null, timezone: null };

const realFetch = global.fetch;
let calls;

// A fake Google: token endpoint, events.list (timezone) and events insert/update.
function fakeGoogle({ token = { access_token: "at", expires_in: 3600 }, tokenStatus = 200, insert = () => ({ status: 200, body: { htmlLink: "https://calendar.google.com/e" } }) } = {}) {
  calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body };
    calls.push(call);
    if (call.url.startsWith("https://oauth2.googleapis.com/token")) return Response.json(token, { status: tokenStatus });
    if (call.url.endsWith("/events?maxResults=1")) return Response.json({ timeZone: "America/Los_Angeles", items: [] });
    const { status, body } = insert(call);
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
}

test.beforeEach(() => {
  resetCache();
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", GOOGLE_REFRESH_TOKEN: "rt" });
});
test.afterEach(() => {
  global.fetch = realFetch;
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) delete process.env[k];
});

test("a deadline without a time is a 30-minute block ending 11:59 PM in the calendar's timezone", async () => {
  fakeGoogle();
  const [event] = await writeEvents(share, [{ item: focus, entry: deadline, index: 0 }]);
  const insert = calls.find((c) => c.method === "POST" && c.url.endsWith("/events"));
  const body = JSON.parse(insert.body);
  assert.equal(body.summary, "Deadline: Jane Street FOCUS");
  assert.deepEqual(body.start, { dateTime: "2026-11-15T23:29:00", timeZone: "America/Los_Angeles" });
  assert.deepEqual(body.end, { dateTime: "2026-11-15T23:59:00", timeZone: "America/Los_Angeles" });
  assert.match(body.description, /Apply: https:\/\/www\.janestreet\.com\/apply-focus-nyc\//);
  assert.match(body.description, /as said in the reel; not confirmed on an official page/);
  assert.match(body.description, /Program dates: January 11-14, 2027/);
  assert.equal(body.id, eventId(share, "Jane Street", 1));
  assert.deepEqual(event, { id: body.id, index: 0, kind: "deadline", date: "2026-11-15", summary: body.summary, link: "https://calendar.google.com/e" });
  assert.match(calls[0].body.toString(), /grant_type=refresh_token/);
});

test("a stated time keeps its own timezone and skips the timezone lookup", async () => {
  fakeGoogle();
  const entry = { kind: "deadline", date: "2026-11-12", time: "00:15", timezone: "America/New_York" };
  await writeEvents(share, [{ item: { ...focus, date_source: "official" }, entry }]);
  assert.ok(!calls.some((c) => c.url.endsWith("maxResults=1")));
  const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/events")).body);
  assert.deepEqual(body.start, { dateTime: "2026-11-11T23:45:00", timeZone: "America/New_York" }, "wraps to the previous day");
  assert.match(body.description, /from the official application page/);
});

test("a posting found for an old reel says so in the event", () => {
  const body = eventBody(reminder, { ...focus, updated_from: "Summer 2026" }, share, null);
  assert.match(body.description, /The reel was about Summer 2026, which has ended; this is the current posting\./);
});

test("a reminder is an all-day 'Apply soon' event", () => {
  const body = eventBody(reminder, { ...focus, company: "Microsoft", program: "PM Intern", program_dates: null }, share, null);
  assert.equal(body.summary, "Apply soon: Microsoft PM Intern");
  assert.deepEqual(body.start, { date: "2026-11-04" });
  assert.deepEqual(body.end, { date: "2026-11-05" });
  assert.match(body.description, /No official deadline was found/);
});

test("an existing event id is updated instead of duplicated", async () => {
  fakeGoogle({ insert: (call) => (call.method === "POST" ? { status: 409, body: {} } : { status: 200, body: { htmlLink: "x" } }) });
  const [event] = await writeEvents(share, [{ item: focus, entry: deadline }]);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put.url.endsWith(`/events/${event.id}`));
  assert.equal(JSON.parse(put.body).status, "confirmed");
});

test("event ids are stable per student, reel and company, and differ otherwise", () => {
  assert.equal(eventId(share, "Jane Street", 1), eventId({ ...share, mid: "another-share" }, " jane street ", 1));
  assert.notEqual(eventId(share, "Jane Street", 1), eventId({ ...share, sender_id: "other" }, "Jane Street", 1));
  assert.notEqual(eventId(share, "Jane Street", 1), eventId(share, "Jane Street", 2));
  assert.match(eventId(share, "Jane Street", 1), /^[0-9a-f]{64}$/);
});

test("two items from the same company get separate events", async () => {
  fakeGoogle();
  const events = await writeEvents(share, [{ item: focus, entry: deadline }, { item: { ...focus, program: "Strategy Intern" }, entry: reminder }]);
  assert.notEqual(events[0].id, events[1].id);
});

test("a revoked token is google_reauth_needed", async () => {
  fakeGoogle({ token: { error: "invalid_grant" }, tokenStatus: 400 });
  await assert.rejects(writeEvents(share, [{ item: focus, entry: deadline }]), { reason: "google_reauth_needed" });
});

test("a failed write or missing configuration is calendar_failed", async () => {
  fakeGoogle({ insert: () => ({ status: 500, body: { error: { message: "backend error" } } }) });
  await assert.rejects(writeEvents(share, [{ item: focus, entry: reminder }]), { reason: "calendar_failed", message: /500 backend error/ });

  resetCache();
  delete process.env.GOOGLE_REFRESH_TOKEN;
  await assert.rejects(writeEvents(share, [{ item: focus, entry: reminder }]), { reason: "calendar_failed", message: /not set/ });
});

test("no entries means no Google calls", async () => {
  fakeGoogle();
  assert.deepEqual(await writeEvents(share, []), []);
  assert.equal(calls.length, 0);
});

test("deleteEvents treats already-deleted events as removed and fails on other errors", async () => {
  fakeGoogle({ insert: (call) => ({ status: call.url.endsWith("/gone") ? 410 : call.url.endsWith("/bad") ? 500 : 204, body: {} }) });
  await deleteEvents(["a", "gone"]);
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop()), ["a", "gone"]);
  await assert.rejects(deleteEvents(["bad"]), { reason: "calendar_failed" });
});
