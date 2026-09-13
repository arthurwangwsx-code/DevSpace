#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ supported: false, platform: process.platform }));
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const uid = process.getuid?.() ?? Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());
const port = Number(args.port ?? 7676);
const label = args.label ?? `com.devspace.${uid}.${port}`;
const plistPath = resolve(args["plist-path"] ?? join(homedir(), "Library", "LaunchAgents", `${label}.plist`));
const url = args.url ?? `http://127.0.0.1:${port}/healthz`;
const requireCurrentSource = args["require-current-source"] === "true";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedSourceCommit = requireCurrentSource ? sourceRevision(packageRoot) : undefined;

let plist;
if (existsSync(plistPath)) {
  try {
    plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8" }));
  } catch {}
}

let launchctl;
try {
  const output = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
  launchctl = {
    loaded: true,
    state: output.match(/\bstate = ([^\n]+)/)?.[1]?.trim(),
    pid: Number(output.match(/\bpid = (\d+)/)?.[1]) || undefined,
  };
} catch {
  launchctl = { loaded: false };
}

let health;
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "error" });
  const contentType = response.headers.get("content-type") ?? "";
  health = contentType.includes("application/json") ? await response.json() : { ok: false, httpStatus: response.status };
} catch (error) {
  health = { ok: false, error: error instanceof Error ? error.name : "probe_error" };
}

const programArguments = Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments : [];
const supervisorPath = programArguments.find((value) => typeof value === "string" && value.endsWith("service-supervisor.mjs"));
const plistOwnedByDevSpace = typeof supervisorPath === "string"
  && supervisorPath.includes("/Application Support/DevSpace/runtime/");
const releaseId = plist?.EnvironmentVariables?.DEVSPACE_RELEASE_ID;
const configuredToolMode = plist?.EnvironmentVariables?.DEVSPACE_TOOL_MODE;
const runningReleaseId = health?.release?.id;
const sourceMatchesCurrent = !requireCurrentSource
  || health?.release?.sourceCommit === expectedSourceCommit;
const restartRequired = Boolean(plistOwnedByDevSpace && launchctl.loaded && (
  (releaseId && runningReleaseId !== releaseId) || !sourceMatchesCurrent
));
const healthy = Boolean(
  plistOwnedByDevSpace
  && launchctl.loaded
  && launchctl.state === "running"
  && health?.ok === true
  && configuredToolMode === health?.toolMode
  && !restartRequired,
);

console.log(JSON.stringify({
  supported: true,
  healthy,
  restartRequired,
  label,
  plistPath,
  plistExists: existsSync(plistPath),
  plistOwnedByDevSpace,
  supervisorPath,
  releaseId,
  configuredToolMode,
  runningToolMode: health?.toolMode,
  expectedSourceCommit,
  sourceMatchesCurrent,
  launchctl,
  health,
}));
if (!healthy) process.exitCode = restartRequired ? 3 : 1;

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    if (token === "--require-current-source") {
      result["require-current-source"] = "true";
      continue;
    }
    const value = values[++index];
    if (!value) throw new Error(`${token} requires a value`);
    result[token.slice(2)] = value;
  }
  return result;
}

function sourceRevision(root) {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
