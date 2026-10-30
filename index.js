const express = require("express");

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

// Read the body as raw text instead of express.json(), so a malformed or
// non-JSON body still gets a 200 and gets logged rather than rejected with 400.
app.post("/webhook", express.text({ type: () => true, limit: "1mb" }), (req, res) => {
  res.sendStatus(200);

  const raw = typeof req.body === "string" ? req.body : "";
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    console.log(`Webhook POST with non-JSON body:\n${raw}`);
    return;
  }

  console.log(`Webhook POST body:\n${JSON.stringify(body, null, 2)}`);

  try {
    logSummaries(body);
  } catch (err) {
    console.log("Could not summarize webhook body:", err.message);
  }
});

// Instagram delivers messages as entry[].messaging[]; some API versions use
// entry[].changes[] with field "messages" instead. Check both.
function logSummaries(body) {
  for (const entry of body.entry || []) {
    const events = [
      ...(entry.messaging || []),
      ...(entry.changes || []).filter((c) => c.field === "messages").map((c) => c.value),
    ];

    for (const event of events) {
      const senderId = event?.sender?.id;
      const attachments = event?.message?.attachments || [];
      const types = attachments.map((a) => a?.type).filter(Boolean);
      const urls = attachments.map((a) => a?.payload?.url).filter(Boolean);
      const text = event?.message?.text;

      console.log(
        `Message summary: sender=${senderId ?? "?"}` +
          ` attachment_types=${types.length ? types.join(",") : "none"}` +
          ` urls=${urls.length ? urls.join(" ") : "none"}` +
          (text ? ` text=${JSON.stringify(text)}` : "")
      );
    }
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
