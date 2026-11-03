const test = require("node:test");
const assert = require("node:assert/strict");
const { sendText } = require("../src/instagram");

const realFetch = global.fetch;
test.beforeEach(() => Object.assign(process.env, { IG_ACCESS_TOKEN: "tok", IG_ACCOUNT_ID: "17841434812235806" }));
test.afterEach(() => {
  global.fetch = realFetch;
  delete process.env.IG_ACCESS_TOKEN;
  delete process.env.IG_ACCOUNT_ID;
});

test("posts the text to the bot account's messages endpoint and returns the message id", async () => {
  let call;
  global.fetch = async (url, init) => ((call = { url, init }), Response.json({ recipient_id: "2014", message_id: "m-1" }));
  assert.equal(await sendText("2014", "hi"), "m-1");
  assert.equal(call.url, "https://graph.facebook.com/v24.0/17841434812235806/messages");
  assert.equal(call.init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(call.init.body), { recipient: { id: "2014" }, message: { text: "hi" } });
});

test("Meta errors and missing configuration are reply_failed", async () => {
  global.fetch = async () => Response.json({ error: { code: 190, message: "token expired" } }, { status: 400 });
  await assert.rejects(sendText("2014", "hi"), { reason: "reply_failed", message: /code=190 token expired/ });
  delete process.env.IG_ACCOUNT_ID;
  await assert.rejects(sendText("2014", "hi"), { reason: "reply_failed", message: /not set/ });
});
