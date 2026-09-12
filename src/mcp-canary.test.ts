import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runMcpCanary } from "./mcp-canary.js";
import { createServer } from "./server.js";

const testRoot = mkdtempSync(join(tmpdir(), "devspace-canary-test-"));
const projectRoot = join(testRoot, "project");

try {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "AGENTS.md"), "# Canary fixture\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
    DEVSPACE_STATE_DIR: join(testRoot, "state"),
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "canary-test-owner-token-long-enough",
    DEVSPACE_AUTH_MODE: "trusted-local",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "silent",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  try {
    const address = httpServer.address() as AddressInfo;
    const result = await runMcpCanary({
      url: `http://127.0.0.1:${address.port}/mcp`,
      workspacePath: projectRoot,
      readPath: "AGENTS.md",
    });
    assert.equal(result.ok, true);
    assert.equal(result.workspacePath, projectRoot);
    assert.equal(result.readPath, "AGENTS.md");
    assert.equal(result.toolCount, 6);
    assert.equal(typeof result.workspaceId, "string");
    assert.ok(result.timingsMs.total >= 0);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
  }

  await assert.rejects(
    runMcpCanary({
      url: "http://127.0.0.1:1/mcp",
      workspacePath: projectRoot,
      readPath: "AGENTS.md",
      timeoutMs: 0,
    }),
    /timeoutMs must be a positive integer/,
  );
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
