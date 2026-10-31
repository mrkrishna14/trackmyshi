const express = require("express");
const db = require("./src/db");
const { verifySignature, parseEvents } = require("./src/webhook");
const { receiveReel, requeueInProgress } = require("./src/pipeline");

process.on("unhandledRejection", (err) => console.log("unhandled rejection:", err?.message || err));

if (!process.env.APP_SECRET) console.log("APP_SECRET is not set: every webhook POST will be dropped");

// Webhooks that arrive before the schema is applied wait on this.
const ready = db.init().then(requeueInProgress);
ready.catch((err) => {
  console.log("database init failed:", err.message);
  process.exit(1);
});

const app = express();

app.get("/", (req, res) => {
  res.type("text/plain").send("ok");
});

// Meta's verification handshake, sent when the callback URL is saved in the dashboard.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && process.env.VERIFY_TOKEN && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).type("text/plain").send(String(challenge));
  }

  console.log(`Webhook verification failed (hub.mode=${mode})`);
  return res.sendStatus(403);
});

// Always 200 first so Meta never retries or disables the webhook; all work happens after.
// The body is read as raw bytes because the signature covers the exact bytes Meta sent.
app.post("/webhook", express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
  res.sendStatus(200);

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifySignature(raw, req.get("x-hub-signature-256"), process.env.APP_SECRET)) {
    console.log("webhook dropped: invalid or missing signature");
    return;
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    console.log("webhook dropped: body is not JSON");
    return;
  }

  for (const event of parseEvents(body)) {
    if (event.kind === "reel") {
      ready
        .then(() => receiveReel(event))
        .catch((err) => console.log(`share mid=${event.mid} could not be recorded: ${err.message}`));
    } else {
      // Text messages (undo, help) are routed in module 5.
      console.log(`webhook ignored kind=${event.kind} mid=${event.mid}`);
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
