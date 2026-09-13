import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../config.js";
import { createServer } from "../../server.js";

const root = mkdtempSync(join(tmpdir(), "devspace-mounted-mcp-integration-"));
const providerDir = join(root, "providers");
mkdirSync(providerDir, { recursive: true });
const fixturePath = fileURLToPath(new URL("../../../test-fixtures/fake-downstream-mcp.ts", import.meta.url));
writeFileSync(join(providerDir, "fake.json"), JSON.stringify({
  apiVersion: "devspace.capabilities/v1",
  kind: "McpProvider",
  metadata: { id: "test.mounted.mcp" },
  spec: {
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixturePath],
    },
    tools: [{
      tool: "echo",
      capabilityId: "test.mounted.echo",
      effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    }],
  },
}, null, 2));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "mounted-mcp-owner-token-long-enough",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_CAPABILITY_CONFIG_DIR: providerDir,
  DEVSPACE_LOG_LEVEL: "silent",
});
const running = createServer(config);
const server = running.app.listen(0, "127.0.0.1");
let mcpClient: Client | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/capabilities/v1`;
  const catalogResponse = await fetch(`${base}/capabilities?availableOnly=true`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as any;
  assert.equal(catalog.data.items[0].id, "test.mounted.echo");
  assert.equal(running.capabilityRuntime!.supervisor.list()[0]!.kind, "mcp:stdio");

  running.capabilityRuntime!.policy.addGrant({
    id: "mounted-mcp-read",
    principalId: `local:${process.getuid?.() ?? "user"}`,
    capabilityPattern: "test.mounted.echo",
    providerPattern: "test.mounted.mcp",
    allowedEffects: ["readOnly"],
  });
  const invocationResponse = await fetch(`${base}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capabilityId: "test.mounted.echo",
      arguments: { message: "mounted" },
    }),
  });
  const invocation = await invocationResponse.json() as any;
  assert.equal(invocationResponse.status, 200, JSON.stringify(invocation));
  assert.equal(invocation.data.result.echoed, "mounted");

  mcpClient = new Client({ name: "mounted-bridge-test", version: "1.0.0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/capabilities/mcp`),
  ));
  const exposedCatalog = await mcpClient.callTool({
    name: "capability_list",
    arguments: { providerId: "test.mounted.mcp" },
  });
  assert.equal((exposedCatalog.structuredContent as any).data.items[0].id, "test.mounted.echo");
  const bridged = await mcpClient.callTool({
    name: "capability_invoke",
    arguments: { capabilityId: "test.mounted.echo", arguments: { message: "bridged" } },
  });
  assert.equal((bridged.structuredContent as any).data.result.echoed, "bridged");

  console.log("mounted MCP integration passed: manifest -> child -> catalog -> REST/MCP invocation");
} finally {
  await mcpClient?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running.close();
  rmSync(root, { recursive: true, force: true });
}
