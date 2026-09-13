import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "browser-extension", "manifest.json"), "utf8"));
const version = manifest.version;
const buildDir = path.resolve(process.env.DEVSPACE_BROWSER_BUILD_DIR || path.join(root, ".build", "browser-extension"));
const releaseDir = path.resolve(process.env.DEVSPACE_BROWSER_RELEASE_DIR || path.join(root, "releases", `browser-extension-${version}`));
assertSafeOutput(buildDir);
assertSafeOutput(releaseDir);

fs.rmSync(buildDir, { recursive: true, force: true });
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });
for (const file of ["manifest.json", "background.js"]) {
  fs.copyFileSync(path.join(root, "browser-extension", file), path.join(buildDir, file));
}

const extensionId = extensionIdFromKey(manifest.key);
fs.writeFileSync(path.join(buildDir, "EXTENSION_ID.txt"), `${extensionId}\n`);
fs.cpSync(buildDir, path.join(releaseDir, "unpacked"), { recursive: true });

const zipPath = path.join(releaseDir, `devspace-browser-bridge-${version}.zip`);
execFileSync("/usr/bin/zip", ["-qr", zipPath, "."], { cwd: buildDir });
const chrome = process.env.DEVSPACE_CHROME_EXECUTABLE
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const key = process.env.DEVSPACE_BROWSER_EXTENSION_KEY || path.join(process.env.HOME || "", ".devspace", "keys", "devspace-browser-extension.pem");
let crxPath = null;
if (process.platform === "darwin" && fs.existsSync(chrome) && fs.existsSync(key)) {
  try {
    const publicDer = execFileSync("/usr/bin/openssl", ["rsa", "-in", key, "-pubout", "-outform", "DER"], { stdio: ["ignore", "pipe", "ignore"] });
    if (publicDer.toString("base64") !== manifest.key) throw new Error("browser extension packaging key does not match manifest key");
    execFileSync(chrome, [`--pack-extension=${buildDir}`, `--pack-extension-key=${key}`], { stdio: "ignore" });
    const packed = `${buildDir}.crx`;
    if (fs.existsSync(packed)) {
      crxPath = path.join(releaseDir, `devspace-browser-bridge-${version}.crx`);
      fs.renameSync(packed, crxPath);
    }
  } catch (error) {
    console.error(`CRX packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
fs.writeFileSync(path.join(releaseDir, "INSTALL.txt"), [
  "DevSpace Browser Bridge",
  `Version: ${version}`,
  `Extension ID: ${extensionId}`,
  "",
  "Chrome -> chrome://extensions -> Developer mode -> Load unpacked",
  `Select: ${path.join(releaseDir, "unpacked")}`,
  "",
  "Then run:",
  `node ${path.join(root, "native-host", "install.mjs")}`,
  "",
  "The native host installer derives and pins this same Extension ID automatically.",
].join("\n") + "\n");
console.log(JSON.stringify({ version, extensionId, releaseDir, zipPath, crxPath }, null, 2));

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}

function assertSafeOutput(target) {
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!isDescendant(target, root) && !isDescendant(target, temporaryRoot)) {
    throw new Error(`browser extension output must be inside the repository or temporary directory: ${target}`);
  }
}

function isDescendant(target, parent) {
  const relative = path.relative(parent, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
