const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { messageKey } = require("./webhook");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (err) => console.log("postgres pool error:", err.message));

const STAGE_COLUMNS = {
  fetched: "fetched_at",
  extracted: "extracted_at",
  calendared: "calendared_at",
  replied: "replied_at",
};

// Shares partway through the pipeline. Anything else is finished or waiting on the user.
const IN_PROGRESS = ["received", "fetched", "extracted", "calendared"];

async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
}

function logShare(mid, senderId, status, reason) {
  console.log(`share mid=${mid} sender=${senderId} status=${status}${reason ? ` reason=${reason}` : ""}`);
}

// Returns false when the mid already exists, i.e. Meta redelivered the same message.
async function insertShare({ mid, senderId, reelUrl, caption }) {
  const { rowCount } = await pool.query(
    `INSERT INTO shares (mid, sender_id, reel_url, caption) VALUES ($1, $2, $3, $4)
     ON CONFLICT (mid) DO NOTHING`,
    [mid, senderId, reelUrl, caption]
  );
  if (rowCount === 1) logShare(mid, senderId, "received");
  return rowCount === 1;
}

// Stage results that are saved together with the status change that produced them.
const RESULT_COLUMNS = { bundle: "json", extraction: "json", event_ids: "json", replies: "json", reply_mid: "text" };

async function setStatus(mid, status, failureReason = null, results = {}) {
  const sets = ["status = $2", "failure_reason = $3"];
  const values = [mid, status, failureReason];
  if (STAGE_COLUMNS[status]) sets.push(`${STAGE_COLUMNS[status]} = now()`);
  for (const [column, type] of Object.entries(RESULT_COLUMNS)) {
    if (!(column in results)) continue;
    values.push(type === "json" ? JSON.stringify(results[column]) : results[column]);
    sets.push(`${column} = $${values.length}`);
  }
  const { rows } = await pool.query(
    `UPDATE shares SET ${sets.join(", ")} WHERE mid = $1 RETURNING sender_id`,
    values
  );
  if (rows[0]) logShare(mid, rows[0].sender_id, status, failureReason);
}

async function getShare(mid) {
  const { rows } = await pool.query("SELECT * FROM shares WHERE mid = $1", [mid]);
  return rows[0];
}

// A reply that arrives long after the share is confusing, so after a restart only shares from
// the last 30 minutes are resumed. Older unfinished ones are closed without a DM.
async function inProgressMids() {
  const { rows: abandoned } = await pool.query(
    `UPDATE shares SET status = 'failed', failure_reason = concat_ws(',', failure_reason, 'abandoned_after_restart')
     WHERE status = ANY($1) AND received_at <= now() - interval '30 minutes'
     RETURNING mid, sender_id`,
    [IN_PROGRESS]
  );
  for (const row of abandoned) logShare(row.mid, row.sender_id, "failed", "abandoned_after_restart");
  const { rows } = await pool.query(
    "SELECT mid FROM shares WHERE status = ANY($1) ORDER BY received_at",
    [IN_PROGRESS]
  );
  return rows.map((row) => row.mid);
}

// Returns false when the text was already seen (a Meta redelivery).
async function insertText(mid, senderId) {
  const { rowCount } = await pool.query(
    "INSERT INTO texts (mid, sender_id) VALUES ($1, $2) ON CONFLICT (mid) DO NOTHING",
    [mid, senderId]
  );
  return rowCount === 1;
}

// What an "undo" means: { share, index }. Sent as a reply, it's the opportunity whose message
// it answers (index), or a whole share when it answers the share itself or an older single
// reply (index null). Sent plainly, it's every event of the sender's latest share that still
// has any. Returns null when nothing matches.
async function shareToUndo(senderId, replyToMid) {
  if (replyToMid) {
    const key = messageKey(replyToMid);
    const { rows } = await pool.query("SELECT * FROM shares WHERE sender_id = $1 ORDER BY received_at DESC LIMIT 200", [senderId]);
    for (const row of rows) {
      const reply = (row.replies || []).find((r) => messageKey(r.reply_mid) === key);
      if (reply) return { share: row, index: reply.index };
      if (messageKey(row.reply_mid) === key || messageKey(row.mid) === key) return { share: row, index: null };
    }
    return null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM shares WHERE sender_id = $1 AND status = 'replied' AND jsonb_array_length(event_ids) > 0
     ORDER BY received_at DESC LIMIT 1`,
    [senderId]
  );
  return rows[0] ? { share: rows[0], index: null } : null;
}

module.exports = { pool, init, insertShare, setStatus, getShare, inProgressMids, insertText, shareToUndo };
