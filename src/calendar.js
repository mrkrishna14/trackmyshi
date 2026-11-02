// writeEvents(share, entries) -> [{ id, kind, date, summary, link }]. The only place that knows
// about Google. Until module 6 every share goes to the owner's calendar, set up once with
// scripts/google-auth.js and passed in as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.
// Throws CalendarError: google_reauth_needed when the token is revoked, calendar_failed otherwise.
const crypto = require("crypto");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";

class CalendarError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

let cachedToken = null;
let cachedTimeZone = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new CalendarError("calendar_failed", "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REFRESH_TOKEN is not set");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error === "invalid_grant") throw new CalendarError("google_reauth_needed", "Google refresh token was revoked or expired");
  if (!res.ok || !body.access_token) throw new CalendarError("calendar_failed", `token refresh returned ${res.status} ${body.error || ""}`);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

async function google(method, path, body) {
  const res = await fetch(`${CALENDAR}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// The calendar's own timezone, from events.list, so no scope beyond calendar.events is needed.
async function calendarTimeZone() {
  if (cachedTimeZone) return cachedTimeZone;
  const { status, body } = await google("GET", "/events?maxResults=1");
  if (status !== 200 || !body.timeZone) throw new CalendarError("calendar_failed", `events.list returned ${status}`);
  return (cachedTimeZone = body.timeZone);
}

// Stable across retries and re-shares: the same student sharing the same reel gets the same
// event instead of a duplicate. Hex digits are valid in Google's base32hex event-id alphabet.
function eventId(share, company, occurrence) {
  return crypto.createHash("sha256").update(`${share.sender_id}|${share.reel_url}|${company.trim().toLowerCase()}|${occurrence}`).digest("hex");
}

// "2026-11-15", "23:59", -30 -> "2026-11-15T23:29:00" (wall-clock time; the timezone travels separately).
function shiftWallClock(date, time, minutes) {
  const d = new Date(Date.parse(`${date}T${time}:00Z`) + minutes * 60_000);
  return d.toISOString().slice(0, 19);
}

function nextDay(date) {
  return shiftWallClock(date, "00:00", 24 * 60).slice(0, 10);
}

const SOURCE_LABELS = {
  official: "from the official application page",
  caption: "as stated in the reel's caption; not confirmed on an official page",
  transcript: "as said in the reel; not confirmed on an official page",
  ocr: "as shown on screen in the reel; not confirmed on an official page",
};

function eventBody(entry, item, share, calendarTz) {
  const name = `${item.company} ${item.program}`.trim();
  const lines = [];
  if (entry.kind === "deadline") lines.push(`Application deadline, ${SOURCE_LABELS[item.date_source] || "verified"}.`);
  else lines.push("No official deadline was found. Postings like this can close without warning, so apply soon.");
  lines.push(item.link ? `Apply: ${item.link.url}` : "No application link was found.");
  if (item.note) lines.push(`Note: ${item.note}.`);
  if (item.program_dates) lines.push(`Program dates: ${item.program_dates}`);
  lines.push(`From this reel: ${share.reel_url}`, "Added by Due.");

  const body = { summary: entry.kind === "deadline" ? `Deadline: ${name}` : `Apply soon: ${name}`, description: lines.join("\n\n") };
  if (entry.kind === "reminder") {
    return { ...body, start: { date: entry.date }, end: { date: nextDay(entry.date) } };
  }
  // A 30-minute block ending at the deadline: the stated time, or 11:59 PM in the calendar's timezone.
  const time = entry.time || "23:59";
  const timeZone = entry.time ? entry.timezone : calendarTz;
  return {
    ...body,
    start: { dateTime: shiftWallClock(entry.date, time, -30), timeZone },
    end: { dateTime: shiftWallClock(entry.date, time, 0), timeZone },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 120 }] },
  };
}

// 409 means the id exists: a retry, a re-share, or an event the student deleted. Updating it
// restores it either way, so writing an entry is idempotent.
async function upsert(id, body) {
  let res = await google("POST", "/events", { id, ...body });
  if (res.status === 409) res = await google("PUT", `/events/${id}`, { ...body, status: "confirmed" });
  if (res.status !== 200) throw new CalendarError("calendar_failed", `calendar write returned ${res.status} ${res.body.error?.message || ""}`);
  return res.body;
}

async function writeEvents(share, entries) {
  if (entries.length === 0) return [];
  const calendarTz = entries.some((e) => e.entry.kind === "deadline" && !e.entry.time) ? await calendarTimeZone() : null;
  const seen = {};
  const written = [];
  for (const { item, entry } of entries) {
    const key = item.company.trim().toLowerCase();
    seen[key] = (seen[key] || 0) + 1;
    const id = eventId(share, item.company, seen[key]);
    const body = eventBody(entry, item, share, calendarTz);
    const event = await upsert(id, body);
    written.push({ id, kind: entry.kind, date: entry.date, summary: body.summary, link: event.htmlLink || null });
  }
  return written;
}

// For tests: forget the cached token and timezone.
function resetCache() {
  cachedToken = null;
  cachedTimeZone = null;
}

module.exports = { writeEvents, eventBody, eventId, CalendarError, resetCache };
