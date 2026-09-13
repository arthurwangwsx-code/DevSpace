import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityError } from "../errors.js";
import { parseMcpProviderManifest } from "../mcp-provider-manifest.js";
import type { ProviderContext, ProviderLease } from "../provider.js";
import { ChromeDevToolsDaemonClient } from "./chrome-devtools-daemon-client.js";
import {
  ChromeDevToolsProvider,
  createChromeDevToolsManifest,
  findChromeDevToolsMcpCommand,
} from "./chrome-devtools-provider.js";

const generated = createChromeDevToolsManifest(process.execPath);
assert.equal(generated.metadata.id, "browser.chrome.devtools");
assert.deepEqual(generated.spec.transport, {
  type: "stdio",
  command: process.execPath,
  args: [
    "start",
    "--autoConnect",
    "--no-category-extensions",
    "--no-memory-debugging",
    "--no-performance-crux",
    "--no-usage-statistics",
    "--redactNetworkHeaders",
  ],
  envFrom: {},
});
assert.equal(generated.spec.tools.length, 9);
assert.equal(generated.spec.tools[0]!.requiresLease, false);
assert.equal(generated.spec.tools[1]!.requiresLease, true);
assert.equal(generated.spec.tools[1]!.availability.requiresUnlocked, false);
assert.equal(generated.spec.tools[0]!.defaultTimeoutMs, 60_000);
assert.equal(findChromeDevToolsMcpCommand({ DEVSPACE_CHROME_MCP_COMMAND: process.execPath }), process.execPath);
assert.throws(() => findChromeDevToolsMcpCommand({ PATH: "" }), /not found on PATH/);

const fixture = fileURLToPath(new URL("../../../test-fixtures/fake-chrome-devtools-mcp.ts", import.meta.url));
const manifest = parseMcpProviderManifest({
  ...generated,
  spec: {
    ...generated.spec,
    transport: { type: "stdio", command: process.execPath, args: ["--import", "tsx", fixture] },
  },
});
const provider = new ChromeDevToolsProvider(manifest);
await provider.start(context());
try {
  const discovered = await provider.discover(new AbortController().signal);
  assert.deepEqual(discovered.map(({ descriptor }) => descriptor.id), [
    "browser.chrome.list_pages",
    "browser.chrome.take_snapshot",
    "browser.chrome.take_screenshot",
    "browser.chrome.list_console_messages",
    "browser.chrome.list_network_requests",
    "browser.chrome.navigate",
    "browser.chrome.click",
    "browser.chrome.type_text",
    "browser.chrome.press_key",
  ]);
  const snapshot = discovered[1]!;
  assert.deepEqual(snapshot.descriptor.execution.resourceTypes, ["browser_page"]);
  await assert.rejects(provider.open({ resourceType: "browser_page", selector: { pageId: -1 } }, signal()), /non-negative/);
  const lease0 = await provider.open({ resourceType: "browser_page", selector: { pageId: 0 } }, signal());
  const lease1 = await provider.open({ resourceType: "browser_page", selector: { pageId: 1 } }, signal());
  assert.deepEqual(lease0.display, { pageId: 0, origin: "https://zero.fixture.test" });
  assert.deepEqual(lease1.display, { pageId: 1, origin: "https://one.fixture.test" });
  const [page0, page1] = await Promise.all([
    invoke(provider, snapshot, lease0),
    invoke(provider, snapshot, lease1),
  ]);
  assert.deepEqual(page0, { tool: "take_snapshot", selectedPage: 0 });
  assert.deepEqual(page1, { tool: "take_snapshot", selectedPage: 1 });
  const typed = discovered.find(({ descriptor }) => descriptor.id === "browser.chrome.type_text")!;
  assert.equal(typed.descriptor.effects.readOnly, false);
  assert.deepEqual(await provider.invoke({
    capabilityId: typed.descriptor.id,
    descriptor: typed.descriptor,
    binding: typed.binding,
    arguments: { text: "fixture" },
    lease: lease1,
  }, signal()), { tool: "type_text", selectedPage: 1 });
  await assert.rejects(invoke(provider, snapshot), (error) => error instanceof CapabilityError && error.code === "lease_required");
} finally {
  await provider.stop("test_complete");
}

