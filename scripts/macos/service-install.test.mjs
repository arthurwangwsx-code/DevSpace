import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const plist = readFileSync(plistPath, "utf8");
  assert.match(plist, /<string>com\.devspace\.test<\/string>/);
  assert.match(plist, /DEVSPACE_CAPABILITIES/);
  assert.match(plist, /DEVSPACE_RELEASE_ID/);
  assert.match(plist, /test-release/);
  assert.match(plist, /service-supervisor\.mjs/);
  assert.doesNotMatch(plist, /api-key|owner-token|password/i);
  console.log("macOS service installer tests passed: stable runtime, launchd profile, release metadata, no embedded secrets");
} finally {
  rmSync(root, { recursive: true, force: true });
}
