import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { FakeCapabilityProvider } from "./fake-provider.test-support.js";
import { CAPABILITY_MCP_TOOL_NAMES } from "./mcp-adapter.js";

const FIXED_CAPABILITY_MCP_CONTRACT = [
  "capability_list",
  "capability_search",
  "capability_describe",
  "capability_open",
  "capability_invoke",
  "capability_status",
  "capability_cancel",
  "capability_close",
] as const;

// Deliberately duplicate the literal public contract instead of deriving this
// assertion from CAPABILITY_MCP_TOOL_NAMES. This catches replacement/renaming
// drift even when the tool count remains eight.
assert.deepEqual(CAPABILITY_MCP_TOOL_NAMES, FIXED_CAPABILITY_MCP_CONTRACT);

const root = mkdtempSync(join(tmpdir(), "devspace-capability-mcp-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "capability-mcp-owner-token-long-enough",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_LOG_LEVEL: "silent",
});
const running = createServer(config, {
  capabilityProviders: [{ provider: new FakeCapabilityProvider(), kind: "test", enabled: true }],
});
const server = running.app.listen(0, "127.0.0.1");
let client: Client | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/capabilities/mcp`),
  );
  client = new Client({ name: "capability-contract-test", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(({ name }) => name).sort(),
    [...FIXED_CAPABILITY_MCP_CONTRACT].sort(),
  );
  assert.equal(listed.tools.length, 8);

  const catalog = await client.callTool({ name: "capability_list", arguments: {} });
  assert.equal(catalog.isError, undefined);
  assert.equal((catalog.structuredContent as any).data.items.some(
    (item: any) => item.id === "test.fake.echo",
  ), true);

  const invoked = await client.callTool({
    name: "capability_invoke",
    arguments: { capabilityId: "test.fake.echo", arguments: { text: "hello" } },
  });
  assert.equal(invoked.isError, undefined);
  assert.equal((invoked.structuredContent as any).data.status, "succeeded");
  assert.equal((invoked.structuredContent as any).data.result.arguments.text, "hello");

  console.log("capability MCP tests passed: fixed 8 tools, delegated approval and invocation");
} finally {
  await client?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running.close();
  rmSync(root, { recursive: true, force: true });
}
