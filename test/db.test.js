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

  test("inProgressMids resumes unfinished shares from the last 30 minutes and closes older ones", async () => {
    await db.insertShare({ ...share, mid: "fresh" });
    await db.insertShare({ ...share, mid: "midway" });
    await db.setStatus("midway", "extracted");
    await db.insertShare({ ...share, mid: "done" });
    await db.setStatus("done", "replied");
    await db.insertShare({ ...share, mid: "dead" });
    await db.setStatus("dead", "failed", "x");
    await db.insertShare({ ...share, mid: "stale" });
    await db.setStatus("stale", "calendared", "ocr_failed");
    await db.pool.query("UPDATE shares SET received_at = now() - interval '31 minutes' WHERE mid = 'stale'");

    assert.deepEqual((await db.inProgressMids()).sort(), ["fresh", "midway"]);
    const stale = await db.getShare("stale");
    assert.equal(stale.status, "failed");
    assert.equal(stale.failure_reason, "ocr_failed,abandoned_after_restart");
  });

  test("insertText dedupes on mid", async () => {
    assert.equal(await db.insertText("t1", "s1"), true);
    assert.equal(await db.insertText("t1", "s1"), false);
  });

  test("setStatus stores reply_mid as plain text and replies as JSON", async () => {
    await db.insertShare(share);
    await db.setStatus("m1", "replied", null, { reply_mid: "bot-reply-1", replies: [{ index: 0, reply_mid: "r0" }] });
    const row = await db.getShare("m1");
    assert.equal(row.reply_mid, "bot-reply-1");
    assert.deepEqual(row.replies, [{ index: 0, reply_mid: "r0" }]);
  });

  test("shareToUndo finds the opportunity whose message was replied to, else the latest share with events", async () => {
    const events = [
      { id: "e0", index: 0, kind: "deadline", date: "2026-11-15", summary: "Deadline: X" },
      { id: "e1", index: 1, kind: "reminder", date: "2026-11-04", summary: "Apply soon: Y" },
    ];
    for (const mid of ["old", "new", "empty", "legacy", "other"]) {
      await db.insertShare({ ...share, mid, senderId: mid === "other" ? "s2" : "s1" });
    }
    await db.pool.query("UPDATE shares SET received_at = now() - interval '1 hour' WHERE mid IN ('old', 'legacy')");
    await db.setStatus("old", "replied", null, { event_ids: events, replies: [{ index: 0, reply_mid: "r-old-0" }, { index: 1, reply_mid: "r-old-1" }] });
    await db.setStatus("new", "replied", null, { event_ids: events, replies: [{ index: 0, reply_mid: "r-new-0" }] });
    await db.setStatus("empty", "replied", null, { event_ids: [] });
    await db.setStatus("legacy", "replied", null, { event_ids: events, reply_mid: "r-legacy" });
    await db.setStatus("other", "replied", null, { event_ids: events, replies: [{ index: 0, reply_mid: "r-other" }] });

    const pick = async (reply) => {
      const t = await db.shareToUndo("s1", reply);
      return t && [t.share.mid, t.index];
    };
    assert.deepEqual(await pick(null), ["new", null], "plain undo: latest share with events");
    assert.deepEqual(await pick("r-old-1"), ["old", 1], "a reply to one opportunity's message");
    assert.deepEqual(await pick("r-legacy"), ["legacy", null], "an older single reply");
    assert.deepEqual(await pick("old"), ["old", null], "a reply to the student's own share");
    assert.equal(await pick("nope"), null);
    assert.equal(await db.shareToUndo("s2", "r-new-0"), null, "never another student's share");
  });
});
