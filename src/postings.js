// check(url) -> { open, title } when the posting's application system has a public JSON API
// that says for certain whether it is live, else null. No keys needed for any of them.
const TIMEOUT = 10_000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// boards.greenhouse.io/{board}/jobs/{id} or job-boards.greenhouse.io/{board}/jobs/{id}
async function greenhouse(u) {
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (!m) return null;
  const job = await getJson(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
  return { open: Boolean(job), title: job?.title || null };
}

// jobs.lever.co/{site}/{id}
async function lever(u) {
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/);
  if (!m) return null;
  const job = await getJson(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
  return { open: Boolean(job), title: job?.text || null };
}

// jobs.ashbyhq.com/{board}/{id}
async function ashby(u) {
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/);
  if (!m) return null;
  const board = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`);
  const job = (board?.jobs || []).find((j) => j.id === m[2]);
  return { open: Boolean(job), title: job?.title || null };
}

const CHECKERS = {
  "boards.greenhouse.io": greenhouse,
  "job-boards.greenhouse.io": greenhouse,
  "jobs.lever.co": lever,
  "jobs.ashbyhq.com": ashby,
};

async function check(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const checker = CHECKERS[u.hostname.toLowerCase()];
  if (!checker) return null;
  try {
    return await checker(u);
  } catch {
    return null; // the API being down is "can't tell", not "closed"
  }
}

// Page wording that means a posting no longer takes applications.
const CLOSED_TEXT = /no longer (accepting|available)|position (has been )?filled|applications? (are|is) (now )?closed|this (job|posting|position|role) (is|has) (closed|expired)|job (is )?(closed|expired)/i;

module.exports = { check, CLOSED_TEXT };
