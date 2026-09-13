#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("DevSpace.app packaging currently requires macOS.");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const output = resolve(args.output ?? join(root, ".build", "DevSpace.app"));
const identity = args.identity ?? process.env.DEVSPACE_APP_SIGNING_IDENTITY ?? "-";
const nodeSource = resolve(args.node ?? process.execPath);
const contents = join(output, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");
const runtime = join(resources, "runtime");
const appRoot = join(resources, "devspace");
const executable = join(macos, "DevSpace");
const desktopBundle = join(root, ".build", "DevSpaceDesktopHost.app");

if (existsSync(output)) rmSync(output, { recursive: true, force: true });
if (!existsSync(join(root, "dist", "cli.js"))) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
}
if (!existsSync(desktopBundle)) {
  execFileSync("/bin/sh", [join(root, "scripts", "build-desktop-host.sh"), desktopBundle], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      DEVSPACE_DESKTOP_SIGNING_IDENTITY: process.env.DEVSPACE_DESKTOP_SIGNING_IDENTITY ?? identity,
    },
  });
}
mkdirSync(macos, { recursive: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(appRoot, { recursive: true });

execFileSync("xcrun", [
  "swiftc", "-O",
  "-framework", "AppKit",
  "-framework", "WebKit",
  join(root, "native", "control-center", "main.swift"),
  "-o", executable,
], { cwd: root, stdio: "inherit" });
chmodSync(executable, 0o755);

cpSync(nodeSource, join(runtime, "node"));
chmodSync(join(runtime, "node"), 0o755);
for (const entry of ["dist", "node_modules", "scripts", "native-host", "browser-extension", "native", "package.json"]) {
  const source = join(root, entry);
  if (existsSync(source)) cpSync(source, join(appRoot, entry), { recursive: true, dereference: true });
}
removeNodeBinDirectories(join(appRoot, "node_modules"));

cpSync(desktopBundle, join(resources, "DevSpaceDesktopHost.app"), { recursive: true });

writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DevSpace</string>
<key>CFBundleIdentifier</key><string>com.devspace.control-center</string>
<key>CFBundleName</key><string>DevSpace</string>
<key>CFBundleDisplayName</key><string>DevSpace</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.4</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
execFileSync("plutil", ["-lint", join(contents, "Info.plist")], { stdio: "ignore" });
execFileSync("codesign", ["--force", "--deep", "--sign", identity, "--timestamp=none", output], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", output], { stdio: "inherit" });
console.log(JSON.stringify({ output, node: nodeSource, identity, bundledRuntime: true }));

function parseArgs(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = values[++i];
    if (!value) throw new Error(`${key} requires a value`);
    result[key.slice(2)] = value;
  }
  return result;
}

function removeNodeBinDirectories(rootDir) {
  if (!existsSync(rootDir)) return;
  for (const name of readdirSync(rootDir)) {
    const path = join(rootDir, name);
    if (name === ".bin") {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    try {
      if (statSync(path).isDirectory()) removeNodeBinDirectories(path);
    } catch {
      // Ignore optional dependency entries that disappear during staging.
    }
  }
}
