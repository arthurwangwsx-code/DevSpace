import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devspace-browser-doctor-"));
const chrome = path.join(root, "Google Chrome");
const userData = path.join(root, "user-data");
const nativeHosts = path.join(root, "native-hosts");
const release = path.join(root, "release");
const launcher = path.join(root, "native-launcher");
const projectRoot = path.resolve(import.meta.dirname, "..");
const extensionManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "browser-extension", "manifest.json"), "utf8"));
const digest = createHash("sha256").update(Buffer.from(extensionManifest.key, "base64")).digest().subarray(0, 16);
const extensionId = [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");

fs.mkdirSync(nativeHosts, { recursive: true });
fs.mkdirSync(path.join(release, "unpacked"), { recursive: true });
for (const target of [
  chrome,
  launcher,
  path.join(release, "unpacked", "manifest.json"),
  path.join(release, `devspace-browser-bridge-${extensionManifest.version}.zip`),
  path.join(release, `devspace-browser-bridge-${extensionManifest.version}.crx`),
]) fs.writeFileSync(target, "fixture");
const nativeManifestPath = path.join(nativeHosts, "com.devspace.browser_bridge.json");
writeNativeManifest(`chrome-extension://${extensionId}/`);

const installationOnly = runDoctor();
assert.equal(installationOnly.status, 1);
assert.equal(installationOnly.output.installationReady, true);
assert.equal(installationOnly.output.healthy, false);
assert.equal(installationOnly.output.enabledProfileCount, 0);

const profile = path.join(userData, "Default");
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, "Secure Preferences"), JSON.stringify({
  extensions: { settings: { [extensionId]: { state: 1 } } },
}));
const healthy = runDoctor();
assert.equal(healthy.status, 0);
assert.equal(healthy.output.healthy, true);
assert.equal(healthy.output.releaseReady, true);
assert.equal(healthy.output.enabledProfileCount, 1);
assert.equal(healthy.output.bridgeConnected, false);

writeNativeManifest("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
const wrongOrigin = runDoctor();
assert.equal(wrongOrigin.status, 1);
assert.equal(wrongOrigin.output.nativeManifestValid, false);

fs.rmSync(root, { recursive: true, force: true });
console.log("browser extension doctor tests passed: install, profile enablement, pinned origin");

function runDoctor() {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "doctor-browser-extension.mjs")], {
    env: {
      ...process.env,
      DEVSPACE_CHROME_EXECUTABLE: chrome,
      DEVSPACE_CHROME_USER_DATA_DIR: userData,
      DEVSPACE_CHROME_NATIVE_HOSTS_DIR: nativeHosts,
      DEVSPACE_BROWSER_RELEASE_DIR: release,
      DEVSPACE_BROWSER_SOCKET: path.join(root, "missing.sock"),
    },
    encoding: "utf8",
  });
  return { status: result.status, output: JSON.parse(result.stdout) };
}

function writeNativeManifest(origin) {
  fs.writeFileSync(nativeManifestPath, JSON.stringify({
    name: "com.devspace.browser_bridge",
    description: "fixture",
    path: launcher,
    type: "stdio",
    allowed_origins: [origin],
  }));
}
