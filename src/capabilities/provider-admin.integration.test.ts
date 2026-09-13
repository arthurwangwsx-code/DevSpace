import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";

const root = mkdtempSync(join(tmpdir(), "devspace-provider-admin-test-"));
const providerDirectory = join(root, "providers");
const fixturePath = fileURLToPath(new URL("../../test-fixtures/fake-downstream-mcp.ts", import.meta.url));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "provider-admin-owner-token-long-enough",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_CAPABILITY_CONFIG_DIR: providerDirectory,
  DEVSPACE_LOG_LEVEL: "silent",
});
const running = createServer(config);
const server = running.app.listen(0, "127.0.0.1");
let client: Client | undefined;

try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/capabilities/v1`;
  client = new Client({ name: "provider-admin-integration", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/capabilities/mcp`)));
  assert.equal((await client.listTools()).tools.length, 8);

  const searched = await client.callTool({
    name: "capability_search",
    arguments: { query: "install MCP provider", availableOnly: true },
  });
  assert.match(JSON.stringify(searched.structuredContent), /devspace\.providers\.install/);

  const manifest = {
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: "test.dynamic.mcp", title: "Dynamic fixture" },
    spec: {
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", fixturePath],
      },
      tools: [{
        tool: "echo",
        capabilityId: "test.dynamic.echo",
        effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      }],
    },
  };
  const installed = await invokeManagement(client, "devspace.providers.install", { manifest });
  assert.equal(installed.status, "succeeded");
  assert.equal((installed.result as any).providerId, "test.dynamic.mcp");
  assert.equal((installed.result as any).health.state, "ready");
  assert.equal(existsSync(join(providerDirectory, "test.dynamic.mcp.json")), true);

  const afterInstall = await getJson(`${base}/capabilities?providerId=test.dynamic.mcp`);
  assert.equal(afterInstall.body.data.items[0].id, "test.dynamic.echo");
  const installedRevision = afterInstall.body.meta.catalogRevision;

  const disabled = await postJson(`${base}/admin/providers/test.dynamic.mcp/actions`, { action: "disable" });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body.data.enabled, false);
  const afterDisable = await getJson(`${base}/capabilities?providerId=test.dynamic.mcp`);
  assert.deepEqual(afterDisable.body.data.items, []);
  assert.ok(afterDisable.body.meta.catalogRevision > installedRevision);

  const enabled = await invokeManagement(client, "devspace.providers.control", {
    providerId: "test.dynamic.mcp",
    action: "enable",
  });
  assert.equal((enabled.result as any).health.state, "ready");
  const reloaded = await invokeManagement(client, "devspace.providers.control", {
    providerId: "test.dynamic.mcp",
    action: "reload",
  });
  assert.equal((reloaded.result as any).health.state, "ready");

  const configured = await getJson(`${base}/admin/providers`);
  assert.equal(configured.body.data.providers[0].id, "test.dynamic.mcp");
  const removed = await invokeManagement(client, "devspace.providers.remove", {
    providerId: "test.dynamic.mcp",
  });
  assert.equal((removed.result as any).recoverable, true);
  assert.equal(existsSync(join(providerDirectory, "test.dynamic.mcp.json")), false);
  assert.equal(existsSync((removed.result as any).archivedPath), true);
  const finalProviders = await getJson(`${base}/providers`);
  assert.equal(finalProviders.body.data.items.some((item: any) => item.id === "test.dynamic.mcp"), false);

  console.log("provider admin integration passed: fixed MCP install, REST disable, MCP enable/reload/remove, catalog revisions");
} finally {
  await client?.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running.close();
  rmSync(root, { recursive: true, force: true });
}

async function invokeManagement(clientValue: Client, capabilityId: string, argumentsValue: unknown) {
  const response = await clientValue.callTool({
    name: "capability_invoke",
    arguments: { capabilityId, arguments: argumentsValue },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return (response.structuredContent as any).data;
}

async function getJson(url: string) {
  const response = await fetch(url);
  return { response, body: await response.json() as any };
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}
