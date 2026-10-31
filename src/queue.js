// In-process job queue. The shares table is the source of truth, so anything lost
// on a restart is re-queued from it at boot (see pipeline.requeueInProgress).
const CONCURRENCY = 2;

const pending = [];
let running = 0;

function enqueue(job) {
  pending.push(job);
  drain();
}

function drain() {
  while (running < CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    running++;
    Promise.resolve()
      .then(job)
      .catch((err) => console.log("queued job threw:", err.message))
      .finally(() => {
        running--;
        drain();
      });
  }
}

module.exports = { enqueue, CONCURRENCY };
