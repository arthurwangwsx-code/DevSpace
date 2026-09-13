import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { CapabilityError } from "./errors.js";
import { FakeCapabilityProvider, fakeDescriptor } from "./fake-provider.test-support.js";
import { CapabilityLeaseManager } from "./leases.js";
import { CapabilityRuntime } from "./runtime.js";
import type { CapabilityDescriptor, CapabilityPrincipal } from "./types.js";
import type { SessionState } from "./session-state.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-router-"));
const providerId = "test.fake.provider";
const echo: CapabilityDescriptor = {
  ...fakeDescriptor(providerId),
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: true,
  },
};
const page = {
  ...descriptor("test.fake.read_page", true, true),
  availability: {
    ...descriptor("test.fake.read_page", true, true).availability,
    requiresUnlocked: true,
  },
};
const mutate = descriptor("test.fake.type_text", false, true);
const provider = new FakeCapabilityProvider(providerId, [echo, page, mutate]);
const sessionState: SessionState = {
  awake: true,
  loggedIn: true,
  locked: false,
  consoleUser: "fixture",
  observedAt: new Date().toISOString(),
};
const runtime = new CapabilityRuntime({
  stateDir: root,
  router: {
    maxConcurrent: 1,
    maxConcurrentPerProvider: 1,
    queueLimit: 1,
    maxOutputBytes: 256,
    maxTimeoutMs: 5_000,
    sessionStateProbe: { async probe() { return { ...sessionState }; } },
  },
});
runtime.registerProvider({ provider, kind: "fake", enabled: true });

const principal = principalFor("principal-a");
const otherPrincipal = principalFor("principal-b");
runtime.policy.addGrant({
  id: "grant-echo",
  principalId: principal.id,
  capabilityPattern: "test.fake.echo",
  providerPattern: providerId,
  allowedEffects: ["readOnly"],
});
runtime.policy.addGrant({
  id: "grant-origin-denied",
  principalId: otherPrincipal.id,
  capabilityPattern: "test.fake.*",
  providerPattern: providerId,
  resourceType: "browser_page",
  allowedEffects: ["readOnly"],
  targetConstraints: { origins: ["https://allowed.test"] },
});
runtime.policy.addGrant({
  id: "grant-page",
  principalId: principal.id,
  capabilityPattern: "test.fake.*",
  providerPattern: providerId,
  resourceType: "browser_page",
  allowedEffects: ["readOnly", "mutation"],
});

try {
  await runtime.start();

  await assert.rejects(
    runtime.router.invoke(request("req-invalid", principal, echo.id, {})),
    isCapabilityError("invalid_arguments"),
  );
  await assert.rejects(
    runtime.router.invoke(request("req-denied", otherPrincipal, echo.id, { message: "denied" })),
    isCapabilityError("policy_denied"),
  );

  const first = await runtime.router.invoke({
    ...request("req-echo", principal, echo.id, { message: "very-private-value" }),
    idempotencyKey: "same-call",
  });
  assert.equal(first.status, "succeeded");
  assert.equal(provider.invokeCount, 1);
  const repeated = await runtime.router.invoke({
    ...request("req-echo-repeat", principal, echo.id, { message: "very-private-value" }),
    idempotencyKey: "same-call",
  });
  assert.equal(repeated.id, first.id);
  assert.equal(provider.invokeCount, 1);
  await assert.rejects(
    runtime.router.invoke({
      ...request("req-conflict", principal, echo.id, { message: "different" }),
      idempotencyKey: "same-call",
    }),
    isCapabilityError("conflict"),
  );

  const lease = await runtime.router.openLease({
    requestId: "req-open",
    principal,
    providerId,
    resourceType: "browser_page",
    selector: { label: "fixture", origin: "https://fixture.test" },
    ttlMs: 10_000,
  });
  assert.equal(runtime.leases.size, 1);
  await assert.rejects(runtime.router.openLease({
    requestId: "req-open-origin-denied",
    principal: otherPrincipal,
    providerId,
    resourceType: "browser_page",
    selector: { label: "fixture", origin: "https://denied.test" },
  }), isCapabilityError("policy_denied"));
  assert.throws(() => runtime.leases.get(lease.id, otherPrincipal), isCapabilityError("policy_denied"));
  const pageResult = await runtime.router.invoke({
    ...request("req-page", principal, page.id, {}),
    leaseId: lease.id,
  });
  assert.equal(pageResult.status, "succeeded");
  await assert.rejects(
    runtime.router.invoke({
      ...request("req-secure", principal, mutate.id, {
        inputType: "password",
        text: "do-not-type",
      }),
      leaseId: lease.id,
    }),
    isCapabilityError("policy_denied"),
  );

  const barrier = deferred();
  provider.invokeBarrier = barrier.promise;
  const running = await runtime.router.invoke({
    ...request("req-running", principal, echo.id, { message: "running" }),
    mode: "async",
  });
  const queued = await runtime.router.invoke({
    ...request("req-queued", principal, echo.id, { message: "queued" }),
    mode: "async",
  });
  assert.equal(running.status, "running");
  assert.equal(queued.status, "queued");
  await assert.rejects(
    runtime.router.invoke({
      ...request("req-overflow", principal, echo.id, { message: "overflow" }),
      mode: "async",
    }),
    isCapabilityError("rate_limited"),
  );
  assert.equal(runtime.router.cancelInvocation({
    requestId: "req-cancel-queued",
    invocationId: queued.id,
    principal,
  }).status, "cancelled");
  runtime.router.cancelInvocation({
    requestId: "req-cancel-running",
    invocationId: running.id,
    principal,
  });
  await waitFor(() => runtime.router.getInvocation(running.id, principal).status === "cancelled");
  barrier.resolve();
  provider.invokeBarrier = undefined;

  const timeoutBarrier = deferred();
  provider.invokeBarrier = timeoutBarrier.promise;
  await assert.rejects(
    runtime.router.invoke({
      ...request("req-timeout", principal, echo.id, { message: "timeout" }),
      timeoutMs: 10,
    }),
    isCapabilityError("timeout"),
  );
  timeoutBarrier.resolve();
  provider.invokeBarrier = undefined;

  provider.invokeResult = { blob: "x".repeat(500) };
  await assert.rejects(
    runtime.router.invoke(request("req-output", principal, echo.id, { message: "large" })),
    isCapabilityError("output_too_large"),
  );
  provider.invokeResult = undefined;

  sessionState.locked = true;
  await assert.rejects(
    runtime.router.invoke({
      ...request("req-locked", principal, page.id, {}),
      leaseId: lease.id,
    }),
    isCapabilityError("temporarily_unavailable"),
  );
  await assert.rejects(
    runtime.router.openLease({
      requestId: "req-open-locked",
      principal,
      providerId,
      resourceType: "browser_page",
      selector: { label: "locked" },
    }),
    isCapabilityError("temporarily_unavailable"),
  );
  sessionState.locked = false;

  await runtime.router.closeLease({ requestId: "req-close", principal, leaseId: lease.id });
  assert.equal(runtime.leases.size, 0);
  assert.equal(provider.closeCount, 2);

  const database = openDatabase(root);
  try {
    const rows = database.sqlite.prepare(`
      select arguments_digest, result_digest, error_code from capability_invocations
    `).all() as Array<Record<string, string | null>>;
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((row) => typeof row.arguments_digest === "string"));
    const rawInvocations = JSON.stringify(rows);
    const rawEvents = JSON.stringify(database.sqlite
      .prepare("select redacted_summary_json from capability_audit_events").all());
    assert.doesNotMatch(rawInvocations, /very-private-value|do-not-type/);
    assert.doesNotMatch(rawEvents, /very-private-value|do-not-type/);
  } finally {
    database.close();
  }
} finally {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
}

