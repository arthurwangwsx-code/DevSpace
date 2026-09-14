#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_RELEASE_API = "https://api.github.com/repos/openai/tunnel-client/releases/latest";

export function selectReleaseAsset(release, platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") throw new Error(`tunnel-client installer currently supports macOS only, got ${platform}`);
  const platformName = arch === "arm64" ? "darwin-arm64" : arch === "x64" ? "darwin-amd64" : undefined;
  if (!platformName) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const tag = String(release?.tag_name ?? "");
  if (!tag) throw new Error("Latest tunnel-client release has no tag_name.");
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const archive = assets.find((asset) => typeof asset?.name === "string"
    && asset.name.startsWith(`tunnel-client-${tag}-`)
    && asset.name.endsWith(`-${platformName}.zip`));
  const checksums = assets.find((asset) => asset?.name === "SHA256SUMS.txt");
  if (!archive?.browser_download_url) throw new Error(`No official tunnel-client ${platformName} ZIP was found in ${tag}.`);
  if (!checksums?.browser_download_url) throw new Error(`No SHA256SUMS.txt was found in ${tag}.`);
  return { tag, platformName, archive, checksums };
}

export function checksumFor(checksumsText, assetName) {
  for (const line of String(checksumsText).split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS.txt does not contain ${assetName}.`);
}

export async function installTunnelClient(options = {}) {
  const releaseApi = options.releaseApi ?? process.env.DEVSPACE_TUNNEL_CLIENT_RELEASE_API ?? OFFICIAL_RELEASE_API;
  const installPath = resolve(options.installPath ?? process.env.DEVSPACE_TUNNEL_CLIENT_PATH ?? join(homedir(), ".local", "bin", "tunnel-client"));
  const release = await fetchJson(releaseApi);
  const selected = selectReleaseAsset(release, options.platform, options.arch);
  const [archiveBytes, checksumsText] = await Promise.all([
    fetchBytes(selected.archive.browser_download_url),
    fetchText(selected.checksums.browser_download_url),
  ]);
  const expected = checksumFor(checksumsText, selected.archive.name);
  const actual = createHash("sha256").update(archiveBytes).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${selected.archive.name}: expected ${expected}, got ${actual}`);

  const temporary = mkdtempSync(join(tmpdir(), "devspace-tunnel-client-"));
  try {
    const archivePath = join(temporary, basename(selected.archive.name));
    const extracted = join(temporary, "extracted");
    mkdirSync(extracted, { recursive: true });
    writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
    execFileSync("/usr/bin/ditto", ["-x", "-k", archivePath, extracted], { stdio: "ignore" });
    const binary = findFile(extracted, "tunnel-client");
    if (!binary) throw new Error("Downloaded tunnel-client archive does not contain the tunnel-client executable.");
    mkdirSync(dirname(installPath), { recursive: true, mode: 0o700 });
    copyFileSync(binary, installPath);
    chmodSync(installPath, 0o755);
    const version = execFileSync(installPath, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
    return { installed: true, installPath, version, release: selected.tag, asset: selected.archive.name, sha256: actual };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "DevSpace" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Unable to query tunnel-client release (${response.status}).`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { "User-Agent": "DevSpace" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Unable to download ${url} (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "DevSpace" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Unable to download ${url} (${response.status}).`);
  return response.text();
}

function findFile(root, name) {
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    const stat = statSync(candidate);
    if (stat.isFile() && entry === name) return candidate;
    if (stat.isDirectory()) {
      const nested = findFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await installTunnelClient(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
