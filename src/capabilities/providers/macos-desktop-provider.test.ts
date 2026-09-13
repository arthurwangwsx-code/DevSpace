import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CapabilityError } from "../errors.js";
import { parseMcpProviderManifest } from "../mcp-provider-manifest.js";
import type { ProviderContext } from "../provider.js";
import { createMacosDesktopManifest, MacosDesktopProvider } from "./macos-desktop-provider.js";

assert.throws(() => createMacosDesktopManifest(process.execPath, "linux"), /requires macOS/);
const generated = createMacosDesktopManifest(process.execPath, "darwin");
assert.equal(generated.metadata.id, "desktop.macos.accessibility");
assert.equal(generated.spec.tools.length, 14);
const generatedById = new Map(generated.spec.tools.map((tool) => [tool.capabilityId, tool]));
assert.equal(generatedById.get("desktop.macos.list_windows")!.requiresLease, true);
assert.equal(generatedById.get("desktop.macos.list_windows")!.permissions.length, 0);
assert.equal(generatedById.get("desktop.macos.snapshot_app")!.version, "2.0.0");
assert.equal(generatedById.get("desktop.macos.screenshot_window")!.effects.readOnly, true);
assert.equal(generatedById.get("desktop.macos.screenshot_window")!.permissions[0]!.id, "macos.screen-capture");
assert.equal(generatedById.get("desktop.macos.click_element")!.effects.readOnly, false);

const fixture = fileURLToPath(new URL("../../../test-fixtures/fake-desktop-helper-mcp.ts", import.meta.url));
const manifest = parseMcpProviderManifest({
  ...generated,
  spec: {
    ...generated.spec,
    transport: { type: "stdio", command: process.execPath, args: ["--import", "tsx", fixture] },
  },
});
const provider = new MacosDesktopProvider(manifest);
await provider.start(context());
try {
  assert.equal((await provider.health(new AbortController().signal)).state, "ready");
  const discovered = await provider.discover(new AbortController().signal);
  const lease = await provider.open({
    resourceType: "app_window",
    selector: { bundleId: "com.example.fixture" },
  }, signal());
  assert.deepEqual(lease.display, { bundleId: "com.example.fixture", processId: 4242, name: "Fixture" });
  const snapshot = discovered.find(({ descriptor }) => descriptor.id === "desktop.macos.snapshot_app")!;
  assert.deepEqual(await provider.invoke({
    capabilityId: snapshot.descriptor.id,
    descriptor: snapshot.descriptor,
    binding: snapshot.binding,
    arguments: { maxDepth: 2 },
    lease,
  }, signal()), {
    tool: "snapshot",
    bundleId: "com.example.fixture",
    processId: 4242,
    snapshotId: "fixture-snapshot",
  });
  const listWindows = discovered.find(({ descriptor }) => descriptor.id === "desktop.macos.list_windows")!;
  assert.deepEqual(await provider.invoke({
    capabilityId: listWindows.descriptor.id,
    descriptor: listWindows.descriptor,
    binding: listWindows.binding,
    arguments: {},
    lease,
  }, signal()), {
    bundleId: "com.example.fixture",
    processId: 4242,
    windows: [{ windowId: 77, frame: { x: 10, y: 20, width: 400, height: 300 } }],
  });
  const screenshot = discovered.find(({ descriptor }) => descriptor.id === "desktop.macos.screenshot_app")!;
  assert.deepEqual(await provider.invoke({
    capabilityId: screenshot.descriptor.id,
    descriptor: screenshot.descriptor,
    binding: screenshot.binding,
    arguments: { maxWidth: 800 },
    lease,
  }, signal()), {
    tool: "screenshot",
    bundleId: "com.example.fixture",
    processId: 4242,
    mimeType: "image/png",
    data: "fixture",
  });
  await assert.rejects(provider.invoke({
    capabilityId: snapshot.descriptor.id,
    descriptor: snapshot.descriptor,
    binding: snapshot.binding,
    arguments: { bundleId: "com.example.other" },
    lease,
  }, signal()), (error) => error instanceof CapabilityError && error.code === "policy_denied");
  await assert.rejects(provider.invoke({
    capabilityId: snapshot.descriptor.id,
    descriptor: snapshot.descriptor,
    binding: snapshot.binding,
    arguments: { processId: 9999 },
    lease,
  }, signal()), (error) => error instanceof CapabilityError && error.code === "policy_denied");
  await assert.rejects(provider.invoke({
    capabilityId: snapshot.descriptor.id,
    descriptor: snapshot.descriptor,
    binding: snapshot.binding,
    arguments: {},
    lease: { handle: { bundleId: "com.example.fixture", processId: 9999 }, display: {} },
  }, signal()), (error) => error instanceof CapabilityError && error.code === "lease_expired");
} finally {
  await provider.stop("test_complete");
}

const deniedManifest = parseMcpProviderManifest({
  ...generated,
  spec: {
    ...generated.spec,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture, "--permissions-denied"],
    },
  },
});
const deniedProvider = new MacosDesktopProvider(deniedManifest);
await deniedProvider.start(context());
try {
  assert.deepEqual(await deniedProvider.health(new AbortController().signal), {
    state: "degraded",
    since: (await deniedProvider.health(new AbortController().signal)).since,
    reasonCode: "permission_required",
    unavailablePermissions: ["macos.accessibility", "macos.screen-capture"],
    userAction: "Grant macos.accessibility and macos.screen-capture to the installed DevSpace desktop host.",
  });
} finally {
  await deniedProvider.stop("test_complete");
}

console.log("macOS desktop provider tests passed: permission health, process-bound lease, target injection and stale denial");

function context(): ProviderContext {
  return { signal: signal().signal, reportFailure: () => {}, reportCatalogChanged: () => {}, log: () => {} };
}
function signal(): { signal: AbortSignal } { return { signal: new AbortController().signal }; }
