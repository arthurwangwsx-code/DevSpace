import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-observability-test-"));
const warnings: string[] = [];
const originalWarn = console.warn;
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "observability-test-owner-token",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_TOOL_MODE: "codex",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_FORMAT: "json",
  DEVSPACE_LOG_REQUESTS: "0",
  DEVSPACE_LOG_TOOL_CALLS: "0",
  DEVSPACE_LOG_SLOW_REQUEST_MS: "1",
  DEVSPACE_LOG_SLOW_TOOL_CALL_MS: "1",
  DEVSPACE_LOG_EVENT_LOOP_LAG_MS: "60000",
});
const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address() as AddressInfo;
const client = new Client({ name: "observability-test", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));

try {
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  await client.connect(transport);
  const opened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  assert.notEqual(opened.isError, true);
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  const executed = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 25)"`,
      yieldTimeMs: 1_000,
    },
  });
  assert.notEqual(executed.isError, true);

  const events = warnings.map((line) => JSON.parse(line) as Record<string, unknown>);
  const slowTool = events.find((event) => event.event === "tool_call_slow" && event.tool === "exec_command");
  assert.ok(slowTool, `missing tool_call_slow in ${warnings.join("\n")}`);
  assert.equal(slowTool.thresholdMs, 1);
  assert.match(String(slowTool.requestId), /^[0-9a-f-]{36}$/);
  assert.ok(events.some((event) => event.event === "http_request_slow"));
} finally {
  console.warn = originalWarn;
  await transport.terminateSession().catch(() => {});
  await client.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await running.close();
  await rm(root, { recursive: true, force: true });
}

console.log("observability tests passed: slow HTTP/tool events and request correlation");
