const db = require("./db");
const queue = require("./queue");

async function receiveReel(reel) {
  if (!(await db.insertShare(reel))) {
    console.log(`share mid=${reel.mid} duplicate delivery ignored`);
    return;
  }
  queue.enqueue(() => processShare(reel.mid));
}

// Stages (fetch -> extract -> calendar -> reply) arrive in modules 2-5.
async function processShare(mid) {
  console.log(`share mid=${mid} picked up (no pipeline stages yet)`);
}

async function requeueInProgress() {
  const mids = await db.inProgressMids();
  for (const mid of mids) queue.enqueue(() => processShare(mid));
  console.log(`requeued ${mids.length} in-progress share(s)`);
}

module.exports = { receiveReel, requeueInProgress };
