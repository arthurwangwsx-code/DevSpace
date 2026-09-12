import assert from "node:assert/strict";
import { LatencyHistogram, StressMetrics } from "./metrics.js";

const histogram = new LatencyHistogram(100);
for (const value of [1, 2, 3, 4, 100, 500]) histogram.record(value);
histogram.recordError();
assert.deepEqual(histogram.summary(), {
  count: 6,
  errors: 1,
  minMs: 1,
  meanMs: 101.67,
  p50Ms: 3,
  p95Ms: 101,
  p99Ms: 101,
  maxMs: 500,
});

const metrics = new StressMetrics();
assert.equal(await metrics.measure("ok", async () => 42), 42);
await assert.rejects(metrics.measure("failed", async () => {
  throw new Error("HTTP 503 queue full");
}));
assert.equal(metrics.report().operations.ok?.count, 1);
assert.equal(metrics.report().operations.failed?.errors, 1);
assert.equal(metrics.report().failures.overloaded, 1);
