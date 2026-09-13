import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { FakeCapabilityProvider, fakeDescriptor } from "../capabilities/fake-provider.test-support.js";
import type { ProviderInvocation, ProviderInvocationContext } from "../capabilities/provider.js";
import type { CapabilityDescriptor, JsonValue } from "../capabilities/types.js";
import { createServer } from "../server.js";
import { runCapabilityStressWorkload } from "./capability-runner.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-runner-test-"));
const providerId = "test.stress.provider";
const capability = (id: string, title: string): CapabilityDescriptor => ({
  ...fakeDescriptor(providerId),
  id,
  title,
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
});

class CapabilityStressTestProvider extends FakeCapabilityProvider {
  constructor() {
    super(providerId, [
      capability("test.stress.echo", "Echo"),
      capability("test.stress.delay", "Delay"),
      capability("test.stress.large", "Large"),
      capability("test.stress.crash", "Crash"),
    ]);
  }

  override async invoke(
    request: ProviderInvocation,
    context: ProviderInvocationContext,
  ): Promise<JsonValue> {
    if (context.signal.aborted) throw context.signal.reason;
    const value = typeof (request.arguments as any)?.value === "string"
      ? (request.arguments as any).value
      : "";
    return { echoed: value };
  }
}

try {
  const provider = new CapabilityStressTestProvider();
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "capability-runner-test-owner-token",
    DEVSPACE_AUTH_MODE: "trusted-local",
    DEVSPACE_CAPABILITIES: "1",
    DEVSPACE_LOG_LEVEL: "silent",
  });
  const running = createServer(config, {
    capabilityProviders: [{
      provider,
      kind: "test",
      enabled: true,
      manifestDigest: "capability-stress-test",
    }],
  });
  const server = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await running.capabilityRuntime!.start();
    running.capabilityRuntime!.policy.addGrant({
      id: "capability-stress-test-grant",
      principalId: `local:${process.getuid?.() ?? "user"}`,
      capabilityPattern: "test.stress.*",
      providerPattern: providerId,
      allowedEffects: ["readOnly"],
    });
    const port = (server.address() as AddressInfo).port;
    const report = await runCapabilityStressWorkload({
      restUrl: `http://127.0.0.1:${port}/api/capabilities/v1`,
      mcpUrl: `http://127.0.0.1:${port}/capabilities/mcp`,
      providerId,
      echoCapabilityId: "test.stress.echo",
      delayCapabilityId: "test.stress.delay",
      largeOutputCapabilityId: "test.stress.large",
      crashCapabilityId: "test.stress.crash",
      concurrency: 2,
      operationsPerClient: 4,
      churnSessions: 2,
      discoveryP95TargetMs: 1_000,
      invocationP95TargetMs: 1_000,
      runFaultInjection: false,
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.totals.completedInvocations, 8);
    assert.equal(report.metrics.operations.rest_invoke?.count, 4);
    assert.equal(report.metrics.operations.mcp_invoke?.count, 4);
    assert.equal(report.finalRuntimeStats.active, 0);
    assert.equal(report.finalRuntimeStats.queued, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await running.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
