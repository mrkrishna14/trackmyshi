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
  test.beforeEach(() => db.pool.query("TRUNCATE shares"));
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
});
