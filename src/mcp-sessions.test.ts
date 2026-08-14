import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

async function register(
  registry: McpSessionRegistry<FakeTransport>,
  sessionId: string,
  transport: FakeTransport,
) {
  const reserved = await registry.reserve();
  assert.ok(reserved.reservation);
  const lease = reserved.reservation.commit(sessionId, transport);
  await lease.release();
}

let now = 0;
const registry = new McpSessionRegistry<FakeTransport>({
  now: () => now,
  maxSessions: 3,
  maxIdleSessions: 2,
  closeConcurrency: 2,
});
const staleTransport = createTransport();
const activeTransport = createTransport();

await register(registry, "stale", staleTransport);
now = 1_000;
await register(registry, "active", activeTransport);
const activeLease = registry.acquire("active");
assert.ok(activeLease);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.deepEqual(registry.stats, {
  total: 1,
  active: 1,
  idle: 0,
  reserved: 0,
  maxSessions: 3,
  maxIdleSessions: 2,
});
await activeLease.release();

const closeError = new Error("close failed");
const failingTransport = createTransport(closeError);
now = 3_000;
await register(registry, "failing", failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.stats.total, 0);

// Releasing a third session must enforce the idle LRU bound immediately.
const first = createTransport();
const second = createTransport();
const third = createTransport();
now = 20_000;
await register(registry, "first", first);
now = 20_001;
await register(registry, "second", second);
now = 20_002;
await register(registry, "third", third);
assert.equal(first.closeCalls, 1);
assert.equal(registry.stats.idle, 2);

// Active leases cannot be evicted to admit new sessions.
const activeOnly = new McpSessionRegistry<FakeTransport>({
  maxSessions: 2,
  maxIdleSessions: 1,
});
const reservedOne = await activeOnly.reserve();
const reservedTwo = await activeOnly.reserve();
assert.ok(reservedOne.reservation);
assert.ok(reservedTwo.reservation);
const leaseOne = reservedOne.reservation.commit("one", createTransport());
const leaseTwo = reservedTwo.reservation.commit("two", createTransport());
const rejected = await activeOnly.reserve();
assert.equal(rejected.reservation, undefined);
assert.equal(activeOnly.stats.active, 2);
await leaseOne.release();

// Once an idle session exists, the next reservation evicts it but preserves
// the still-active session.
const admitted = await activeOnly.reserve();
assert.ok(admitted.reservation);
assert.deepEqual(admitted.closeResults, [{ sessionId: "one" }]);
admitted.reservation.cancel();
await leaseTwo.release();
await activeOnly.closeAll();

// A reservation itself counts against the hard cap before any async work can
// interleave, preventing initialize bursts from oversubscribing capacity.
const reservationBound = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
  maxIdleSessions: 1,
});
const heldReservation = await reservationBound.reserve();
assert.ok(heldReservation.reservation);
assert.equal((await reservationBound.reserve()).reservation, undefined);
heldReservation.reservation.cancel();
const finalReservation = await reservationBound.reserve();
assert.ok(finalReservation.reservation);
finalReservation.reservation.cancel();

// A large churn run remains bounded and closes evicted transports.
const churn = new McpSessionRegistry<FakeTransport>({
  maxSessions: 32,
  maxIdleSessions: 16,
  closeConcurrency: 4,
});
const churnTransports: FakeTransport[] = [];
for (let index = 0; index < 5_000; index += 1) {
  const transport = createTransport();
  churnTransports.push(transport);
  await register(churn, `session-${index}`, transport);
  assert.ok(churn.stats.total <= 16);
}
assert.equal(churn.stats.total, 16);
assert.equal(churnTransports.filter((transport) => transport.closeCalls === 1).length, 4_984);
const shutdownResults = await churn.closeAll();
assert.equal(shutdownResults.length, 16);
assert.equal(churn.stats.total, 0);
assert.equal((await churn.reserve()).reservation, undefined);

const closingWithReservation = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
  maxIdleSessions: 1,
});
const reservationAtShutdown = await closingWithReservation.reserve();
assert.ok(reservationAtShutdown.reservation);
await closingWithReservation.closeAll();
assert.throws(
  () => reservationAtShutdown.reservation?.commit("late", createTransport()),
  /registry is closed/,
);
assert.equal(closingWithReservation.stats.reserved, 0);

assert.throws(
  () => new McpSessionRegistry({ maxSessions: 1, maxIdleSessions: 2 }),
  /no greater than maxSessions/,
);
