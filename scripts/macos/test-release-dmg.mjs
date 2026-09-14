#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("release DMG acceptance skipped on non-macOS");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(execFileSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(join(root, "package.json"))})))`], { encoding: "utf8" }));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const dmg = resolve(process.argv[2] ?? join(root, ".build", "release", `v${pkg.version}`, `DevSpace-macOS-${arch}-v${pkg.version}.dmg`));
assert.equal(existsSync(dmg), true, `release DMG is missing: ${dmg}`);

const temporary = mkdtempSync(join(tmpdir(), "devspace-release-dmg-"));
const mountPoint = join(temporary, "mount");
const configDir = join(temporary, "config");
mkdirSync(mountPoint, { recursive: true });
mkdirSync(configDir, { recursive: true });
let child;

try {
  execFileSync("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmg], {
    stdio: "ignore",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const app = join(mountPoint, "DevSpace.app");
  const executable = join(app, "Contents", "MacOS", "DevSpace");
  const resources = join(app, "Contents", "Resources");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  assert.equal(version, pkg.version, "DMG App version must match package.json");

  const port = 17000 + Math.floor(Math.random() * 1000);
  child = spawn(executable, [], {
    env: { ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_CONTROL_PORT: String(port) },
    stdio: "ignore",
    detached: true,
  });
  const auth = join(configDir, "auth.json");
  await waitFor(() => existsSync(auth) && statSync(auth).size > 0, 20_000, "DevSpace.app did not initialize auth.json");
  assert.equal(statSync(auth).mode & 0o777, 0o600, "auth.json must be mode 0600");
  assert.equal(child.exitCode, null, "DevSpace.app exited during cold start");

  const nativeHostDir = join(temporary, "native-host");
  const chromeHostsDir = join(temporary, "chrome-hosts");
  execFileSync(join(resources, "runtime", "node"), [join(resources, "devspace", "native-host", "install.mjs")], {
    env: {
      ...process.env,
      DEVSPACE_BROWSER_NATIVE_HOST_DIR: nativeHostDir,
      DEVSPACE_CHROME_NATIVE_HOSTS_DIR: chromeHostsDir,
    },
    stdio: "ignore",
  });
  assert.equal(existsSync(join(chromeHostsDir, "com.devspace.browser_bridge.json")), true, "bundled Browser Native Host installer failed");
  const browserReleases = join(resources, "devspace", "releases");
  assert.equal(existsSync(browserReleases), true, "bundled Browser release directory is missing");

  console.log(`release DMG acceptance passed: ${basename(dmg)} (v${version})`);
} finally {
  await terminateProcessGroup(child);
  try { execFileSync("/usr/bin/hdiutil", ["detach", "-force", mountPoint], { stdio: "ignore" }); } catch {}
  rmSync(temporary, { recursive: true, force: true });
}

async function terminateProcessGroup(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  try {
    await waitFor(() => !processExists(child.pid), 3_000);
  } catch {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await waitFor(() => !processExists(child.pid), 2_000).catch(() => undefined);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, message = "timed out") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(message);
}
