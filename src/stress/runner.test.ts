import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { runStressWorkload } from "./runner.js";

const testRoot = mkdtempSync(join(tmpdir(), "devspace-stress-runner-test-"));
const workspaces = [join(testRoot, "workspace-0"), join(testRoot, "workspace-1")];
try {
  for (const workspace of workspaces) {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# Stress fixture\n");
    writeFileSync(join(workspace, "small.txt"), "small\n".repeat(20));
    writeFileSync(join(workspace, "large.txt"), `${"large-line\n".repeat(120_000)}end\n`);
    for (let index = 0; index < 4; index++) {
      writeFileSync(join(workspace, `mutable-${index}.txt`), "value-0\n");
    }
  }
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
    DEVSPACE_STATE_DIR: join(testRoot, "state"),
    DEVSPACE_ALLOWED_ROOTS: workspaces.join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "stress-test-owner-token-long-enough",
    DEVSPACE_AUTH_MODE: "trusted-local",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_PROCESS_MAX_CONCURRENT: "4",
    DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE: "1",
    DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS: "4",
    DEVSPACE_MCP_MAX_QUEUED_REQUESTS: "8",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  try {
    const port = (httpServer.address() as AddressInfo).port;
    const report = await runStressWorkload({
      url: `http://127.0.0.1:${port}/mcp`,
      workspacePaths: workspaces,
      concurrency: 4,
      operationsPerClient: 4,
      churnSessions: 8,
      readP95TargetMs: 1_000,
      writeP95TargetMs: 1_000,
      runCapacityBoundary: false,
      timeoutMs: 2_000,
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.totals.attemptedBusinessOperations, 16);
    assert.equal(report.metrics.operations.read?.count, 8);
    assert.equal(report.metrics.operations.write?.count, 8);
    assert.equal(report.metrics.operations.initialize?.count, 12);
    assert.equal(report.longTasks.length, 2);
    assert.ok(report.longTasks.every((task) => task.chunksSeen === 5));
    assert.equal(report.recovery?.largeFilePaged, true);
    assert.equal(report.recovery?.workspaceRestored, true);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
  }
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