let now = 1_000;
const leaseManager = new CapabilityLeaseManager(() => now, 1_000, 2_000);
const expiring = leaseManager.create({
  principal,
  providerId,
  resourceType: "browser_page",
  providerLease: { handle: {}, display: {} },
});
now = 2_001;
assert.throws(() => leaseManager.get(expiring.id, principal), isCapabilityError("lease_expired"));

const boundedRoot = mkdtempSync(join(tmpdir(), "devspace-capability-history-bound-"));
const boundedProvider = new FakeCapabilityProvider(providerId, [echo]);
const boundedRuntime = new CapabilityRuntime({
  stateDir: boundedRoot,
  router: { maxTrackedInvocations: 3, invocationRetentionMs: 60_000 },
});
boundedRuntime.registerProvider({ provider: boundedProvider, kind: "fake", enabled: true });
boundedRuntime.policy.addGrant({
  id: "bounded-grant",
  principalId: principal.id,
  capabilityPattern: echo.id,
  providerPattern: providerId,
  allowedEffects: ["readOnly"],
});
try {
  await boundedRuntime.start();
  const oldest = await boundedRuntime.router.invoke({
    ...request("bounded-0", principal, echo.id, { message: "0" }),
    idempotencyKey: "evicted-key",
  });
  for (let index = 1; index <= 3; index++) {
    await boundedRuntime.router.invoke(request(
      `bounded-${index}`,
      principal,
      echo.id,
      { message: String(index) },
    ));
  }
  assert.equal(boundedRuntime.router.stats.trackedInvocations, 3);
  assert.throws(
    () => boundedRuntime.router.getInvocation(oldest.id, principal),
    isCapabilityError("capability_not_found"),
  );
  const afterEviction = await boundedRuntime.router.invoke({
    ...request("bounded-reuse", principal, echo.id, { message: "0" }),
    idempotencyKey: "evicted-key",
  });
  assert.notEqual(afterEviction.id, oldest.id);
  assert.equal(boundedRuntime.router.stats.trackedInvocations, 3);
} finally {
  await boundedRuntime.close();
  rmSync(boundedRoot, { recursive: true, force: true });
}

console.log("capability router tests passed: policy, leases, queue, cancel, timeout, audit, bounded history");

function descriptor(id: string, readOnly: boolean, requiresLease: boolean): CapabilityDescriptor {
  return {
    ...fakeDescriptor(providerId),
    id,
    inputSchema: { type: "object", additionalProperties: true },
    effects: {
      readOnly,
      destructive: false,
      idempotent: readOnly,
      openWorld: false,
    },
    execution: {
      modes: ["sync", "async"],
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 5_000,
      requiresLease,
      resourceTypes: requiresLease ? ["browser_page"] : [],
    },
  };
}

function principalFor(id: string): CapabilityPrincipal {
  return {
    id,
    kind: "test",
    resource: "https://fixture.test/capabilities/mcp",
    scopes: ["capabilities:discover", "capabilities:invoke"],
  };
}

function request(
  requestId: string,
  requestPrincipal: CapabilityPrincipal,
  capabilityId: string,
  argumentsValue: Record<string, string>,
) {
  return { requestId, principal: requestPrincipal, capabilityId, arguments: argumentsValue };
}

function isCapabilityError(code: string) {
  return (error: unknown) => error instanceof CapabilityError && error.code === code;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for invocation state.");
}
