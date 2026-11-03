const test = require("node:test");
const assert = require("node:assert/strict");
const { check, CLOSED_TEXT } = require("../src/postings");

const realFetch = global.fetch;
let calls;
test.afterEach(() => (global.fetch = realFetch));
function fake(responses) {
  calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const [status, body] = responses[String(url)] || [404, {}];
    return Response.json(body, { status });
  };
}

test("Greenhouse postings are checked against the job board API", async () => {
  fake({ "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8172510": [200, { title: "Software Engineering Intern" }] });
  assert.deepEqual(await check("https://job-boards.greenhouse.io/stripe/jobs/8172510"), { open: true, title: "Software Engineering Intern" });
  assert.deepEqual(await check("https://boards.greenhouse.io/stripe/jobs/1"), { open: false, title: null }, "404 means taken down");
});

test("Lever and Ashby postings are checked against their APIs", async () => {
  const id = "6ed76ce8-4156-4b60-b120-403538bd66cd";
  fake({
    [`https://api.lever.co/v0/postings/palantir/${id}`]: [200, { text: "Intern" }],
    "https://api.ashbyhq.com/posting-api/job-board/ramp": [200, { jobs: [{ id, title: "Intern" }] }],
  });
  assert.deepEqual(await check(`https://jobs.lever.co/palantir/${id}`), { open: true, title: "Intern" });
  assert.deepEqual(await check(`https://jobs.ashbyhq.com/ramp/${id}`), { open: true, title: "Intern" });
  assert.deepEqual(await check("https://jobs.ashbyhq.com/ramp/00000000-0000-0000-0000-000000000000"), { open: false, title: null });
});

test("other hosts, unparseable paths and API outages are 'can't tell'", async () => {
  fake({ "https://boards-api.greenhouse.io/v1/boards/x/jobs/9": [500, {}] });
  assert.equal(await check("https://www.janestreet.com/join-jane-street/programs-and-events/focus/"), null);
  assert.equal(await check("https://boards.greenhouse.io/stripe"), null);
  assert.equal(await check("https://boards.greenhouse.io/x/jobs/9"), null);
  assert.equal(await check("nonsense"), null);
});

test("closed-posting wording is recognised", () => {
  for (const t of ["This position has been filled.", "We are no longer accepting applications", "Applications are now closed", "This job has expired"]) {
    assert.ok(CLOSED_TEXT.test(t), t);
  }
  assert.ok(!CLOSED_TEXT.test("Apply now! Applications close November 15."));
});
