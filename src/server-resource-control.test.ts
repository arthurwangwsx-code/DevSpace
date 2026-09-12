import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const testRoot = mkdtempSync(join(tmpdir(), "devspace-resource-integration-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_STATE_DIR: join(testRoot, "state"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "resource-integration-owner-token",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_TOOL_MODE: "minimal",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_MCP_MAX_SESSIONS: "64",
  DEVSPACE_MCP_MAX_IDLE_SESSIONS: "32",
  DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS: "32",
  DEVSPACE_MCP_MAX_QUEUED_REQUESTS: "64",
  DEVSPACE_MCP_MAX_REQUEST_BYTES: String(8 * 1024 * 1024),
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  httpServer.once("listening", resolve);
  httpServer.once("error", reject);
});

const address = httpServer.address() as AddressInfo;
const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function initialize(index: number): Promise<string> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: index,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "resource-control-test", version: "1.0" },
      },
    }),
  });
  await response.text();
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  return sessionId;
}

async function notifyInitialized(sessionId: string): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
}

try {
  const sessionIds: string[] = [];
  for (let offset = 0; offset < 512; offset += 16) {
    const batch = await Promise.all(
      Array.from({ length: 16 }, (_, index) => initialize(offset + index + 1)),
    );
    sessionIds.push(...batch);
  }

  const firstSession = sessionIds[0];
  const latestSession = sessionIds.at(-1);
  assert.ok(firstSession);
  assert.ok(latestSession);

  const evicted = await notifyInitialized(firstSession);
  assert.equal(evicted.status, 404);
  await evicted.text();

  const retained = await notifyInitialized(latestSession);
  assert.equal(retained.status, 202);
  await retained.text();
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await running.close();
  rmSync(testRoot, { recursive: true, force: true });
}
