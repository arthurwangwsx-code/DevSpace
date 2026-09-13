import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityError } from "./errors.js";
import { FakeCapabilityProvider } from "./fake-provider.test-support.js";
import type { ProviderSupervisorScheduler } from "./provider-supervisor.js";
import { CapabilityRuntime } from "./runtime.js";

class ManualScheduler implements ProviderSupervisorScheduler {
  readonly tasks: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const task = { callback, delayMs, cancelled: false };
    this.tasks.push(task);
    return task;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  runNext(): number {
    const task = this.tasks.find((candidate) => !candidate.cancelled);
    assert.ok(task);
    task.cancelled = true;
    task.callback();
    return task.delayMs;
  }
}

const root = mkdtempSync(join(tmpdir(), "devspace-provider-supervisor-"));
const scheduler = new ManualScheduler();
const runtime = new CapabilityRuntime({
  stateDir: root,
  supervisor: {
    scheduler,
    random: () => 0,
    backoffBaseMs: 100,
    backoffMaxMs: 1_000,
    maxAttempts: 3,
  },
});
const provider = new FakeCapabilityProvider();
runtime.registerProvider({ provider, kind: "fake", enabled: true });

try {
  await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
  assert.equal(provider.startCount, 1);
  assert.equal(runtime.supervisor.getHealth(provider.id)?.state, "ready");
  assert.equal(runtime.registry.list({ availableOnly: true }).items.length, 1);
  assert.deepEqual(
    await runtime.registry.getBinding("test.fake.echo").invoke(
      { hello: "world" },
      { signal: new AbortController().signal },
    ),
    { capabilityId: "test.fake.echo", arguments: { hello: "world" } },
  );

  provider.crash();
  await waitFor(() => runtime.supervisor.getHealth(provider.id)?.state === "backoff");
  assert.equal(scheduler.tasks.length, 1);
  assert.equal(scheduler.runNext(), 100);
  await waitFor(() => runtime.supervisor.getHealth(provider.id)?.state === "ready");
  assert.equal(provider.startCount, 2);

  await runtime.close();
  assert.ok(provider.stopCount >= 2);
  assert.equal(scheduler.tasks.filter((task) => !task.cancelled).length, 0);
} finally {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
}

const permissionRoot = mkdtempSync(join(tmpdir(), "devspace-provider-permission-"));
const permissionRuntime = new CapabilityRuntime({ stateDir: permissionRoot });
const permissionProvider = new FakeCapabilityProvider();
permissionProvider.permissionRequired = true;
permissionRuntime.registerProvider({ provider: permissionProvider, kind: "fake", enabled: true });
try {
  await permissionRuntime.start();
  const permissionHealth = permissionRuntime.supervisor.getHealth(permissionProvider.id);
  assert.equal(permissionHealth?.state, "needs_user_action");
  assert.equal(permissionHealth?.reasonCode, "permission_required");
  assert.equal(permissionHealth?.userAction, "Approve the fake provider.");
  assert.equal(typeof permissionHealth?.since, "string");
} catch (error) {
  assert.fail(`Permission-required startup must not reject the runtime: ${String(error)}`);
} finally {
  await permissionRuntime.close();
  rmSync(permissionRoot, { recursive: true, force: true });
}

const disabledRoot = mkdtempSync(join(tmpdir(), "devspace-provider-disabled-"));
const disabledRuntime = new CapabilityRuntime({ stateDir: disabledRoot });
const disabledProvider = new FakeCapabilityProvider();
disabledRuntime.registerProvider({ provider: disabledProvider, kind: "fake", enabled: false });
try {
  await disabledRuntime.start();
  assert.equal(disabledProvider.startCount, 0);
  assert.equal(disabledRuntime.supervisor.getHealth(disabledProvider.id)?.state, "disabled");
  assert.throws(
    () => disabledRuntime.registry.getBinding("test.fake.echo"),
    (error) => error instanceof CapabilityError && error.code === "capability_not_found",
  );
} finally {
  await disabledRuntime.close();
  rmSync(disabledRoot, { recursive: true, force: true });
}

console.log("provider supervisor tests passed: singleton, crash recovery, permission, disabled, close");

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for provider state.");
}
