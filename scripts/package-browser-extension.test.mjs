import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!fs.existsSync("/usr/bin/zip")) {
  console.log("browser extension packaging test skipped: /usr/bin/zip unavailable");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devspace-browser-package-"));
const buildDir = path.join(root, "build");
const releaseDir = path.join(root, "release");
const projectRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(projectRoot, "scripts", "package-browser-extension.mjs");
const first = run();
assert.equal(first.status, 0, first.stderr);
const output = JSON.parse(first.stdout);
assert.match(output.extensionId, /^[a-p]{32}$/);
assert.equal(output.crxPath, null);
assert.equal(fs.existsSync(path.join(releaseDir, "unpacked", "manifest.json")), true);
assert.equal(fs.existsSync(output.zipPath), true);
assert.match(fs.readFileSync(path.join(releaseDir, "INSTALL.txt"), "utf8"), new RegExp(output.extensionId));

const stale = path.join(releaseDir, "stale-file");
fs.writeFileSync(stale, "stale");
const second = run();
assert.equal(second.status, 0, second.stderr);
assert.equal(fs.existsSync(stale), false);
assert.equal(JSON.parse(second.stdout).extensionId, output.extensionId);

const unsafe = spawnSync(process.execPath, [script], {
  env: { ...process.env, DEVSPACE_BROWSER_BUILD_DIR: "/", DEVSPACE_BROWSER_RELEASE_DIR: releaseDir },
  encoding: "utf8",
});
assert.notEqual(unsafe.status, 0);
assert.match(unsafe.stderr, /output must be inside/);

fs.rmSync(root, { recursive: true, force: true });
console.log("browser extension packaging tests passed: deterministic ID, artifacts, cleanup, safe outputs");

function run() {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      DEVSPACE_BROWSER_BUILD_DIR: buildDir,
      DEVSPACE_BROWSER_RELEASE_DIR: releaseDir,
      DEVSPACE_CHROME_EXECUTABLE: path.join(root, "missing-chrome"),
      DEVSPACE_BROWSER_EXTENSION_KEY: path.join(root, "missing-key.pem"),
    },
    encoding: "utf8",
  });
}
