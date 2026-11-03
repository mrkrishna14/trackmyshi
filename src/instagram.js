// sendText(recipientId, text) -> message id. The only place that talks to Meta's Send API.
// IG_ACCESS_TOKEN is a system-user token for the bot account, IG_ACCOUNT_ID is that account's
// Instagram id. Throws InstagramError (reason reply_failed) when Meta refuses.
const API = "https://graph.facebook.com/v24.0";

class InstagramError extends Error {
  constructor(message) {
    super(message);
    this.reason = "reply_failed";
  }
}

async function sendText(recipientId, text) {
  const { IG_ACCESS_TOKEN, IG_ACCOUNT_ID } = process.env;
  if (!IG_ACCESS_TOKEN || !IG_ACCOUNT_ID) throw new InstagramError("IG_ACCESS_TOKEN or IG_ACCOUNT_ID is not set");
  let res;
  try {
    res = await fetch(`${API}/${IG_ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${IG_ACCESS_TOKEN}` },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new InstagramError(`send request failed: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.message_id) {
    // Code 190 means the token itself is invalid or expired: it has to be regenerated in Meta.
    throw new InstagramError(`send returned ${res.status} code=${body.error?.code} ${body.error?.message || ""}`);
  }
  return body.message_id;
}

module.exports = { sendText, InstagramError };
