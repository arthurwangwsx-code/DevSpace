#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("DevSpace.app package test skipped on non-macOS");
  process.exit(0);
}

const app = resolve(process.argv[2] ?? ".build/DevSpace.app");
const resources = join(app, "Contents", "Resources");
const packageRoot = join(resources, "devspace");
const browserReleases = join(packageRoot, "releases");

assert.equal(existsSync(join(app, "Contents", "MacOS", "DevSpace")), true, "native DevSpace executable is missing");
assert.equal(existsSync(join(resources, "runtime", "node")), true, "bundled Node runtime is missing");
assert.equal(existsSync(join(packageRoot, "dist", "cli.js")), true, "bundled DevSpace runtime is missing");
const bundledControlCenter = readFileSync(join(packageRoot, "dist", "control-center.js"), "utf8");
assert.match(bundledControlCenter, /setup\.status/, "bundled Control Center is missing native setup readiness support");
assert.match(bundledControlCenter, /browser\.prepare/, "bundled Control Center is missing Browser setup support");
assert.equal(existsSync(join(resources, "DevSpaceDesktopHost.app")), true, "bundled Desktop Host is missing");
assert.equal(existsSync(join(resources, "DevSpace.icns")), true, "DevSpace App icon is missing");

const releaseName = readdirSync(browserReleases).find((name) => name.startsWith("browser-extension-"));
assert.ok(releaseName, "bundled Browser extension release is missing");
const releaseDir = join(browserReleases, releaseName);
assert.equal(existsSync(join(releaseDir, "unpacked", "manifest.json")), true, "bundled unpacked Browser extension is missing");
assert.ok(readdirSync(releaseDir).some((name) => name.endsWith(".zip")), "bundled Browser extension ZIP is missing");
assert.equal(existsSync(join(releaseDir, "INSTALL.txt")), true, "bundled Browser extension install guide is missing");

const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
assert.match(plist, /com\.devspace\.control-center/);
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", join(resources, "DevSpaceDesktopHost.app")], { stdio: "inherit" });

console.log(`DevSpace.app package test passed: native shell, bundled runtime, Browser Bridge and Desktop Host (${releaseName})`);
