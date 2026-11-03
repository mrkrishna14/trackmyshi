const test = require("node:test");
const assert = require("node:assert/strict");
const { testDatabaseUrl, SKIP_DB } = require("./helpers");

if (!SKIP_DB) process.env.DATABASE_URL = testDatabaseUrl();
const db = require("../src/db");

const share = { mid: "m1", senderId: "s1", reelUrl: "https://www.instagram.com/reel/x/", caption: "cap" };

test.describe("db", { skip: SKIP_DB }, () => {
  test.before(async () => {
    await db.init();
    await db.init(); // schema must be safe to re-apply on every boot
  });
  test.beforeEach(() => db.pool.query("TRUNCATE shares, texts"));
  test.after(() => db.pool.end());

  test("insertShare dedupes on mid", async () => {
    assert.equal(await db.insertShare(share), true);
    assert.equal(await db.insertShare(share), false);
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM shares");
    assert.equal(rows[0].n, 1);
  });

  test("a new share starts as received with the payload stored", async () => {
    await db.insertShare(share);
    const row = await db.getShare("m1");
    assert.equal(row.status, "received");
    assert.equal(row.sender_id, "s1");
    assert.equal(row.caption, "cap");
    assert.ok(row.received_at instanceof Date);
    assert.equal(row.fetched_at, null);
  });

  test("setStatus stamps the stage column and records failure reasons", async () => {
    await db.insertShare(share);
    await db.setStatus("m1", "fetched");
    let row = await db.getShare("m1");
    assert.equal(row.status, "fetched");
    assert.ok(row.fetched_at instanceof Date);

    await db.setStatus("m1", "failed", "fetch_failed");
    row = await db.getShare("m1");
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "fetch_failed");
  });

  test("setStatus saves the stage result in the same update", async () => {
    await db.insertShare(share);
    const bundle = { caption: "cap", transcript: null, ocr: [{ t: 1.5, text: "Nov 15" }] };
    await db.setStatus("m1", "fetched", "transcribe_failed", { bundle });
    const row = await db.getShare("m1");
    assert.equal(row.status, "fetched");
    assert.equal(row.failure_reason, "transcribe_failed");
    assert.deepEqual(row.bundle, bundle);
  });

  test("inProgressMids returns unfinished shares from the last 24h only", async () => {
    await db.insertShare({ ...share, mid: "fresh" });
    await db.insertShare({ ...share, mid: "midway" });
    await db.setStatus("midway", "extracted");
    await db.insertShare({ ...share, mid: "done" });
    await db.setStatus("done", "replied");
    await db.insertShare({ ...share, mid: "dead" });
    await db.setStatus("dead", "failed", "x");
    await db.insertShare({ ...share, mid: "stale" });
    await db.pool.query("UPDATE shares SET received_at = now() - interval '25 hours' WHERE mid = 'stale'");

    assert.deepEqual((await db.inProgressMids()).sort(), ["fresh", "midway"]);
  });

  test("insertText dedupes on mid", async () => {
    assert.equal(await db.insertText("t1", "s1"), true);
    assert.equal(await db.insertText("t1", "s1"), false);
  });

  test("setStatus stores reply_mid as plain text", async () => {
    await db.insertShare(share);
    await db.setStatus("m1", "replied", null, { reply_mid: "bot-reply-1" });
    assert.equal((await db.getShare("m1")).reply_mid, "bot-reply-1");
  });

  test("shareToUndo finds the replied-to share, else the sender's latest share with events", async () => {
    const event = [{ id: "e", index: 0, kind: "deadline", date: "2026-11-15", summary: "Deadline: X" }];
    for (const mid of ["old", "new", "empty", "other"]) {
      await db.insertShare({ ...share, mid, senderId: mid === "other" ? "s2" : "s1" });
    }
    await db.pool.query("UPDATE shares SET received_at = now() - interval '1 hour' WHERE mid = 'old'");
    await db.setStatus("old", "replied", null, { event_ids: event, reply_mid: "reply-old" });
    await db.setStatus("new", "replied", null, { event_ids: event, reply_mid: "reply-new" });
    await db.setStatus("empty", "replied", null, { event_ids: [] });
    await db.setStatus("other", "replied", null, { event_ids: event });

    assert.equal((await db.shareToUndo("s1", null)).mid, "new", "latest with events, ignoring the one with none");
    assert.equal((await db.shareToUndo("s1", "reply-old")).mid, "old", "a reply to the bot's message picks that share");
    assert.equal((await db.shareToUndo("s1", "old")).mid, "old", "a reply to the student's own share works too");
    assert.equal(await db.shareToUndo("s1", "reply-of-someone-else"), undefined);
    assert.equal(await db.shareToUndo("s2", "reply-new"), undefined, "never another student's share");
  });
});
