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
  const executable = join(bundle, "Contents", "MacOS", "devspace-desktop-helper");
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
    assert.equal(status.structuredContent?.version, "0.4.0");
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
