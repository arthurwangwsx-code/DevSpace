#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("DevSpace.app packaging currently requires macOS.");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
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
const browserManifest = JSON.parse(readFileSync(join(root, "browser-extension", "manifest.json"), "utf8"));
const deploymentArch = process.arch === "arm64" ? "arm64" : "x86_64";
const appIconSource = join(root, "docs", "assets", "devspace-logo-light.png");

if (existsSync(output)) rmSync(output, { recursive: true, force: true });
if (process.env.DEVSPACE_SKIP_APP_RUNTIME_BUILD !== "1") {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
} else if (!existsSync(join(root, "dist", "cli.js"))) {
  throw new Error("DEVSPACE_SKIP_APP_RUNTIME_BUILD=1 requires an existing dist/cli.js build.");
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
  "-target", `${deploymentArch}-apple-macosx13.0`,
  "-framework", "AppKit",
  "-framework", "SwiftUI",
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

const browserBuildDir = join(root, ".build", "app-browser-extension-build");
const browserReleaseDir = join(appRoot, "releases", `browser-extension-${browserManifest.version}`);
execFileSync(nodeSource, [join(root, "scripts", "package-browser-extension.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    DEVSPACE_BROWSER_BUILD_DIR: browserBuildDir,
    DEVSPACE_BROWSER_RELEASE_DIR: browserReleaseDir,
  },
});

cpSync(desktopBundle, join(resources, "DevSpaceDesktopHost.app"), { recursive: true });

if (existsSync(appIconSource)) {
  const iconset = join(root, ".build", "DevSpace.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const [points, pixels] of [[16, 16], [16, 32], [32, 32], [32, 64], [128, 128], [128, 256], [256, 256], [256, 512], [512, 512], [512, 1024]]) {
    const scale = pixels === points ? "" : "@2x";
    const target = join(iconset, `icon_${points}x${points}${scale}.png`);
    execFileSync("/usr/bin/sips", ["-z", String(pixels), String(pixels), appIconSource, "--out", target], { stdio: "ignore" });
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(resources, "DevSpace.icns")], { stdio: "inherit" });
  rmSync(iconset, { recursive: true, force: true });
}

writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DevSpace</string>
<key>CFBundleIdentifier</key><string>com.devspace.control-center</string>
<key>CFBundleName</key><string>DevSpace</string>
<key>CFBundleDisplayName</key><string>DevSpace</string>
<key>CFBundleIconFile</key><string>DevSpace</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${packageJson.version}</string>
<key>CFBundleVersion</key><string>${bundleVersion(packageJson.version)}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
execFileSync("plutil", ["-lint", join(contents, "Info.plist")], { stdio: "ignore" });
const signArgs = ["--force", "--deep", "--sign", identity];
if (identity === "-") signArgs.push("--timestamp=none");
else signArgs.push("--options", "runtime", "--timestamp");
signArgs.push(output);
execFileSync("codesign", signArgs, { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", output], { stdio: "inherit" });
console.log(JSON.stringify({ output, version: packageJson.version, node: nodeSource, identity, bundledRuntime: true }));

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

function bundleVersion(version) {
  const parts = String(version).split(".").map((value) => Number.parseInt(value, 10) || 0);
  return String((parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0));
}
