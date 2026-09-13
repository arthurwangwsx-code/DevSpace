#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ supported: false, platform: process.platform }));
  process.exit(0);
}

const requestPermissions = process.argv.includes("--request-permissions");
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
  const permissionProbe = spawnSync(
    executablePath,
    [requestPermissions ? "--request-permissions" : "--permission-status"],
    { encoding: "utf8", timeout: 30_000 },
  );
  let permissions;
  try {
    permissions = JSON.parse(permissionProbe.stdout.trim());
  } catch {
    permissions = {
      probeFailed: true,
      exitCode: permissionProbe.status,
      stderr: permissionProbe.stderr.trim().slice(0, 500),
    };
  }
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
    permissionRequestAttempted: requestPermissions,
    infoPlistBytes: readFileSync(infoPath).byteLength,
  }));
  if (verify.status !== 0) process.exitCode = 1;
  if (permissionProbe.error || (permissionProbe.status !== 0 && permissionProbe.status !== 2)) process.exitCode = 1;
}
