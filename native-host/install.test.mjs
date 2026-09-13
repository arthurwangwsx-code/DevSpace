import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  console.log("browser native host installer test skipped: macOS only");
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "devspace-native-install-"));
const installRoot = path.join(root, "installed host");
const manifests = path.join(root, "manifests");
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const result = spawnSync(process.execPath, [new URL("./install.mjs", import.meta.url).pathname, extensionId], {
  env: {
    ...process.env,
    DEVSPACE_BROWSER_NATIVE_HOST_DIR: installRoot,
    DEVSPACE_CHROME_NATIVE_HOSTS_DIR: manifests,
  },
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr);

const manifestPath = path.join(manifests, "com.devspace.browser_bridge.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const launcher = path.join(installRoot, "devspace-browser-native-host");
assert.equal(manifest.path, launcher);
assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
const launcherText = await readFile(launcher, "utf8");
assert.match(launcherText, new RegExp(escapeRegExp(process.execPath)));
assert.match(launcherText, /devspace-browser-native-host\.mjs/);
assert.equal((await stat(launcher)).mode & 0o777, 0o700);
assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);

const invalid = spawnSync(process.execPath, [new URL("./install.mjs", import.meta.url).pathname, "not-an-extension-id"], {
  env: process.env,
  encoding: "utf8",
});
assert.equal(invalid.status, 2);
assert.match(invalid.stderr, /must be 32 lowercase letters/);

await rm(root, { recursive: true, force: true });
console.log("browser native host installer tests passed: pinned origin, stable launcher, exact modes");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
