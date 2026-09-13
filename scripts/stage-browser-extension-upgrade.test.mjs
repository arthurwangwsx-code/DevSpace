import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devspace-browser-stage-"));
try {
  const chrome = path.join(root, "Chrome");
  const profile = path.join(chrome, "agent");
  const target = path.join(root, "installed-extension");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const sourceManifest = JSON.parse(fs.readFileSync("browser-extension/manifest.json", "utf8"));
  fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ ...sourceManifest, version: "0.0.1" }));
  fs.writeFileSync(path.join(target, "background.js"), "// old\n");
  fs.writeFileSync(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { agent: {} } } }));
  fs.writeFileSync(path.join(profile, "Secure Preferences"), JSON.stringify({
    extensions: { settings: { cjlpacoigfekaahbjanpckpefndmblfn: { path: target } } },
  }));

  const output = execFileSync(process.execPath, ["scripts/stage-browser-extension-upgrade.mjs"], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CHROME_USER_DATA_DIR: chrome },
  });
  const result = JSON.parse(output);
  assert.equal(result.staged, 1);
  assert.equal(result.targets[0].profileName, "agent");
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).version, sourceManifest.version);
  assert.equal(fs.readFileSync(path.join(target, "background.js"), "utf8"), fs.readFileSync("browser-extension/background.js", "utf8"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("browser extension staged-upgrade tests passed: installed unpacked path is upgraded safely");
