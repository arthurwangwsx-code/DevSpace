import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(root, "browser-extension");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
const extensionId = extensionIdFromKey(sourceManifest.key);
const userDataDir = process.env.DEVSPACE_CHROME_USER_DATA_DIR
  || path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

const targets = [];
for (const profileName of profileDirectoryNames(userDataDir)) {
  const setting = readExtensionSetting(path.join(userDataDir, profileName), extensionId);
  if (!setting || typeof setting.path !== "string") continue;
  const target = path.resolve(setting.path);
  if (!fs.existsSync(target)) continue;
  const targetManifestPath = path.join(target, "manifest.json");
  if (!fs.existsSync(targetManifestPath)) continue;
  const targetManifest = JSON.parse(fs.readFileSync(targetManifestPath, "utf8"));
  if (extensionIdFromKey(targetManifest.key) !== extensionId) continue;
  fs.copyFileSync(path.join(sourceDir, "manifest.json"), targetManifestPath);
  fs.copyFileSync(path.join(sourceDir, "background.js"), path.join(target, "background.js"));
  targets.push({ profileName, target, version: sourceManifest.version });
}

console.log(JSON.stringify({ extensionId, version: sourceManifest.version, staged: targets.length, targets }, null, 2));
if (targets.length === 0) process.exitCode = 2;

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}

function profileDirectoryNames(directory) {
  const names = new Set();
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(directory, "Local State"), "utf8"));
    for (const name of Object.keys(localState?.profile?.info_cache ?? {})) names.add(name);
  } catch {}
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profile = path.join(directory, entry.name);
      if (fs.existsSync(path.join(profile, "Preferences")) || fs.existsSync(path.join(profile, "Secure Preferences"))) names.add(entry.name);
    }
  } catch {}
  return [...names];
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
