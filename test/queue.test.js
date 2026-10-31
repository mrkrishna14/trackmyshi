const test = require("node:test");
const assert = require("node:assert/strict");
const queue = require("../src/queue");

test("queue runs at most CONCURRENCY jobs at once and keeps going after a failure", async () => {
  let active = 0;
  let peak = 0;
  const finished = [];

  const done = new Promise((resolve) => {
    for (let i = 0; i < 6; i++) {
      queue.enqueue(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        finished.push(i);
        if (finished.length === 6) resolve();
        if (i === 1) throw new Error("boom");
      });
    }
  });

  await done;
  assert.equal(peak, queue.CONCURRENCY);
  assert.deepEqual(finished.sort(), [0, 1, 2, 3, 4, 5]);
});
