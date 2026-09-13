import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("macOS service installer test skipped on non-macOS");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "devspace-service-test-"));
try {
  const plistPath = join(root, "com.devspace.test.plist");
  const runtimeRoot = join(root, "runtime");
  const logDir = join(root, "logs");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const worktreeRoot = join(root, "worktrees");
  const output = execFileSync(process.execPath, [
    resolve("scripts/macos/install-service.mjs"),
    "--label", "com.devspace.test",
    "--port", "17676",
    "--root", root,
    "--config-dir", configDir,
    "--state-dir", stateDir,
    "--worktree-root", worktreeRoot,
    "--runtime-root", runtimeRoot,
    "--log-dir", logDir,
    "--plist-path", plistPath,
    "--node", process.execPath,
    "--devspace-bin", resolve("package.json"),
    "--release-id", "test-release",
  ], { encoding: "utf8" });
  const result = JSON.parse(output.trim());
  assert.equal(result.installed, true);
  assert.equal(result.activated, false);
  assert.equal(result.releaseId, "test-release");
  assert.equal(result.toolMode, "codex");
  const plist = readFileSync(plistPath, "utf8");
  assert.match(plist, /<string>com\.devspace\.test<\/string>/);
  assert.match(plist, /DEVSPACE_CAPABILITIES/);
  assert.match(plist, /<key>DEVSPACE_TOOL_MODE<\/key>\s*<string>codex<\/string>/);
  assert.match(plist, /<key>DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE<\/key>\s*<string>2<\/string>/);
  assert.match(plist, /DEVSPACE_RELEASE_ID/);
  assert.match(plist, /test-release/);
  assert.match(plist, /service-supervisor\.mjs/);
  assert.doesNotMatch(plist, /api-key|owner-token|password/i);

  const fakeLaunchctl = join(root, "fake-launchctl.mjs");
  const launchctlCalls = join(root, "launchctl-calls.ndjson");
  writeFileSync(fakeLaunchctl, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(launchctlCalls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o700 });
  chmodSync(fakeLaunchctl, 0o700);
  const healthServerSource = join(root, "health-server.mjs");
  const healthPortFile = join(root, "health-port");
  writeFileSync(healthServerSource, `import http from "node:http";\nimport { writeFileSync } from "node:fs";\nconst server = http.createServer((request, response) => { response.writeHead(200); response.end("ok"); });\nserver.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));\n`);
  const healthServer = spawn(process.execPath, [healthServerSource, healthPortFile], { detached: true, stdio: "ignore" });
  healthServer.unref();
  waitUntil(() => existsSync(healthPortFile), 5_000, "fixture health server did not publish its port");
  const healthPort = Number(readFileSync(healthPortFile, "utf8"));
  assert.ok(Number.isInteger(healthPort) && healthPort > 0);
  waitUntil(() => portReady(healthPort), 5_000, "fixture health server did not start");
  try {
    const activatedOutput = execFileSync(process.execPath, [
      resolve("scripts/macos/install-service.mjs"),
      "--label", "com.devspace.test",
      "--port", String(healthPort),
      "--root", root,
      "--config-dir", configDir,
      "--state-dir", stateDir,
      "--worktree-root", worktreeRoot,
      "--runtime-root", runtimeRoot,
      "--log-dir", logDir,
      "--plist-path", plistPath,
      "--node", process.execPath,
      "--devspace-bin", resolve("package.json"),
      "--release-id", "test-release",
      "--launchctl", fakeLaunchctl,
      "--activation-delay-ms", "1000",
      "--activate",
    ], { encoding: "utf8" });
    const activated = JSON.parse(activatedOutput.trim());
    assert.equal(activated.activated, true);
    assert.equal(typeof activated.activationStatusPath, "string");
    assert.equal(typeof activated.activationId, "string");
    assert.equal(existsSync(launchctlCalls), false, "bootout must not run before the installer returns");
    waitUntil(() => {
      if (!existsSync(activated.activationStatusPath)) return false;
      const status = JSON.parse(readFileSync(activated.activationStatusPath, "utf8"));
      return status.activationId === activated.activationId && status.state === "ready";
    }, 10_000, "detached service activation did not become ready");
    const calls = readFileSync(launchctlCalls, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((call) => call[0]), ["bootout", "bootstrap", "enable"]);
  } finally {
    try { process.kill(-healthServer.pid, "SIGTERM"); } catch {}
  }

  console.log("macOS service installer tests passed: stable runtime, detached self-activation, release metadata, no embedded secrets");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function portReady(port) {
  try {
    execFileSync("/usr/bin/nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    execFileSync("/bin/sleep", ["0.05"]);
  }
  throw new Error(message);
}
