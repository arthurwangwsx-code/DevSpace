import assert from "node:assert/strict";
import {
  BoundedRequestGate,
  MemoryGuard,
  ResourceLimitError,
} from "./mcp-resource-control.js";

const gate = new BoundedRequestGate({
  maxConcurrent: 2,
  maxQueued: 1,
  queueTimeoutMs: 1_000,
});
const releaseFirst = await gate.acquire();
const releaseSecond = await gate.acquire();
assert.deepEqual(gate.stats, {
  active: 2,
  queued: 0,
  maxConcurrent: 2,
  maxQueued: 1,
});

let queuedAcquired = false;
const queued = gate.acquire().then((release) => {
  queuedAcquired = true;
  return release;
});
await Promise.resolve();
assert.equal(gate.stats.queued, 1);
await assert.rejects(
  gate.acquire(),
  (error: unknown) => error instanceof ResourceLimitError && error.reason === "queue_full",
);

releaseFirst();
const releaseQueued = await queued;
assert.equal(queuedAcquired, true);
assert.equal(gate.stats.active, 2);
assert.equal(gate.stats.queued, 0);
releaseQueued();
releaseSecond();
assert.equal(gate.stats.active, 0);

const timeoutGate = new BoundedRequestGate({
  maxConcurrent: 1,
  maxQueued: 1,
  queueTimeoutMs: 5,
});
const releaseTimeoutBlocker = await timeoutGate.acquire();
const keepEventLoopAlive = setTimeout(() => undefined, 100);
try {
  await assert.rejects(
    timeoutGate.acquire(),
    (error: unknown) => error instanceof ResourceLimitError && error.reason === "queue_timeout",
  );
} finally {
  clearTimeout(keepEventLoopAlive);
}
releaseTimeoutBlocker();

const closeGate = new BoundedRequestGate({
  maxConcurrent: 1,
  maxQueued: 1,
  queueTimeoutMs: 1_000,
});
const releaseCloseBlocker = await closeGate.acquire();
const rejectedOnClose = closeGate.acquire();
closeGate.close();
await assert.rejects(rejectedOnClose, /request gate is closed/);
releaseCloseBlocker();

function memoryUsage(heapUsed: number): NodeJS.MemoryUsage {
  return {
    rss: heapUsed * 2,
    heapTotal: heapUsed,
    heapUsed,
    external: 123,
    arrayBuffers: 45,
  };
}

let used = 50;
const memoryGuard = new MemoryGuard({
  softLimitRatio: 0.6,
  hardLimitRatio: 0.75,
  memoryUsage: () => memoryUsage(used),
  heapLimit: () => 100,
});
assert.equal(memoryGuard.snapshot().level, "normal");
used = 60;
assert.equal(memoryGuard.snapshot().level, "soft");
used = 75;
const hard = memoryGuard.snapshot();
assert.equal(hard.level, "hard");
assert.equal(hard.heapRatio, 0.75);
assert.equal(hard.external, 123);

assert.throws(
  () => new MemoryGuard({ softLimitRatio: 0.8, hardLimitRatio: 0.7 }),
  /0 < soft < hard < 1/,
);
