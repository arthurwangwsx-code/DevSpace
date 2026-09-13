#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("DevSpace macOS service installation requires macOS.");
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const uid = process.getuid?.() ?? Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const node = resolve(args.node ?? process.execPath);
const devspaceBin = resolve(args["devspace-bin"] ?? findExecutable("devspace") ?? join(packageRoot, "dist", "cli.js"));
const host = args.host ?? "127.0.0.1";
const port = integer(args.port ?? "7676", "port", 1, 65535);
const toolMode = choice(args["tool-mode"] ?? "codex", "tool-mode", ["minimal", "full", "codex"]);
const roots = args.root ?? join(homedir(), "project");
const configDir = resolve(args["config-dir"] ?? join(homedir(), ".devspace"));
const stateDir = resolve(args["state-dir"] ?? join(homedir(), ".local", "share", "devspace"));
const worktreeRoot = resolve(args["worktree-root"] ?? join(homedir(), ".devspace", "worktrees"));
const runtimeRoot = resolve(args["runtime-root"] ?? join(homedir(), "Library", "Application Support", "DevSpace", "runtime"));
const label = args.label ?? `com.devspace.${uid}.${port}`;
const logDir = resolve(args["log-dir"] ?? join(homedir(), ".local", "state", "devspace-service"));
const plistPath = resolve(args["plist-path"] ?? join(homedir(), "Library", "LaunchAgents", `${label}.plist`));
const releaseId = args["release-id"] ?? `${packageJson.version}+${sourceRevision(packageRoot)}`;
const supervisorSource = join(packageRoot, "scripts", "macos", "service-supervisor.mjs");
const supervisorTarget = join(runtimeRoot, "service-supervisor.mjs");
const activatorSource = join(packageRoot, "scripts", "macos", "activate-service.mjs");
const activatorTarget = join(runtimeRoot, "activate-service.mjs");
const pidFile = join(logDir, "devspace.pid");
const logFile = join(logDir, "devspace.log");
const activationLogFile = join(logDir, "activation.log");
const activationStatusPath = join(logDir, "activation-status.json");
const persistedConfig = readPersistedConfig(configDir);
const configuredRoots = Array.isArray(persistedConfig.allowedRoots) && persistedConfig.allowedRoots.length > 0
  ? persistedConfig.allowedRoots.join(",")
  : roots;

if (!existsSync(devspaceBin)) throw new Error(`DevSpace executable does not exist: ${devspaceBin}`);
if (!existsSync(node)) throw new Error(`Node executable does not exist: ${node}`);
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
mkdirSync(logDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(plistPath), { recursive: true });
copyFileSync(supervisorSource, supervisorTarget);
copyFileSync(activatorSource, activatorTarget);

const environment = {
  PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOST: host,
  PORT: String(port),
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_ALLOWED_ROOTS: configuredRoots,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_WORKTREE_ROOT: worktreeRoot,
  DEVSPACE_TOOL_MODE: toolMode,
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_BROWSER_EXTENSION: "1",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_REQUESTS: "0",
  DEVSPACE_LOG_TOOL_CALLS: "0",
  DEVSPACE_LOG_FORMAT: "pretty",
  DEVSPACE_MCP_MAX_REQUEST_BYTES: "16777216",
  DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS: "32",
  DEVSPACE_MCP_MAX_QUEUED_REQUESTS: "64",
  DEVSPACE_PROCESS_MAX_CONCURRENT: "4",
  DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE: "2",
  DEVSPACE_PROCESS_MAX_SESSIONS: "32",
  DEVSPACE_MCP_MAX_SESSIONS: "512",
  DEVSPACE_MCP_MAX_IDLE_SESSIONS: "128",
  DEVSPACE_WORKSPACE_MEMORY_IDLE_TIMEOUT_SECONDS: "14400",
  DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS: "43200",
  DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_SECONDS: "30",
  DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT: "65",
  DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT: "80",
  DEVSPACE_LOG_SLOW_REQUEST_MS: "3000",
  DEVSPACE_LOG_SLOW_TOOL_CALL_MS: "5000",
  DEVSPACE_LOG_EVENT_LOOP_LAG_MS: "1000",
  DEVSPACE_ASYNC_LOG_FILE: join(logDir, "events.log"),
  DEVSPACE_ASYNC_LOG_MAX_BYTES: "67108864",
  DEVSPACE_ASYNC_LOG_BACKUPS: "3",
  DEVSPACE_ASYNC_LOG_MAX_QUEUED_LINES: "8192",
  DEVSPACE_RELEASE_ID: releaseId,
  DEVSPACE_SOURCE_COMMIT: sourceRevision(packageRoot),
  NODE_OPTIONS: "--max-old-space-size=4096",
};

