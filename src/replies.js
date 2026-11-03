// Every DM the bot sends. Pure functions from share rows to text, kept under Instagram's
// 1000-character limit. A share gets one message per opportunity, so each can be undone alone.
const MAX_LENGTH = 1000;
const MAX_OPPORTUNITIES = 8;

const FETCH_PROBLEMS = ["reel_private_or_deleted", "fetch_login_required", "fetch_failed"];
const PARTIAL_PROBLEMS = ["transcribe_failed", "ocr_failed"];

const HELP =
  "Share an internship or job reel with me and I'll put its deadline on your Google Calendar with the application link. Reply undo to remove the last one I added.";

// "2026-11-15" -> "Sun, Nov 15"
function formatDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// "23:59", "America/New_York", "2026-11-12" -> "11:59 PM EST"
function formatTime(time, timeZone, date) {
  const [h, m] = time.split(":").map(Number);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName").value;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ${zone}`;
}

function itemText(item, event) {
  const name = `${item.company} ${item.program}`.trim();
  const apply = !item.link
    ? ""
    : item.link.kind === "job_site"
      ? `\nLink (not the official page, so double-check before applying): ${item.link.url}`
      : `\nApply: ${item.link.url}`;
  const updated = item.updated_from ? ` This reel was about ${item.updated_from}, which has ended, so this is this year's posting.` : "";

  if (event?.kind === "deadline") {
    const { date, time, timezone } = item.calendar;
    const when = time ? `${formatDate(date)} at ${formatTime(time, timezone, date)}` : `${formatDate(date)} (end of day)`;
    const source = item.date_source === "official" ? "" : " The date is from the reel; I couldn't confirm it on an official page.";
    return `✅ ${name}: deadline ${when}. Added to your calendar.${source}${updated}${apply}`;
  }
  if (event?.kind === "reminder") {
    return `🔔 ${name}: no official deadline, and postings like this can close without warning. I added an "apply soon" reminder for ${formatDate(event.date)}.${updated}${apply}`;
  }
  if (item.date_status === "conflict") {
    return `⚠️ ${name}: the reel and the official page give different deadlines, so I didn't add it. Check the page before applying.${apply}`;
  }
  if (item.date_status === "passed") return `${name}: the deadline has already passed.`;
  if (item.date_status === "unconfirmed") return `${name}: I couldn't confirm the deadline, so I didn't add it.${apply}`;
  if (item.note?.includes("which has ended")) return `${name}: this posting is from a past season and I couldn't find a current one.`;
  if (item.link) return `${name}: no deadline listed, and I couldn't confirm the posting is still open, so I didn't add a reminder.${apply}`;
  return `${name}: I couldn't find the application page or a deadline.`;
}

// Events record which item they came from; rows calendared before that existed are matched
// by kind, date and company instead.
function eventFor(events, item, index) {
  return (
    events.find((e) => e.index === index) ||
    events.find((e) => e.index === undefined && item.calendar && e.kind === item.calendar.kind && e.date === item.calendar.date && e.summary.includes(item.company))
  );
}

const clip = (text) => (text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH - 1)}…`);

// [{ index, text }] in sending order. index is the opportunity a message is about (null for
// the opening note), which is how "undo" sent as a reply finds the right event.
function shareReplies(share) {
  const problems = share.failure_reason ? share.failure_reason.split(",") : [];
  let note = null;
  if (problems.some((p) => FETCH_PROBLEMS.includes(p))) note = "I couldn't open the video, so I only read the caption.";
  else if (problems.some((p) => PARTIAL_PROBLEMS.includes(p))) note = "I couldn't read all of the video, so I may have missed details.";

  const items = share.extraction?.items || [];
  if (items.length === 0) {
    const none = "I didn't find an internship, job or program with a deadline in this reel.";
    return [{ index: null, text: note ? `${note} ${none}` : none }];
  }
  const events = share.event_ids || [];
  const messages = note ? [{ index: null, text: note }] : [];
  for (const [index, item] of items.slice(0, MAX_OPPORTUNITIES).entries()) {
    const event = eventFor(events, item, index);
    const undo = event ? "\n\nReply undo to this message to remove it." : "";
    messages.push({ index, text: clip(itemText(item, event) + undo) });
  }
  if (items.length > MAX_OPPORTUNITIES) {
    messages.push({ index: null, text: `…and ${items.length - MAX_OPPORTUNITIES} more in this reel that I didn't list.` });
  }
  return messages;
}

function failureReply(reason) {
  if (reason === "google_reauth_needed") return "I couldn't reach your Google Calendar, so nothing was added. Please try again later.";
  return "Sorry, something went wrong while I was reading this reel, so nothing was added. Try sharing it again in a few minutes.";
}

function undoReply(share, removed) {
  if (!share) return "There's nothing to undo.";
  if (removed.length === 0) return "There's nothing to undo for that one.";
  return `Removed from your calendar: ${removed.map((e) => e.summary.replace(/^(Deadline|Apply soon): /, "")).join(", ")}.`;
}

module.exports = { shareReplies, failureReply, undoReply, HELP, formatDate, formatTime };
