// How much a link can be trusted, from its host alone:
//   official  the company's own site (its name is in the host)
//   ats       an application system companies post official listings on
//   job_site  a job board that re-lists postings; only a labelled last resort
//   unknown   anything else; never sent
const ATS_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "myworkdaysite.com", "workday.com",
  "tal.net", "smartrecruiters.com", "icims.com", "taleo.net", "oraclecloud.com", "eightfold.ai",
  "avature.net", "successfactors.com", "jobvite.com", "workable.com", "recruitee.com", "bamboohr.com",
];

const JOB_SITES = [
  "linkedin.com", "indeed.com", "builtin.com", "theladders.com", "glassdoor.com", "ziprecruiter.com",
  "joinhandshake.com", "simplyhired.com", "monster.com", "wayup.com", "ripplematch.com", "wellfound.com",
  "dice.com", "careerbuilder.com", "levels.fyi", "internships.com", "untapped.io", "jobright.ai",
];

const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// "McKinsey & Company" -> ["mckinsey"], "Goldman Sachs" -> ["goldmansachs", "goldman"]: the whole
// name squashed, plus its first word when that is distinctive enough on its own.
function companyNames(company) {
  const words = String(company || "")
    .toLowerCase()
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !["and", "company", "co", "inc", "llc", "ltd", "corp", "corporation", "group", "the"].includes(w));
  if (words.length === 0) return [];
  const names = [words.join("")];
  if (words.length > 1 && words[0].length >= 4) names.push(words[0]);
  return names;
}

function classify(url, company) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
  if (ATS_HOSTS.some((d) => onDomain(host, d))) return "ats";
  if (JOB_SITES.some((d) => onDomain(host, d))) return "job_site";
  const squashed = host.replace(/[^a-z0-9]/g, "");
  if (companyNames(company).some((name) => squashed.includes(name))) return "official";
  return "unknown";
}

const trusted = (kind) => kind === "official" || kind === "ats";

module.exports = { classify, trusted, companyNames };
