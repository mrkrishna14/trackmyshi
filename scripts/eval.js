// Runs real reels through fetch -> transcribe/OCR -> identify -> find -> verify, with no calendar
// writes and no DMs, and scores the result against test/eval-reels.json.
// Usage: node scripts/eval.js [reel-id ...]
// API keys are read from Railway's variables at runtime (never printed). The Railway project
// token comes from RAILWAY_TOKEN or ~/.config/due/railway-token.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SET = path.join(__dirname, "..", "test", "eval-reels.json");
// List prices, for the cost column only: Sonnet 5.5 per token, web search per call, Whisper per minute.
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, search: 0.01, whisperMinute: 0.006 };

function loadKeys() {
  const token = process.env.RAILWAY_TOKEN || fs.readFileSync(path.join(os.homedir(), ".config", "due", "railway-token"), "utf8").trim();
  const vars = execFileSync("railway", ["variables", "--service", "trackmyshi", "--kv"], { env: { ...process.env, RAILWAY_TOKEN: token }, encoding: "utf8" });
  for (const line of vars.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key)) process.env[key] = rest.join("=");
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) throw new Error("could not read API keys from Railway");
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const same = (a, b) => Boolean(norm(a) && norm(b)) && (norm(a).includes(norm(b)) || norm(b).includes(norm(a)));

// The extracted item that is about the expected opportunity: same company, and same program
// when the expectation names one.
function match(items, expected) {
  const byCompany = items.filter((i) => same(i.company, expected.company));
  return byCompany.find((i) => !expected.program || same(i.program, expected.program)) || byCompany[0];
}

function score(expected, item) {
  if (!item) return { found: false, link: "missed", date: "missed", wrongDate: false };
  const url = item.link?.url || null;
  const linkOk = Boolean(url && expected.links.some((prefix) => url.startsWith(prefix)));
  // none_ok: no current posting exists (e.g. applications not open yet), so no link is right too.
  const link = !url ? (expected.none_ok ? "correct" : "none") : linkOk ? "correct" : item.link.kind === "job_site" ? "job_site" : "wrong";
  const written = item.calendar?.kind === "deadline" ? item.calendar.date : null;
  const wrongDate = Boolean(written && written !== expected.deadline);
  const date = wrongDate ? `WRONG ${written}` : written ? "correct" : expected.deadline ? "not added" : "correctly none";
  return { found: true, link, url, kind: item.link?.kind || "-", date, wrongDate, posting: item.posting_status, calendar: item.calendar?.kind || "-" };
}

async function main() {
  loadKeys();
  // Required after the keys are set so the SDK clients pick them up.
  const { buildBundle, runExtraction } = require("../src/pipeline");
  const set = JSON.parse(fs.readFileSync(SET, "utf8"));
  const only = process.argv.slice(2);
  const reels = only.length ? set.reels.filter((r) => only.some((id) => r.url.includes(id))) : set.reels;

  const rows = [];
  let totalCost = 0;
  for (const reel of reels) {
    const caption = execFileSync("yt-dlp", ["--skip-download", "--print", "description", reel.url], { encoding: "utf8" }).trim();
    const share = { mid: `eval-${reel.url.split("/reel/")[1].replace(/\W/g, "")}`, reel_url: reel.url, caption, received_at: new Date() };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "due-eval-"));
    let bundle;
    try {
      ({ bundle } = await buildBundle(share, dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const { extraction, reason } = await runExtraction({ ...share, bundle });
    if (reason) {
      console.log(`${reel.url}: extraction failed (${reason})`);
      for (const expected of reel.expect) rows.push({ reel: reel.url, ...expected, ...score(expected, null) });
      continue;
    }
    const u = extraction.usage;
    const cost = u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + u.web_searches * PRICE.search + ((bundle.durationSec || 0) / 60) * PRICE.whisperMinute + 0.016;
    totalCost += cost;
    for (const expected of reel.expect) rows.push({ reel: reel.url, company: expected.company, ...score(expected, match(extraction.items, expected)) });
    for (const item of extraction.items) {
      if (!reel.expect.some((e) => match([item], e))) rows.push({ reel: reel.url, company: `(extra) ${item.company}`, found: true, link: item.link ? item.link.kind : "none", url: item.link?.url, date: item.calendar?.kind || "-", wrongDate: item.calendar?.kind === "deadline" });
    }
    console.log(`${reel.url}: ${extraction.items.length} item(s), ${u.web_searches} searches, in=${u.input_tokens} out=${u.output_tokens}, ~$${cost.toFixed(2)}`);
  }

  console.log("");
  console.table(rows.map((r) => ({ reel: r.reel.split("/reel/")[1].slice(0, 11), company: r.company.slice(0, 22), link: r.link, kind: r.kind, date: r.date, posting: r.posting, url: (r.url || "").slice(0, 70) })));
  const expected = rows.filter((r) => !r.company.startsWith("(extra)"));
  const correct = expected.filter((r) => r.link === "correct").length;
  const wrongDates = rows.filter((r) => r.wrongDate).length;
  console.log(`\nofficial link correct: ${correct}/${expected.length} (${Math.round((100 * correct) / Math.max(1, expected.length))}%)`);
  console.log(`job-site fallbacks: ${expected.filter((r) => r.link === "job_site").length}, wrong links: ${expected.filter((r) => r.link === "wrong").length}, missed: ${expected.filter((r) => !r.found).length}`);
  console.log(`WRONG DATES: ${wrongDates}`);
  console.log(`cost: ~$${totalCost.toFixed(2)} total, ~$${(totalCost / Math.max(1, expected.length)).toFixed(3)} per expected opportunity`);
  process.exitCode = wrongDates > 0 ? 1 : 0;
}

main().catch((err) => {
  console.log(`eval failed: ${err.message}`);
  process.exitCode = 1;
});
