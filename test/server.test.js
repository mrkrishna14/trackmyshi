// Boots the real server against a local database and drives it like Meta would.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const { testDatabaseUrl, SKIP_DB, sign, PATH_WITH_STUBS } = require("./helpers");
const fixture = require("./fixtures/reel-share.json");

const SECRET = "test-secret";
const MID = fixture.entry[0].messaging[0].message.mid;

test.describe("server", { skip: SKIP_DB }, () => {
  let server;
  let base;
  let pool;
  let output = "";

  async function waitFor(check, what) {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`timed out waiting for ${what}\n--- server output ---\n${output}`);
  }
  const waitForLog = (text) => waitFor(() => output.includes(text), `log "${text}"`);
  const countRows = async () => (await pool.query("SELECT count(*)::int AS n FROM shares")).rows[0].n;

  function post(body, signature = sign(body, SECRET)) {
    return fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body,
    });
  }

  test.before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    // Simulate rows left behind by a process killed mid-job, plus rows that must not be retried.
    await pool.query("DROP TABLE IF EXISTS shares");
    await pool.query(require("fs").readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    await pool.query(`INSERT INTO shares (mid, sender_id, reel_url, status, received_at) VALUES
      ('left-behind', 's', 'u', 'fetched', now()),
      ('finished', 's', 'u', 'replied', now()),
      ('too-old', 's', 'u', 'received', now() - interval '25 hours')`);

    const port = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, ["index.js"], {
      cwd: path.join(__dirname, ".."),
      // The stub yt-dlp fails every fetch, so shares go caption-only and no vendor is called.
      env: { PATH: PATH_WITH_STUBS, USER: process.env.USER, HOME: process.env.HOME, PORT: String(port), DATABASE_URL: testDatabaseUrl(), APP_SECRET: SECRET, VERIFY_TOKEN: "vt" },
    });
    server.stdout.on("data", (d) => (output += d));
    server.stderr.on("data", (d) => (output += d));
    await waitForLog("Listening on port");
  });

  test.after(async () => {
    server?.kill();
    await pool?.end();
  });

  test("boot re-queues only unfinished shares from the last 24h", async () => {
    await waitForLog("requeued 1 in-progress share(s)");
    await waitForLog("share mid=left-behind picked up");
    assert.ok(!output.includes("mid=finished picked up"));
    assert.ok(!output.includes("mid=too-old picked up"));
  });

  test("health check and verification handshake still work", async () => {
    assert.equal(await (await fetch(base)).text(), "ok");
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "42");
    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`);
    assert.equal(bad.status, 403);
  });

  test("a signed reel share is recorded once, even when Meta redelivers it", async () => {
    const before = await countRows();
    const body = JSON.stringify(fixture);

    assert.equal((await post(body)).status, 200);
    await waitFor(async () => (await countRows()) === before + 1, "share row");
    const { rows } = await pool.query("SELECT * FROM shares WHERE mid = $1", [MID]);
    assert.equal(rows[0].sender_id, "1000000000000001");
    assert.equal(rows[0].reel_url, "https://www.instagram.com/reel/De2uJ0aP1zu/");
    assert.match(rows[0].caption, /#janestreet/);
    await waitForLog(`share mid=${MID} sender=1000000000000001 status=received`);

    assert.equal((await post(body)).status, 200);
    await waitForLog(`share mid=${MID} duplicate delivery ignored`);
    assert.equal(await countRows(), before + 1);
  });

  test("a share whose video can't be fetched still gets a caption-only bundle", async () => {
    await waitForLog(`share mid=${MID} sender=1000000000000001 status=fetched reason=fetch_failed`);
    const { rows } = await pool.query("SELECT * FROM shares WHERE mid = $1", [MID]);
    assert.equal(rows[0].status, "fetched");
    assert.equal(rows[0].failure_reason, "fetch_failed");
    assert.match(rows[0].bundle.caption, /#janestreet/);
    assert.equal(rows[0].bundle.transcript, null);
    assert.ok(rows[0].fetched_at instanceof Date);
  });

  test("bad signatures, non-JSON bodies, echoes and texts get 200 but create no rows", async () => {
    const before = await countRows();
    const other = JSON.stringify({ ...fixture, entry: [{ messaging: [{ sender: { id: "9" }, message: { mid: "x1", attachments: fixture.entry[0].messaging[0].message.attachments } }] }] });

    assert.equal((await post(other, sign(other, "wrong-secret"))).status, 200);
    await waitForLog("webhook dropped: invalid or missing signature");
    assert.equal((await post(other, "")).status, 200);

    assert.equal((await post("{not json")).status, 200);
    await waitForLog("webhook dropped: body is not JSON");

    const echo = JSON.stringify({ entry: [{ messaging: [{ sender: { id: "9" }, message: { mid: "x2", is_echo: true, text: "hi" } }] }] });
    assert.equal((await post(echo)).status, 200);

    const text = JSON.stringify({ entry: [{ messaging: [{ sender: { id: "9" }, message: { mid: "x3", text: "undo" } }] }] });
    assert.equal((await post(text)).status, 200);
    await waitForLog("webhook ignored kind=text mid=x3");

    const empty = await fetch(`${base}/webhook`, { method: "POST" });
    assert.equal(empty.status, 200);

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await countRows(), before);
    assert.ok(!output.includes("mid=x2"), "echo must be ignored silently");
  });
});
