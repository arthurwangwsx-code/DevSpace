import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { FakeCapabilityProvider } from "./fake-provider.test-support.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-cli-test-"));
const env = {
  ...process.env,
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "capability-cli-owner-token-long-enough",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_CAPABILITY_CONFIG_DIR: join(root, "providers"),
  DEVSPACE_LOG_LEVEL: "silent",
};
const config = loadConfig(env);
const running = createServer(config, {
  capabilityProviders: [{ provider: new FakeCapabilityProvider(), kind: "test", enabled: true }],
});
const server = running.app.listen(0, "127.0.0.1");
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/capabilities/v1`;
  const listed = await runCli(["capabilities", "list", "--url", url, "--json"], env);
  assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).data.items[0].id, "test.fake.echo");
  assert.equal(listed.stderr, "");

  const providers = await runCli(["providers", "list", "--url", url, "--json"], env);
  assert.equal(providers.code, 0);
  assert.equal(JSON.parse(providers.stdout).data.items[0].id, "test.fake.provider");

  const missing = await runCli([
    "capabilities", "describe", "missing.capability", "--url", url, "--json",
  ], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^capability_not_found:/);

  const manifestPath = join(root, "install-me.json");
  writeFileSync(manifestPath, JSON.stringify({
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: "test.cli.installed" },
    spec: {
      enabled: false,
      transport: { type: "stdio", command: process.execPath, args: [] },
      tools: [{
        tool: "echo",
        capabilityId: "test.cli.echo",
        effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      }],
    },
  }));
  const installed = await runCli(["providers", "add-mcp", "--manifest", manifestPath], env);
  assert.equal(installed.code, 0);
  assert.equal(JSON.parse(installed.stdout).restartRequired, true);

  const chrome = await runCli([
    "providers", "add-chrome", "--command", process.execPath,
  ], { ...env, DEVSPACE_CAPABILITY_CONFIG_DIR: join(root, "chrome-providers") });
  assert.equal(chrome.code, 0);
  assert.equal(JSON.parse(chrome.stdout).connection, "current-chrome-auto-connect");

  console.log("capability CLI tests passed: stable JSON stdout and CI exit codes");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running.close();
  rmSync(root, { recursive: true, force: true });
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
