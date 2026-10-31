const crypto = require("crypto");

// DB-backed tests truncate tables, so they only ever run against a local database.
function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`TEST_DATABASE_URL must point at localhost, got ${host}`);
  }
  return url;
}

const SKIP_DB = testDatabaseUrl() ? false : "set TEST_DATABASE_URL to a local Postgres to run";

function sign(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

module.exports = { testDatabaseUrl, SKIP_DB, sign };
