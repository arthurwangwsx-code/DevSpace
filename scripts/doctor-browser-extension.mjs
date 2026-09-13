import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "browser-extension", "manifest.json"), "utf8"));
const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
const extensionId = [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
const chromeExecutable = process.env.DEVSPACE_CHROME_EXECUTABLE
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userDataDir = process.env.DEVSPACE_CHROME_USER_DATA_DIR
  || path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
const nativeHostsDir = process.env.DEVSPACE_CHROME_NATIVE_HOSTS_DIR
  || path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
const nativeManifestPath = path.join(nativeHostsDir, "com.devspace.browser_bridge.json");
const releaseDir = process.env.DEVSPACE_BROWSER_RELEASE_DIR
  || path.join(root, "releases", `browser-extension-${manifest.version}`);
const socketPath = process.env.DEVSPACE_BROWSER_SOCKET
  || path.join(os.homedir(), ".devspace", "browser-extension.sock");

const native = inspectNativeManifest(nativeManifestPath, extensionId);
const profiles = inspectProfiles(userDataDir, extensionId);
const bridgeConnected = await socketIsListening(socketPath);
const checks = {
  chromeInstalled: fs.existsSync(chromeExecutable),
  nativeManifestInstalled: fs.existsSync(nativeManifestPath),
  nativeManifestValid: native.valid,
  unpackedBuild: fs.existsSync(path.join(releaseDir, "unpacked", "manifest.json")),
  zipBuild: fs.existsSync(path.join(releaseDir, `devspace-browser-bridge-${manifest.version}.zip`)),
  crxBuild: fs.existsSync(path.join(releaseDir, `devspace-browser-bridge-${manifest.version}.crx`)),
  configuredProfileCount: profiles.configured,
  enabledProfileCount: profiles.enabled,
  bridgeConnected,
};
const installationReady = checks.chromeInstalled
  && checks.nativeManifestInstalled
  && checks.nativeManifestValid
  && checks.unpackedBuild
  && checks.zipBuild;
const healthy = installationReady && checks.enabledProfileCount > 0;
const releaseReady = installationReady && checks.crxBuild;
console.log(JSON.stringify({
  healthy,
  installationReady,
  releaseReady,
  version: manifest.version,
  extensionId,
  ...checks,
}, null, 2));
process.exitCode = healthy ? 0 : 1;

function inspectNativeManifest(manifestPath, expectedExtensionId) {
  if (!fs.existsSync(manifestPath)) return { valid: false };
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      valid: value.name === "com.devspace.browser_bridge"
        && value.type === "stdio"
        && Array.isArray(value.allowed_origins)
        && value.allowed_origins.length === 1
        && value.allowed_origins[0] === `chrome-extension://${expectedExtensionId}/`
        && typeof value.path === "string"
        && fs.existsSync(value.path),
    };
  } catch {
    return { valid: false };
  }
}

function inspectProfiles(directory, targetId) {
  let configured = 0;
  let enabled = 0;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return { configured, enabled }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || (entry.name !== "Default" && !entry.name.startsWith("Profile "))) continue;
    const setting = readExtensionSetting(path.join(directory, entry.name), targetId);
    if (!setting) continue;
    configured += 1;
    if (setting.state === 1) enabled += 1;
  }
  return { configured, enabled };
}

function readExtensionSetting(profileDirectory, targetId) {
  for (const filename of ["Secure Preferences", "Preferences"]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(profileDirectory, filename), "utf8"));
      const setting = value?.extensions?.settings?.[targetId];
      if (setting && typeof setting === "object") return setting;
    } catch {}
  }
  return undefined;
}

function socketIsListening(socket) {
  return new Promise((resolve) => {
    const connection = net.createConnection(socket);
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      connection.destroy();
      resolve(value);
    };
    connection.setTimeout(300, () => finish(false));
    connection.once("connect", () => finish(true));
    connection.once("error", () => finish(false));
  });
}
