#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ supported: false, platform: process.platform }));
  process.exit(0);
}

const requestPermissions = process.argv.includes("--request-permissions");
const requirePermissions = process.argv.includes("--require-permissions");
const positional = process.argv.slice(2).find((value) => !value.startsWith("--"));
const bundlePath = resolve(positional ?? join(homedir(), "Applications", "DevSpaceDesktopHost.app"));
const infoPath = join(bundlePath, "Contents", "Info.plist");
const executablePath = join(bundlePath, "Contents", "MacOS", "devspace-desktop-helper");
if (!existsSync(infoPath) || !existsSync(executablePath)) {
  console.log(JSON.stringify({ supported: true, installed: false, bundlePath }));
  process.exitCode = 1;
} else {
  const signature = spawnSync("codesign", ["-dvvv", "--requirements", "-", bundlePath], {
    encoding: "utf8",
  });
  const detail = `${signature.stdout}${signature.stderr}`;
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", bundlePath], {
    encoding: "utf8",
  });
  const identifier = detail.match(/^Identifier=(.+)$/m)?.[1];
  const teamIdentifier = detail.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const adHoc = /^Signature=adhoc$/m.test(detail);
  const permissionProbe = probeAppPermissions(bundlePath, requestPermissions);
  const permissions = permissionProbe.permissions;
  const permissionsReady = permissions?.accessibilityTrusted === true
    && permissions?.screenCaptureGranted === true;
  console.log(JSON.stringify({
    supported: true,
    installed: true,
    bundlePath,
    executablePath,
    identifier,
    teamIdentifier: teamIdentifier === "not set" ? undefined : teamIdentifier,
    adHoc,
    signatureValid: verify.status === 0,
    stableSigningIdentity: verify.status === 0 && !adHoc && Boolean(teamIdentifier && teamIdentifier !== "not set"),
    permissions,
    permissionsReady,
    permissionsRequired: requirePermissions,
    permissionRequestAttempted: requestPermissions,
    permissionProbeTransport: "launch-services",
    infoPlistBytes: readFileSync(infoPath).byteLength,
  }));
  if (verify.status !== 0 || permissionProbe.failed) process.exitCode = 1;
  else if (requirePermissions && !permissionsReady) process.exitCode = 3;
}

function probeAppPermissions(bundlePath, requestPermissions) {
  const root = mkdtempSync(join(tmpdir(), "devspace-desktop-permission-probe-"));
  const stdoutPath = join(root, "stdout.json");
  const stderrPath = join(root, "stderr.log");
  try {
    const launched = spawnSync("/usr/bin/open", [
      "-n", "-j", bundlePath,
      "--stdout", stdoutPath,
      "--stderr", stderrPath,
      "--args", requestPermissions ? "--request-permissions" : "--permission-status",
    ], { encoding: "utf8", timeout: 10_000 });
    if (launched.error || launched.status !== 0) {
      return {
        failed: true,
        permissions: {
          probeFailed: true,
          exitCode: launched.status,
          stderr: `${launched.stderr ?? ""}${launched.error?.message ?? ""}`.trim().slice(0, 500),
        },
      };
    }
    const deadline = Date.now() + 30_000;
    while ((!existsSync(stdoutPath) || readFileSync(stdoutPath).byteLength === 0) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!existsSync(stdoutPath)) {
      return { failed: true, permissions: { probeFailed: true, stderr: "permission probe timed out" } };
    }
    try {
      return { failed: false, permissions: JSON.parse(readFileSync(stdoutPath, "utf8").trim()) };
    } catch {
      return {
        failed: true,
        permissions: {
          probeFailed: true,
          stderr: (existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "invalid permission response").trim().slice(0, 500),
        },
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