const plist = renderPlist({
  label,
  programArguments: [
    node,
    supervisorTarget,
    "server",
    pidFile,
    `http://${host}:${port}/healthz`,
    "-",
    "--",
    node,
    devspaceBin,
    "serve",
  ],
  environment,
  logFile,
});

if (existsSync(plistPath)) {
  const current = readFileSync(plistPath, "utf8");
  if (current !== plist) {
    const backup = `${plistPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(plistPath, backup);
    console.error(`Previous LaunchAgent moved to ${backup}`);
  }
}
writeFileSync(plistPath, plist, { mode: 0o600 });
execFileSync("plutil", ["-lint", plistPath], { stdio: "ignore" });

let activationId;
if (args.activate === "true") {
  // Activation can be requested through the DevSpace service being replaced.
  // A detached process group must own bootout/bootstrap; otherwise bootout
  // terminates the calling exec_command before it can restore the service.
  const logFd = openSync(activationLogFile, "a", 0o600);
  activationId = `${Date.now()}-${process.pid}`;
  const activationStatusTemporary = `${activationStatusPath}.${process.pid}.tmp`;
  writeFileSync(activationStatusTemporary, `${JSON.stringify({
    state: "scheduled",
    activationId,
    label,
    service: `gui/${uid}/${label}`,
    requestedByPid: process.pid,
    updatedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  renameSync(activationStatusTemporary, activationStatusPath);
  try {
    const activationArgs = [
      activatorTarget,
      "--uid", String(uid),
      "--label", label,
      "--plist", plistPath,
      "--health", `http://${host}:${port}/healthz`,
      "--status", activationStatusPath,
      "--activation-id", activationId,
      "--delay-ms", args["activation-delay-ms"] ?? "1500",
      "--timeout-ms", args["activation-timeout-ms"] ?? "30000",
    ];
    if (args.launchctl) activationArgs.push("--launchctl", resolve(args.launchctl));
    const activator = spawn(node, activationArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    activator.unref();
  } finally {
    closeSync(logFd);
  }
}

console.log(JSON.stringify({
  installed: true,
  activated: args.activate === "true",
  label,
  plistPath,
  supervisorTarget,
  devspaceBin,
  node,
  host,
  port,
  configDir,
  stateDir,
  worktreeRoot,
  toolMode,
  releaseId,
  activationStatusPath: args.activate === "true" ? activationStatusPath : undefined,
  activationId,
}));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "activate") { result.activate = "true"; continue; }
    const value = values[++index];
    if (!value) throw new Error(`${token} requires a value`);
    result[key] = value;
  }
  return result;
}

function findExecutable(name) {
  try { return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || undefined; }
  catch { return undefined; }
}

function readPersistedConfig(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function sourceRevision(root) {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function integer(raw, name, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}`);
  return value;
}

function choice(raw, name, values) {
  if (!values.includes(raw)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return raw;
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function renderPlist({ label, programArguments, environment, logFile }) {
  const array = programArguments.map((value) => `      <string>${escapeXml(value)}</string>`).join("\n");
  const env = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${escapeXml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${array}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Standard</string>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>\n  <key>StandardOutPath</key>\n  <string>${escapeXml(logFile)}</string>\n  <key>StandardErrorPath</key>\n  <string>${escapeXml(logFile)}</string>\n</dict>\n</plist>\n`;
}
