import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CapabilityError } from "../errors.js";
import { parseMcpProviderManifest } from "../mcp-provider-manifest.js";
import type { ProviderContext, ProviderLease } from "../provider.js";
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
  args: ["--autoConnect", "--no-category-extensions", "--no-performance-crux", "--no-usage-statistics"],
  envFrom: {},
});
assert.equal(generated.spec.tools.length, 5);
assert.equal(generated.spec.tools[0]!.requiresLease, false);
assert.equal(generated.spec.tools[1]!.requiresLease, true);
assert.equal(generated.spec.tools[1]!.availability.requiresUnlocked, true);
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
  ]);
  const snapshot = discovered[1]!;
  assert.deepEqual(snapshot.descriptor.execution.resourceTypes, ["browser_page"]);
  await assert.rejects(provider.open({ resourceType: "browser_page", selector: { pageId: -1 } }, signal()), /non-negative/);
  const lease0 = await provider.open({ resourceType: "browser_page", selector: { pageId: 0 } }, signal());
  const lease1 = await provider.open({ resourceType: "browser_page", selector: { pageId: 1 } }, signal());
  const [page0, page1] = await Promise.all([
    invoke(provider, snapshot, lease0),
    invoke(provider, snapshot, lease1),
  ]);
  assert.deepEqual(page0, { tool: "take_snapshot", selectedPage: 0 });
  assert.deepEqual(page1, { tool: "take_snapshot", selectedPage: 1 });
  await assert.rejects(invoke(provider, snapshot), (error) => error instanceof CapabilityError && error.code === "lease_required");
} finally {
  await provider.stop("test_complete");
}

console.log("Chrome provider tests passed: current-profile preset, fixed allowlist, lease selection, serialized calls");

function context(): ProviderContext {
  return { signal: signal().signal, reportFailure: () => {}, reportCatalogChanged: () => {}, log: () => {} };
}
function signal(): { signal: AbortSignal } { return { signal: new AbortController().signal }; }
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
