const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

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
const RESULT_COLUMNS = ["bundle"];

async function setStatus(mid, status, failureReason = null, results = {}) {
  const sets = ["status = $2", "failure_reason = $3"];
  const values = [mid, status, failureReason];
  if (STAGE_COLUMNS[status]) sets.push(`${STAGE_COLUMNS[status]} = now()`);
  for (const column of RESULT_COLUMNS) {
    if (!(column in results)) continue;
    values.push(JSON.stringify(results[column]));
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

// The Send API only allows replies within 24h of the user's message, so older work is abandoned.
async function inProgressMids() {
  const { rows } = await pool.query(
    `SELECT mid FROM shares
     WHERE status = ANY($1) AND received_at > now() - interval '24 hours'
     ORDER BY received_at`,
    [IN_PROGRESS]
  );
  return rows.map((row) => row.mid);
}

module.exports = { pool, init, insertShare, setStatus, getShare, inProgressMids };
