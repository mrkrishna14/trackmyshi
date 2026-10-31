const crypto = require("crypto");

// Meta signs each POST with HMAC-SHA256 of the raw body, keyed by the app secret.
function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Reduces a webhook body to the events we act on: shared reels and text messages.
// Echoes of our own sends, deletions, reads and reactions are dropped.
function parseEvents(body) {
  const events = [];
  for (const entry of asArray(body?.entry)) {
    for (const event of asArray(entry?.messaging)) {
      const message = event?.message;
      const senderId = event?.sender?.id;
      if (!message?.mid || !senderId || message.is_echo || message.is_deleted) continue;

      const reel = asArray(message.attachments).find((a) => a?.type === "ig_reel" && a.payload?.url);
      if (reel) {
        events.push({
          kind: "reel",
          mid: message.mid,
          senderId: String(senderId),
          reelUrl: reel.payload.url,
          caption: reel.payload.title || "",
        });
      } else if (typeof message.text === "string") {
        events.push({ kind: "text", mid: message.mid, senderId: String(senderId), text: message.text });
      }
    }
  }
  return events;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = { verifySignature, parseEvents };