const daemonRoot = mkdtempSync(join(tmpdir(), "devspace-chrome-daemon-test-"));
const daemonSocket = join(daemonRoot, "daemon.sock");
const daemonCalls: Array<{ method: string; tool?: string; args?: Record<string, unknown> }> = [];
let releaseSlowCall: (() => void) | undefined;
const fakeDaemon = createNetServer((socket) => {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const boundary = pending.indexOf(0);
    if (boundary === -1) return;
    const request = JSON.parse(pending.toString("utf8", 0, boundary));
    daemonCalls.push(request);
    const sendResult = () => {
      const result = request.method === "status"
      ? { success: true, result: JSON.stringify({ pid: process.pid, version: "fixture" }) }
      : { success: true, result: JSON.stringify({
        content: [{ type: "text", text: request.tool }],
        structuredContent: request.tool === "list_pages"
          ? { pages: [{ id: 23, url: "http://127.0.0.1:19080/path?secret=redacted" }] }
          : { tool: request.tool, arguments: request.args },
      }) };
      socket.end(`${JSON.stringify(result)}\0`);
    };
    if (request.tool === "slow_fixture") releaseSlowCall = sendResult;
    else sendResult();
  });
});
await new Promise<void>((resolve, reject) => {
  fakeDaemon.once("error", reject);
  fakeDaemon.listen(daemonSocket, resolve);
});
try {
  const daemonProvider = new ChromeDevToolsProvider(generated, {
    DEVSPACE_CHROME_DAEMON_SOCKET: daemonSocket,
  });
  await daemonProvider.start(context());
  const daemonCapabilities = await daemonProvider.discover(signal().signal);
  const daemonSnapshot = daemonCapabilities.find(({ descriptor }) =>
    descriptor.id === "browser.chrome.take_snapshot")!;
  assert.equal((daemonSnapshot.descriptor.inputSchema.properties as any)?.pageId, undefined);
  const daemonLease = await daemonProvider.open({
    resourceType: "browser_page",
    selector: { pageId: 23 },
  }, signal());
  assert.deepEqual(daemonLease.display, { pageId: 23, origin: "http://127.0.0.1:19080" });
  const daemonResult = await invoke(daemonProvider, daemonSnapshot, daemonLease);
  assert.deepEqual(daemonResult, {
    tool: "take_snapshot",
    arguments: { pageId: 23 },
  });
  assert.equal(daemonCalls.some(({ method, tool }) => method === "invoke_tool" && tool === "take_snapshot"), true);
  const daemonClient = new ChromeDevToolsDaemonClient(process.execPath, ["start"], {
    DEVSPACE_CHROME_DAEMON_SOCKET: daemonSocket,
  });
  const abortController = new AbortController();
  const slowCall = daemonClient.callTool("slow_fixture", {}, abortController.signal);
  await waitFor(() => daemonCalls.some(({ tool }) => tool === "slow_fixture"));
  abortController.abort();
  await assert.rejects(slowCall, (error) => error instanceof CapabilityError && error.code === "cancelled");
  const queuedCall = daemonClient.callTool("queued_fixture", {}, signal().signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(daemonCalls.some(({ tool }) => tool === "queued_fixture"), false);
  releaseSlowCall!();
  await queuedCall;
  assert.equal(daemonCalls.some(({ tool }) => tool === "queued_fixture"), true);
  const disconnectedCall = daemonClient.callTool("slow_fixture", {}, signal().signal);
  await waitFor(() => daemonCalls.filter(({ tool }) => tool === "slow_fixture").length === 2);
  daemonClient.disconnect();
  await assert.rejects(disconnectedCall, (error) =>
    error instanceof CapabilityError && error.code === "provider_unavailable");
  await daemonProvider.stop("test_complete");
  assert.equal(fakeDaemon.listening, true);
} finally {
  await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()));
  rmSync(daemonRoot, { recursive: true, force: true });
}

console.log("Chrome provider tests passed: persistent daemon reuse, legacy MCP, leases, serialized calls");

function context(): ProviderContext {
  return { signal: signal().signal, reportFailure: () => {}, reportCatalogChanged: () => {}, log: () => {} };
}
function signal(): { signal: AbortSignal } { return { signal: new AbortController().signal }; }
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture event.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function invoke(
  provider: ChromeDevToolsProvider,
  capability: Awaited<ReturnType<ChromeDevToolsProvider["discover"]>>[number],
  lease?: ProviderLease,
) {
  return provider.invoke({
    capabilityId: capability.descriptor.id,
    descriptor: capability.descriptor,
    binding: capability.binding,
    arguments: {},
    lease,
  }, signal());
}
