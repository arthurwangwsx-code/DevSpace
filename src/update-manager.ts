import { execFileSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gt } from "semver";
import { devspaceConfigDir, loadDevspaceFiles } from "./user-config.js";

const DEFAULT_REPOSITORY = "arthurwangwsx-code/DevSpace";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ReleaseArtifact {
  name: string;
  url: string;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  tag: string;
  channel: "stable" | "beta";
  minimumMacOS: string;
  artifacts: Record<string, ReleaseArtifact>;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  channel: string;
  artifact?: ReleaseArtifact;
  manifest: ReleaseManifest;
}

export interface InstallAppOptions {
  sourceApp: string;
  targetApp?: string;
  activateService?: boolean;
  launchApp?: boolean;
  version?: string;
}

export interface InstallAppResult {
  targetApp: string;
  installedVersion: string;
  previousVersion?: string;
  backupApp?: string;
  serviceActivated: boolean;
}

export interface UpdateResult extends InstallAppResult {
  downloadedArtifact: string;
}

export function currentVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  if (!packageJson.version) throw new Error("DevSpace package version is missing.");
  return packageJson.version;
}

export function defaultInstallTarget(): string {
  const app = runningAppBundle();
  if (app) return app;
  return join(homedir(), "Applications", "DevSpace.app");
}

export function runningAppBundle(): string | undefined {
  const marker = `${join("Contents", "Resources", "devspace")}`;
  const normalized = packageRoot.replaceAll("\\", "/");
  const index = normalized.lastIndexOf(`/${marker.replaceAll("\\", "/")}`);
  return index >= 0 ? normalized.slice(0, index) : undefined;
}

export async function checkForUpdates(options: { repository?: string; manifestUrl?: string } = {}): Promise<UpdateCheckResult> {
  const repository = options.repository ?? process.env.DEVSPACE_UPDATE_REPOSITORY ?? DEFAULT_REPOSITORY;
  const manifestUrl = options.manifestUrl
    ?? process.env.DEVSPACE_UPDATE_MANIFEST_URL
    ?? `https://github.com/${repository}/releases/latest/download/release.json`;
  const response = await fetch(manifestUrl, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Unable to fetch DevSpace release manifest: HTTP ${response.status}`);
  const manifest = validateManifest(await response.json());
  const platformKey = artifactPlatformKey();
  const artifact = manifest.artifacts[platformKey];
  const current = currentVersion();
  return {
    currentVersion: current,
    latestVersion: manifest.version,
    updateAvailable: gt(manifest.version, current),
    channel: manifest.channel,
    artifact,
    manifest,
  };
}

export async function updateDevSpace(options: {
  targetApp?: string;
  force?: boolean;
  manifestUrl?: string;
  repository?: string;
  launchApp?: boolean;
} = {}): Promise<UpdateResult> {
  assertMacOS();
  const check = await checkForUpdates(options);
  if (!check.artifact) throw new Error(`No release artifact is available for ${artifactPlatformKey()}.`);
  if (!check.updateAvailable && !options.force) {
    throw new Error(`DevSpace ${check.currentVersion} is already up to date.`);
  }
  const temp = mkdtempSync(join(tmpdir(), "devspace-update-"));
  try {
    const archive = join(temp, check.artifact.name);
    await downloadTo(check.artifact.url, archive);
    const actual = sha256File(archive);
    if (actual !== check.artifact.sha256.toLowerCase()) {
      throw new Error(`Release checksum mismatch for ${check.artifact.name}.`);
    }
    const extracted = join(temp, "extracted");
    mkdirSync(extracted, { recursive: true });
    execFileSync("/usr/bin/ditto", ["-x", "-k", archive, extracted], { stdio: "pipe" });
    const sourceApp = join(extracted, "DevSpace.app");
    if (!existsSync(sourceApp)) throw new Error("Downloaded DevSpace archive does not contain DevSpace.app.");
    const targetApp = resolve(options.targetApp ?? defaultInstallTarget());
    const result = installApp({
      sourceApp,
      targetApp,
      activateService: hasInstalledServiceForTarget(targetApp),
      launchApp: options.launchApp ?? false,
      version: check.latestVersion,
    });
    return { ...result, downloadedArtifact: check.artifact.name };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function installApp(options: InstallAppOptions): InstallAppResult {
  assertMacOS();
  const sourceApp = resolve(options.sourceApp);
  const targetApp = resolve(options.targetApp ?? defaultInstallTarget());
  if (!existsSync(join(sourceApp, "Contents", "MacOS", "DevSpace"))) {
    throw new Error(`Invalid DevSpace.app source: ${sourceApp}`);
  }
  verifyBundle(sourceApp);
  mkdirSync(dirname(targetApp), { recursive: true });
  const sourceVersion = options.version ?? appVersion(sourceApp);
  const previousVersion = existsSync(targetApp) ? appVersion(targetApp) : undefined;
  const backupApp = existsSync(targetApp) ? backupTarget(targetApp, previousVersion ?? "unknown") : undefined;
  const staged = `${targetApp}.installing-${process.pid}`;
  rmSync(staged, { recursive: true, force: true });
  try {
    cpSync(sourceApp, staged, { recursive: true, dereference: false, preserveTimestamps: true });
    verifyBundle(staged);
    rmSync(targetApp, { recursive: true, force: true });
    movePath(staged, targetApp);
    const activate = options.activateService ?? hasInstalledServiceForTarget(targetApp);
    if (activate) installServiceFromApp(targetApp, true);
    writeUpdateState({ currentVersion: sourceVersion, previousVersion, targetApp, backupApp, updatedAt: new Date().toISOString() });
    if (options.launchApp === true) execFileSync("/usr/bin/open", [targetApp], { stdio: "ignore" });
    return { targetApp, installedVersion: sourceVersion, previousVersion, backupApp, serviceActivated: activate };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (backupApp && existsSync(backupApp) && !existsSync(targetApp)) movePath(backupApp, targetApp);
    throw error;
  }
}

export function rollbackDevSpace(options: { targetApp?: string; launchApp?: boolean } = {}): InstallAppResult {
  assertMacOS();
  const state = readUpdateState();
  const targetApp = resolve(options.targetApp ?? state?.targetApp ?? defaultInstallTarget());
  const backupApp = state?.backupApp;
  if (!backupApp || !existsSync(backupApp)) throw new Error("No DevSpace rollback backup is available.");
  const restoreVersion = appVersion(backupApp);
  const current = existsSync(targetApp) ? appVersion(targetApp) : undefined;
  const failedBackup = existsSync(targetApp) ? backupTarget(targetApp, `${current ?? "unknown"}-rollback`) : undefined;
  rmSync(targetApp, { recursive: true, force: true });
  movePath(backupApp, targetApp);
  verifyBundle(targetApp);
  const activate = hasInstalledServiceForTarget(targetApp);
  if (activate) installServiceFromApp(targetApp, true);
  writeUpdateState({ currentVersion: restoreVersion, previousVersion: current, targetApp, backupApp: failedBackup, updatedAt: new Date().toISOString() });
  if (options.launchApp === true) execFileSync("/usr/bin/open", [targetApp], { stdio: "ignore" });
  return { targetApp, installedVersion: restoreVersion, previousVersion: current, backupApp: failedBackup, serviceActivated: activate };
}

export function uninstallDevSpace(options: { targetApp?: string; purgeConfig?: boolean } = {}): { removedApp: string; configPreserved: boolean } {
  assertMacOS();
  const targetApp = resolve(options.targetApp ?? defaultInstallTarget());
  if (hasInstalledServiceForTarget(targetApp)) disableService();
  rmSync(targetApp, { recursive: true, force: true });
  if (options.purgeConfig) rmSync(devspaceConfigDir(), { recursive: true, force: true });
  return { removedApp: targetApp, configPreserved: !options.purgeConfig };
}

export function validateManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release manifest must be an object.");
  const input = value as Partial<ReleaseManifest>;
  if (input.schemaVersion !== 1 || typeof input.version !== "string" || typeof input.tag !== "string") {
    throw new Error("Unsupported DevSpace release manifest.");
  }
  if (input.channel !== "stable" && input.channel !== "beta") throw new Error("Invalid release channel.");
  if (!input.artifacts || typeof input.artifacts !== "object") throw new Error("Release manifest has no artifacts.");
  for (const [key, artifact] of Object.entries(input.artifacts)) {
    if (!artifact || typeof artifact.name !== "string" || typeof artifact.url !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      throw new Error(`Invalid release artifact: ${key}`);
    }
  }
  return input as ReleaseManifest;
}

function artifactPlatformKey(): string {
  if (process.platform !== "darwin") return `${process.platform}-${process.arch}`;
  return `darwin-${process.arch === "x64" ? "x64" : "arm64"}`;
}

async function downloadTo(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Unable to download ${basename(destination)}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Download response for ${basename(destination)} had no body.`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { mode: 0o600 }));
}

