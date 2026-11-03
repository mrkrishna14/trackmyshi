const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, companyNames } = require("../src/sources");

test("company names are squashed, with a distinctive first word as a second form", () => {
  assert.deepEqual(companyNames("McKinsey & Company"), ["mckinsey"]);
  assert.deepEqual(companyNames("Goldman Sachs"), ["goldmansachs", "goldman"]);
  assert.deepEqual(companyNames("Jane Street"), ["janestreet", "jane"]);
  assert.deepEqual(companyNames("TikTok"), ["tiktok"]);
});

test("the company's own sites are official", () => {
  for (const [url, company] of [
    ["https://www.janestreet.com/join-jane-street/programs-and-events/focus/", "Jane Street"],
    ["https://apply.careers.microsoft.com/careers/job/1970393557004836", "Microsoft"],
    ["https://www.wellsfargojobs.com/en/jobs/r-1/", "Wells Fargo"],
    ["https://lifeattiktok.com/search/7531983487470110984", "TikTok"],
    ["https://careers.blackrock.com/job/new-york/2027-summer-internship-program-amers/45831/1", "BlackRock"],
    ["https://www.mckinsey.com/careers/search-jobs/jobs/businessanalystintern", "McKinsey & Company"],
  ]) {
    assert.equal(classify(url, company), "official", url);
  }
});

test("application systems are ats, job boards are job_site, the rest unknown", () => {
  assert.equal(classify("https://blackrock.tal.net/vx/candidate/so/pm/1/pl/1/opp/11986", "Acme"), "ats");
  assert.equal(classify("https://job-boards.greenhouse.io/stripe/jobs/8172510", "Stripe"), "ats");
  assert.equal(classify("https://wd1.myworkdayjobs.com/en-US/wf/job/x", "Acme"), "ats");
  assert.equal(classify("https://builtin.com/job/2027-finance-summer-internship-early-careers/9967811", "Wells Fargo"), "job_site");
  assert.equal(classify("https://www.linkedin.com/jobs/view/123", "Microsoft"), "job_site");
  assert.equal(classify("https://seasonalworks.labor.ny.gov/new-york-ny/2027-summer-internship/E8/job/", "BlackRock"), "unknown");
  assert.equal(classify("not a url", "Acme"), "unknown");
});
