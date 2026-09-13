#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform !== "darwin") {
  console.log("desktop host package tests skipped: macOS only");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "devspace-desktop-host-package-"));
const bundle = join(root, "DevSpaceDesktopHost.app");
const executable = join(bundle, "Contents", "MacOS", "devspace-desktop-helper");
try {
  const build = spawnSync("sh", ["scripts/build-desktop-host.sh", bundle], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_DESKTOP_SIGNING_IDENTITY: "-" },
  });
  assert.equal(build.status, 0, build.stderr);
  const doctor = spawnSync(process.execPath, ["scripts/doctor-desktop-host.mjs", bundle], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const result = JSON.parse(doctor.stdout);
  assert.equal(result.installed, true);
  assert.equal(result.identifier, "com.devspace.desktop-host");
  assert.equal(result.signatureValid, true);
  assert.equal(result.adHoc, true);
  assert.equal(result.stableSigningIdentity, false);
  assert.equal(result.permissionProbeTransport, "launch-services");
  assert.equal(result.permissions?.version, "0.4.3");
  assert.equal(waitForProcessExit(executable, 3_000), true, "permission probe helper remained running");
  const bridgeRequest = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" },
    } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desktop_status", arguments: {} } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const bridge = spawnSync(process.execPath, ["scripts/macos/launchservices-stdio-bridge.mjs", bundle], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: bridgeRequest,
    timeout: 10_000,
  });
  assert.equal(bridge.status, 0, `${bridge.stderr}\n${bridge.stdout}`);
  const bridgeReplies = bridge.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(bridgeReplies[0]?.result?.serverInfo?.version, "0.4.3");
  assert.equal(bridgeReplies[1]?.result?.structuredContent?.version, "0.4.3");
  const client = new Client({ name: "desktop-host-package-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: executable, args: [], stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const tool of tools.tools.filter(({ name }) => !["desktop_status", "desktop_list_apps"].includes(name))) {
      assert.equal(tool.inputSchema.properties?.processId?.type, "integer", `${tool.name} lacks processId`);
    }
    const status = await client.callTool({ name: "desktop_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent?.version, "0.4.3");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  const duplicate = spawnSync("sh", ["scripts/build-desktop-host.sh", bundle], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
  console.log("desktop host package tests passed: bundle metadata, PID schema, signature verification, and no overwrite");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function waitForProcessExit(executable, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processes = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout
      .split("\n")
      .map((line) => line.trim());
    if (!processes.some((command) => command === executable || command.startsWith(`${executable} `))) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}
