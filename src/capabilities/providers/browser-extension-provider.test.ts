import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "../registry.js";
import { BrowserExtensionProvider, browserExtensionShouldEnable } from "./browser-extension-provider.js";

const root = await mkdtemp(join(os.tmpdir(), "devspace-browser-provider-"));
const uploadFile = join(root, "upload.txt");
await writeFile(uploadFile, "fixture\n");
const autoManifest = join(root, "native-host.json");
await writeFile(autoManifest, "{}\n");
assert.equal(browserExtensionShouldEnable({ DEVSPACE_CHROME_NATIVE_HOST_MANIFEST: autoManifest }), true);
assert.equal(browserExtensionShouldEnable({ DEVSPACE_BROWSER_EXTENSION: "0", DEVSPACE_CHROME_NATIVE_HOST_MANIFEST: autoManifest }), false);
const socketPath = join(root, "bridge.sock");
const provider = new BrowserExtensionProvider({
  ...process.env,
  DEVSPACE_BROWSER_SOCKET: socketPath,
});
const lifetime = new AbortController();
await provider.start({
  signal: lifetime.signal,
  reportFailure() {},
  reportCatalogChanged() {},
  log() {},
});
assert.equal((await provider.health(lifetime.signal)).state, "ready");

const extension = net.createConnection(socketPath);
await new Promise<void>((resolve, reject) => {
  extension.once("connect", resolve);
  extension.once("error", reject);
});
extension.write(JSON.stringify({
  protocol: 1,
  event: "profile_hello",
  profile: { profileId: "profile-test", focused: true, extensionVersion: "0.2.0" },
}) + "\n");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal((await provider.health(lifetime.signal)).state, "ready");

const seen: Array<{ command: string; params: Record<string, unknown> }> = [];
let input = "";
extension.setEncoding("utf8");
extension.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline)) as {
      id: string;
      command: string;
      params: Record<string, unknown>;
    };
    input = input.slice(newline + 1);
    seen.push({ command: request.command, params: request.params });
    const result = request.command === "use_tab"
      ? { tabId: request.params.tabId, ownership: request.params.tabId === 8 ? "agent" : "adopted" }
      : request.command === "snapshot"
        ? { title: "fixture" }
        : { ok: true };
    extension.write(JSON.stringify({ protocol: 1, id: request.id, ok: true, result }) + "\n");
  }
});

const capabilities = await provider.discover(lifetime.signal);
assert.equal(capabilities.length, 27);
assert.equal(capabilities.every(({ descriptor }) => descriptor.id.startsWith("browser.")), true);
assert.equal(capabilities.some(({ descriptor }) => descriptor.id.includes(".extension.")), false);
assert.equal(capabilities.some(({ descriptor }) => descriptor.id.includes(".chrome.")), false);
assert.equal(capabilities.every(({ descriptor }) => descriptor.providerId === "browser.control"), true);
const registry = new CapabilityRegistry();
registry.replaceProviderCatalog({
  providerId: "browser.control",
  kind: "native:browser-control",
  health: { state: "ready", since: new Date().toISOString() },
  capabilities: capabilities.map(({ descriptor, aliases }) => ({
    descriptor,
    aliases,
    binding: { invoke: async () => ({ ok: true }) },
  })),
});
assert.equal(registry.capabilityCountForProvider("browser.control"), 27);
const byId = new Map(capabilities.map((entry) => [entry.descriptor.id, entry]));
const profiles = byId.get("browser.profile.list")!;
assert.deepEqual(await provider.invoke({
  capabilityId: profiles.descriptor.id,
  descriptor: profiles.descriptor,
  binding: profiles.binding,
  arguments: {},
}, { signal: lifetime.signal }), {
  profiles: [{ profileId: "profile-test", focused: true, extensionVersion: "0.2.0" }],
});
assert.ok(byId.get("browser.page.snapshot")?.aliases?.includes("browser.chrome.take_snapshot"));
assert.ok(byId.get("browser.page.snapshot")?.aliases?.includes("browser.extension.snapshot"));
assert.equal(byId.get("browser.page.evaluate")?.descriptor.effects.openWorld, true);
assert.ok(byId.get("browser.file.upload"));
assert.ok(byId.get("browser.file.download_status"));
assert.ok(byId.get("browser.file.wait_download"));
assert.equal(byId.get("browser.page.click")?.descriptor.metadata?.domain, "browser");
assert.equal(byId.get("browser.page.click")?.descriptor.metadata?.resource, "page");
assert.equal(byId.get("browser.page.click")?.descriptor.metadata?.action, "click");
const invocationContext = { signal: lifetime.signal };
const list = byId.get("browser.tab.list")!;
await provider.invoke({
  capabilityId: list.descriptor.id,
  descriptor: list.descriptor,
  binding: list.binding,
  arguments: {},
}, invocationContext);
assert.deepEqual(seen.at(-1), {
  command: "list_tabs",
  params: { clientId: "devspace", all: true },
});

const lease = await provider.open({ resourceType: "browser_page", selector: { tabId: 7, profileId: "profile-test" } }, invocationContext);
assert.deepEqual(lease.handle, { tabId: 7, profileId: "profile-test" });
assert.equal(lease.display.ownership, "adopted");
const snapshot = byId.get("browser.page.snapshot")!;
const upload = byId.get("browser.file.upload")!;
await assert.rejects(
  provider.invoke({
    capabilityId: snapshot.descriptor.id,
    descriptor: snapshot.descriptor,
    binding: snapshot.binding,
    arguments: {},
  }, invocationContext),
  (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "lease_required"),
);
await provider.invoke({
  capabilityId: upload.descriptor.id,
  descriptor: upload.descriptor,
  binding: upload.binding,
  arguments: { index: 1, files: [process.execPath] },
  lease,
}, invocationContext);
assert.deepEqual(seen.at(-1), {
  command: "set_input_files",
  params: { clientId: "devspace", tabId: 7, files: [realpathSync(process.execPath)], index: 1 },
});
assert.deepEqual(await provider.invoke({
  capabilityId: snapshot.descriptor.id,
  descriptor: snapshot.descriptor,
  binding: snapshot.binding,
  arguments: {},
  lease,
}, invocationContext), { title: "fixture" });
assert.deepEqual(seen.at(-1), {
  command: "snapshot",
  params: { clientId: "devspace", tabId: 7 },
});
await provider.invoke({
  capabilityId: upload.descriptor.id,
  descriptor: upload.descriptor,
  binding: upload.binding,
  arguments: { index: 1, files: [uploadFile] },
  lease,
}, invocationContext);
assert.deepEqual(seen.at(-1), {
  command: "set_input_files",
  params: { clientId: "devspace", index: 1, files: [realpathSync(uploadFile)], tabId: 7 },
});
await assert.rejects(
  provider.invoke({
    capabilityId: upload.descriptor.id,
    descriptor: upload.descriptor,
    binding: upload.binding,
    arguments: { index: 1, files: ["relative.txt"] },
    lease,
  }, invocationContext),
  (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "invalid_arguments"),
);
await provider.close(lease, invocationContext);
assert.equal(seen.at(-1)?.command, "release_tab");

const agentLease = await provider.open({ resourceType: "browser_page", selector: { tabId: 8, profileId: "profile-test" } }, invocationContext);
assert.equal(agentLease.display.ownership, "agent");
await provider.close(agentLease, invocationContext);
assert.equal(seen.at(-1)?.command, "close_tab");

extension.destroy();
await provider.stop("test complete");
await rm(root, { recursive: true, force: true });
console.log("browser extension provider tests passed: discovery, lease routing, adopted release, agent cleanup");