function sha256File(path: string): string {
  return execFileSync("/usr/bin/shasum", ["-a", "256", path], { encoding: "utf8" }).trim().split(/\s+/)[0];
}

function appVersion(app: string): string {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function verifyBundle(app: string): void {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
}

function backupTarget(targetApp: string, version: string): string {
  const backupDir = join(devspaceConfigDir(), "releases", version);
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `DevSpace-${Date.now()}.app`);
  movePath(targetApp, backup);
  return backup;
}

function movePath(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw error;
    cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    rmSync(source, { recursive: true, force: true });
  }
}

function serviceIdentity(): { label: string; plist: string } {
  const port = loadDevspaceFiles().config.port ?? 7676;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const label = `com.devspace.${uid}.${port}`;
  return { label, plist: join(homedir(), "Library", "LaunchAgents", `${label}.plist`) };
}

function hasInstalledServiceForTarget(targetApp: string): boolean {
  const plist = serviceIdentity().plist;
  if (!existsSync(plist)) return false;
  try {
    return readFileSync(plist, "utf8").includes(resolve(targetApp));
  } catch {
    return false;
  }
}

function installServiceFromApp(app: string, activate: boolean): void {
  const node = join(app, "Contents", "Resources", "runtime", "node");
  const root = join(app, "Contents", "Resources", "devspace");
  const script = join(root, "scripts", "macos", "install-service.mjs");
  const cli = join(root, "dist", "cli.js");
  const args = [script, "--node", node, "--devspace-bin", cli];
  if (activate) args.push("--activate");
  execFileSync(node, args, { stdio: "pipe" });
}

function disableService(): void {
  const identity = serviceIdentity();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  try { execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, identity.label], { stdio: "ignore" }); } catch {}
  rmSync(identity.plist, { force: true });
}

interface UpdateState {
  currentVersion: string;
  previousVersion?: string;
  targetApp: string;
  backupApp?: string;
  updatedAt: string;
}

function updateStatePath(): string {
  return join(devspaceConfigDir(), "update-state.json");
}

function writeUpdateState(state: UpdateState): void {
  mkdirSync(devspaceConfigDir(), { recursive: true });
  writeFileSync(updateStatePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function readUpdateState(): UpdateState | undefined {
  try { return JSON.parse(readFileSync(updateStatePath(), "utf8")) as UpdateState; } catch { return undefined; }
}

function assertMacOS(): void {
  if (process.platform !== "darwin") throw new Error("DevSpace App installation and update currently support macOS only.");
}
