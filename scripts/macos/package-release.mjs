#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("DevSpace macOS release packaging requires macOS.");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const outputDir = resolve(process.argv[2] ?? join(root, ".build", "release", `v${pkg.version}`));
const app = join(root, ".build", "DevSpace.app");
if (!existsSync(app)) throw new Error(`Missing ${app}; run npm run build:control-center-app first.`);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });

const base = `DevSpace-macOS-${arch}-v${pkg.version}`;
const zip = join(outputDir, `${base}.zip`);
const dmg = join(outputDir, `${base}.dmg`);
execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip], { stdio: "inherit" });

const stage = join(outputDir, ".dmg-stage");
mkdirSync(stage, { recursive: true });
cpSync(app, join(stage, "DevSpace.app"), { recursive: true });
symlinkSync("/Applications", join(stage, "Applications"));
execFileSync("/usr/bin/hdiutil", ["create", "-quiet", "-volname", `DevSpace ${pkg.version}`, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

let gatekeeper = "not-assessed";
try {
  execFileSync("/usr/sbin/spctl", ["--assess", "--type", "exec", "--verbose=2", app], { stdio: "pipe" });
  gatekeeper = "accepted";
} catch (error) {
  gatekeeper = "not-accepted";
  if (process.env.DEVSPACE_REQUIRE_GATEKEEPER === "1") throw error;
}

if (process.env.DEVSPACE_NOTARY_PROFILE) {
  execFileSync("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", process.env.DEVSPACE_NOTARY_PROFILE, "--wait"], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
}

const hashes = [zip, dmg].map((file) => `${sha256(file)}  ${file.split("/").pop()}`).join("\n") + "\n";
const sums = join(outputDir, "SHA256SUMS.txt");
writeFileSync(sums, hashes);
console.log(JSON.stringify({ version: pkg.version, arch, app, dmg, zip, sums, gatekeeper, notarized: Boolean(process.env.DEVSPACE_NOTARY_PROFILE) }, null, 2));

function sha256(file) {
  return execFileSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" }).trim().split(/\s+/)[0];
}
