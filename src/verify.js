// Deterministic checks on the agent's answer. A date is calendared only when a quote that really
// appears in its source states it explicitly, and it is in the future. A link is kept only when
// it came from a search/fetch result or the reel itself and the page still exists.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function normalize(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteIn(quote, text) {
  const q = normalize(quote);
  return q.length >= 4 && normalize(text).includes(q);
}

// Does the quote state this exact date (month and day, and the year if it names one)?
// Relative wording like "this Friday" or "in two weeks" never passes.
function quoteStatesDate(quote, iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const q = normalize(quote);
  const full = MONTHS[m - 1];
  const abbr = full.slice(0, 3);
  const monthName = new RegExp(`\\b(${full}|${abbr}${abbr === "sep" ? "t?" : ""})\\.?(?![a-z])`).test(q);
  // The day may end a sentence ("November 15.") but must not be part of another number.
  const day = new RegExp(`(?<!\\d)(?<!\\d[/.-])0?${d}(st|nd|rd|th)?(?!\\d)(?![/.-]\\d)`).test(q);
  const numeric = new RegExp(`(?<!\\d)0?${m}[/.-]0?${d}(?!\\d)`).test(q) || (d > 12 && new RegExp(`(?<!\\d)0?${d}[/.-]0?${m}(?!\\d)`).test(q));
  if (!((monthName && day) || numeric)) return { ok: false };
  const years = q.match(/(?<!\d)20\d{2}(?!\d)/g);
  if (years && !years.includes(String(y))) return { ok: false };
  return { ok: true, hasYear: Boolean(years) };
}

// Next occurrence of the date's month and day on or after `reference` (YYYY-MM-DD).
function nextOccurrence(iso, reference) {
  const monthDay = iso.slice(5);
  const year = Number(reference.slice(0, 4));
  const candidate = `${year}-${monthDay}`;
  return candidate >= reference ? candidate : `${year + 1}-${monthDay}`;
}

const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// One claimed date + quote + source text -> { date, hasYear } when every check passes, else null.
function checkClaim(date, quote, sourceText, reference) {
  if (!isIsoDate(date) || !quote || !quoteIn(quote, sourceText)) return null;
  const stated = quoteStatesDate(quote, date);
  if (!stated.ok) return null;
  if (!stated.hasYear && date !== nextOccurrence(date, reference)) return null;
  return { date, hasYear: stated.hasYear };
}

function bundleSource(bundle, source) {
  if (source === "ocr") return (bundle.ocr || []).map((f) => f.text).join("\n");
  return source === "caption" || source === "transcript" ? bundle[source] || "" : "";
}

// "23:59" is stated by "11:59 pm", "11:59PM", "11:59 p.m." or "23:59"; "17:00" also by "5pm".
function quoteStatesTime(quote, time) {
  if (!/^\d{2}:\d{2}$/.test(time || "")) return false;
  const [h, min] = time.split(":").map(Number);
  const q = normalize(quote).replace(/\./g, "");
  const mm = String(min).padStart(2, "0");
  const h12 = h % 12 || 12;
  const meridiem = h < 12 ? "am" : "pm";
  const twelveHour = new RegExp(`(?<!\\d)0?${h12}:${mm}\\s?${meridiem}`).test(q)
    || (min === 0 && new RegExp(`(?<![\\d:])0?${h12}\\s?${meridiem}`).test(q));
  // Bare 24-hour times are only unambiguous from 13:00 on.
  const twentyFourHour = h >= 13 && new RegExp(`(?<!\\d)${h}:${mm}(?!\\d)`).test(q);
  return twelveHour || twentyFourHour;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return Boolean(tz);
  } catch {
    return false;
  }
}

