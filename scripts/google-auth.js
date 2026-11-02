// One-time sign-in that lets Due write to the owner's Google Calendar (until module 6 adds
// per-student linking). Opens Google's consent screen, catches the redirect on a loopback port
// and saves the refresh token to ~/.config/due/google-refresh-token (mode 600). It never prints
// the token.
// Usage: node scripts/google-auth.js ~/Downloads/due-oauth-client.json
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const OUT = path.join(os.homedir(), ".config", "due", "google-refresh-token");
const base64url = (buf) => buf.toString("base64url");

const clientFile = process.argv[2];
if (!clientFile) {
  console.log("usage: node scripts/google-auth.js <oauth-client.json>");
  process.exit(1);
}
const { client_id, client_secret } = JSON.parse(fs.readFileSync(clientFile, "utf8")).installed;
const verifier = base64url(crypto.randomBytes(32));
const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
const state = base64url(crypto.randomBytes(16));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/callback") return res.writeHead(404).end();
  try {
    if (url.searchParams.get("state") !== state) throw new Error("state mismatch");
    if (url.searchParams.get("error")) throw new Error(`Google returned ${url.searchParams.get("error")}`);
    const tokens = await post("https://oauth2.googleapis.com/token", {
      client_id,
      client_secret,
      code: url.searchParams.get("code"),
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
    });
    if (!tokens.refresh_token) throw new Error("Google sent no refresh token");
    if (!tokens.scope?.split(" ").includes(SCOPE)) throw new Error("calendar access was not granted");

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, tokens.refresh_token, { mode: 0o600 });
    const calendar = await (
      await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json();
    res.end("Due is connected to your Google Calendar. You can close this tab.");
    console.log(`connected: calendar "${calendar.summary}" (timezone ${calendar.timeZone}); refresh token saved to ${OUT}`);
    finish(0);
  } catch (err) {
    res.end(`Due could not connect: ${err.message}`);
    console.log(`failed: ${err.message}`);
    finish(1);
  }
});

server.listen(0, "127.0.0.1", () => {
  const params = new URLSearchParams({
    client_id,
    redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  console.log(`opening Google's consent screen (or open this URL yourself):\n${authUrl}`);
  execFile("open", [authUrl], () => {});
});

const timer = setTimeout(() => {
  console.log("failed: no response from Google within 10 minutes");
  finish(1);
}, 10 * 60_000);

function finish(code) {
  clearTimeout(timer);
  server.close();
  process.exitCode = code;
}

async function post(url, form) {
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(form) });
  const body = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${body.error || res.status}`);
  return body;
}