// The official page wins, as long as it can be trusted to be the current cycle: a page date
// without a year that disagrees with the creator, or an official date already past while the
// creator's is still ahead, is a conflict and nothing is calendared.
function decideDate(item, { bundle, officialText, today, reference }) {
  const official = checkClaim(item.official_deadline_date, item.official_deadline_quote, officialText, reference);
  const creator = checkClaim(item.creator_deadline_date, item.creator_deadline_quote, bundleSource(bundle, item.creator_deadline_source), reference);
  const differ = official && creator && official.date !== creator.date;

  let status, date = null, source = null, note = null;
  if (official && official.date >= today && !(differ && !official.hasYear)) {
    [status, date, source] = ["verified_official", official.date, "official"];
    if (differ) note = `creator said ${creator.date}, official page says ${official.date}`;
  } else if (differ) {
    status = "conflict";
    note = `creator said ${creator.date}, official page says ${official.date}`;
  } else if (creator && creator.date >= today) {
    [status, date, source] = ["verified_creator", creator.date, item.creator_deadline_source];
  } else if (official || creator) {
    status = "passed";
    note = `deadline ${(official || creator).date} has passed`;
  } else {
    status = item.official_deadline_date || item.creator_deadline_date ? "unconfirmed" : "none";
  }

  let time = null, timezone = null;
  if (source === "official" && quoteStatesTime(item.official_deadline_quote, item.deadline_time) && validTimezone(item.deadline_timezone)) {
    [time, timezone] = [item.deadline_time, item.deadline_timezone];
  }
  return { status, deadline: date && { date, time, timezone }, source, note };
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const urlsIn = (text) => (String(text || "").match(URL_PATTERN) || []).map((u) => u.replace(/[.,;:!?]+$/, ""));

// Where the URL appears, which is what the logs name as its source; null if it appears nowhere.
function urlSource(url, bundle, toolText) {
  for (const source of ["caption", "ocr", "transcript"]) {
    if (urlsIn(bundleSource(bundle, source)).includes(url)) return source;
  }
  return toolText.includes(url) || toolText.includes(JSON.stringify(url).slice(1, -1)) ? "web" : null;
}

// Many job sites refuse bots (403/429), so those count as "exists". 404/410 or no answer don't.
async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DueBot/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    return { ok: res.status < 400 || [401, 403, 429, 999].includes(res.status), status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function pickLink(item, bundle, toolText) {
  const candidates = [item.application_url, item.official_url, ...urlsIn(bundle.caption), ...urlsIn(bundleSource(bundle, "ocr"))];
  const tried = new Set();
  for (const url of candidates) {
    if (!url || tried.has(url) || !/^https?:\/\//.test(url)) continue;
    tried.add(url);
    const source = urlSource(url, bundle, toolText);
    if (!source) continue;
    const check = await checkUrl(url);
    if (check.ok) return { url, source, http: check.status };
  }
  return null;
}

// Page text for quote checks: what the agent fetched, or else a plain fetch of the page.
async function officialPageText(url, pageTexts) {
  if (!url) return "";
  if (pageTexts[url]) return pageTexts[url];
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; DueBot/1.0)" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return "";
    return htmlToText(await res.text());
  } catch {
    return "";
  }
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

// Opportunities with an application link but no deadline anywhere (postings that close when
// filled) get an "apply soon" reminder this many days after the share instead of a deadline.
const REMINDER_DAYS = 3;

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Last day of the season a posting is for: "Summer 2026" -> 2026-08-31, a bare "2026" -> 2026-12-31.
// Winter programs run into the next spring.
const SEASON_END = { spring: "05-31", summer: "08-31", fall: "12-31", autumn: "12-31" };

function cycleEnd(text) {
  const match = String(text || "").toLowerCase().match(/\b(?:(spring|summer|fall|autumn|winter)\s*)?(20\d{2})\b/);
  if (!match) return null;
  const [, season, year] = match;
  return season === "winter" ? `${year}-03-31` : `${year}-${SEASON_END[season] || "12-31"}`;
}

// What module 4 writes to the calendar: the verified deadline, a reminder, or nothing. Only
// status "none" gets a reminder: an unconfirmed, conflicting or passed date means a date
// exists, and a reminder could land after it. A posting for a season that has already ended
// (an old reel) gets no reminder either.
function calendarEntry(date, link, today, cycle) {
  if (date.deadline) return { kind: "deadline", ...date.deadline };
  const end = cycleEnd(cycle);
  if (end && end < today) return null;
  if (date.status === "none" && link) return { kind: "reminder", date: addDays(today, REMINDER_DAYS), time: null, timezone: null };
  return null;
}

// Re-checked when the calendar is written, which can be later than extraction (a share
// re-queued after a restart): a deadline that has since passed, or a reminder for a season
// that has ended, is not written.
function freshEntry(item, today) {
  const entry = item.calendar;
  if (!entry) return null;
  if (entry.kind === "deadline") return entry.date >= today ? entry : null;
  const end = cycleEnd(item.cycle || item.program);
  return end && end < today ? null : entry;
}

async function verifyExtraction(result, bundle, { today, reference }) {
  const items = [];
  for (const raw of result.items) {
    const officialText = await officialPageText(raw.official_url, result.pageTexts);
    const date = decideDate(raw, { bundle, officialText, today, reference });
    const link = await pickLink(raw, bundle, result.toolText);
    const end = cycleEnd(raw.cycle || raw.program);
    if (!date.deadline && end && end < today) date.note = `posting is for ${raw.cycle || raw.program}, which has ended`;
    items.push({
      company: raw.company,
      program: raw.program,
      program_dates: raw.program_dates,
      deadline: date.deadline,
      date_status: date.status,
      date_source: date.source,
      note: date.note,
      link,
      cycle: raw.cycle,
      calendar: calendarEntry(date, link, today, raw.cycle || raw.program),
      claimed: raw,
    });
  }
  return { items, none_reason: result.noneReason, usage: result.usage };
}

module.exports = { verifyExtraction, calendarEntry, freshEntry, cycleEnd, decideDate, quoteIn, quoteStatesDate, quoteStatesTime, nextOccurrence, pickLink, htmlToText };
