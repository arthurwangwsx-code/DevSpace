#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { SystemSessionStateProbe } from "../src/capabilities/session-state.js";

type Lane = "core" | "locked" | "unlocked" | "browser-transition";
type Gate = { name: string; command: string; args: string[]; state?: "locked" | "unlocked" };
type GateResult = {
  name: string;
  passed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  log: string;
  sessionLocked: boolean;
  failureTail?: string;
};

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(options.outputRoot, runId);
const childOutputRoot = join(artifactDir, "receipts");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const completeLaneGates = allGates()[options.lane];
const gates = selectGates(options.lane, options.only);
const session = await new SystemSessionStateProbe().probe(new AbortController().signal);

if (options.list) {
  console.log(JSON.stringify({ lane: options.lane, session, gates }, null, 2));
  process.exit(0);
}

await mkdir(childOutputRoot, { recursive: true });
let failure: string | undefined;
const results: GateResult[] = [];
try {
  assertLaneState(options.lane, session.locked);
  for (const gate of gates) {
    process.stdout.write(`[capability-release] START ${gate.name}\n`);
    const result = await runGate(gate);
    results.push(result);
    process.stdout.write(`[capability-release] ${result.passed ? "PASS" : "FAIL"} ${gate.name} ${result.durationMs}ms\n`);
    if (!result.passed && !options.continueOnFailure) break;
  }
  const failed = results.filter(({ passed }) => !passed);
  const missing = gates.slice(results.length).map(({ name }) => name);
  if (failed.length > 0 || missing.length > 0) {
    failure = [
      failed.length > 0 ? `failed gates: ${failed.map(({ name }) => name).join(", ")}` : "",
      missing.length > 0 ? `not run: ${missing.join(", ")}` : "",
    ].filter(Boolean).join("; ");
  }
} catch (error) {
  failure = safeError(error);
}

const [{ stdout: commit }, { stdout: status }] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }),
  execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: process.cwd() }),
]);
const dirtyPaths = status.trim().split("\n").filter(Boolean);
const sourceDirtyPaths = dirtyPaths.filter(isRuntimeSourceStatus);
const selectedGatesPassed = failure === undefined
  && results.length === gates.length
  && results.every(({ passed }) => passed);
const report = {
  ok: selectedGatesPassed,
  releaseEligible: options.only.size === 0
    && selectedGatesPassed
    && results.length === completeLaneGates.length
    && sourceDirtyPaths.length === 0,
  lane: options.lane,
  selection: options.only.size === 0 ? "complete-lane" : "targeted-rerun",
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  source: { commit: commit.trim(), dirtyPaths, sourceDirtyPaths },
  session: { awake: session.awake, loggedIn: session.loggedIn, locked: session.locked },
  gates: results,
  requiredGates: completeLaneGates.map(({ name }) => name),
  selectedGates: gates.map(({ name }) => name),
  ...(failure ? { failure } : {}),
};
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, lane: report.lane, artifactDir, gates: results.length, failure }));
if (!report.ok) process.exitCode = 1;

function allGates(): Record<Lane, Gate[]> {
  const core: Gate[] = [
    npmGate("typecheck", ["run", "typecheck"]),
    npmGate("unit_and_integration", ["test"]),
    npmGate("production_build", ["run", "build"]),
    {
      name: "capability_stress_smoke",
      command: process.execPath,
      args: ["dist/stress/capability-cli.js", "--profile", "smoke", "--output", join(childOutputRoot, "capability-smoke")],
    },
    npmGate("real_external_mcp_mount", ["run", "test:real-mcp-mount", "--", "--output", join(childOutputRoot, "real-mcp-mount")]),
  ];
  const productionDesktop = npmGate("production_desktop_reload", [
    "run", "test:desktop-provider-performance", "--", "--output", join(childOutputRoot, "desktop-provider"),
    "--rest-samples", "20", "--mcp-samples", "10", "--reload-provider",
  ]);
  const productionService = npmGate("production_service_identity", [
    "run", "doctor:macos-service", "--", "--require-current-source",
  ]);
  const productionBrowser = npmGate("production_browser_real_smoke", [
    "run", "test:browser-control:real",
  ]);
  return {
    core,
    locked: [
      ...core,
      productionService,
      { ...npmGate("desktop_lock_boundary", ["run", "test:desktop-lock-boundary"]), state: "locked" },
      { ...productionDesktop, state: "locked" },
    ],
    unlocked: [
      ...core,
      productionService,
      { ...productionBrowser, state: "unlocked" },
      { ...npmGate("direct_desktop_helper_fixture", ["run", "test:desktop-helper"]), state: "unlocked" },
      { ...npmGate("production_desktop_fixture", [
        "run", "test:desktop-runtime-fixture", "--", "--output", join(childOutputRoot, "desktop-runtime-fixture"),
      ]), state: "unlocked" },
      { ...productionDesktop, state: "unlocked" },
    ],
    "browser-transition": [productionService, {
      ...npmGate("production_browser_lock_matrix", [
        "run", "test:browser-extension", "--", "--base-url", options.baseUrl,
        "--output", join(childOutputRoot, "browser-extension-matrix"),
      ]),
      state: "unlocked",
    }],
  };
}

function selectGates(lane: Lane, only: Set<string>): Gate[] {
  const selected = allGates()[lane];
  if (only.size === 0) return selected;
  const known = new Set(selected.map(({ name }) => name));
  for (const name of only) assert.equal(known.has(name), true, `unknown gate for ${lane}: ${name}`);
  return selected.filter(({ name }) => only.has(name));
}

function npmGate(name: string, args: string[]): Gate { return { name, command: npm, args }; }

function assertLaneState(lane: Lane, locked: boolean): void {
  if (lane === "locked") assert.equal(locked, true, "locked release lane requires a locked macOS session");
  if (lane === "unlocked" || lane === "browser-transition") {
    assert.equal(locked, false, `${lane} release lane must start while macOS is unlocked`);
  }
}

async function runGate(gate: Gate): Promise<GateResult> {
  const currentSession = await new SystemSessionStateProbe().probe(new AbortController().signal);
  if (gate.state === "locked") assert.equal(currentSession.locked, true, `${gate.name} requires locked session`);
  if (gate.state === "unlocked") assert.equal(currentSession.locked, false, `${gate.name} requires unlocked session`);
  const relativeLog = `logs/${gate.name}.log`;
  const absoluteLog = join(artifactDir, relativeLog);
  await mkdir(join(artifactDir, "logs"), { recursive: true });
  const output = createWriteStream(absoluteLog, { flags: "wx", mode: 0o600 });
  const started = performance.now();
  const child = (await import("node:child_process")).spawn(gate.command, gate.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateChildGroup(child.pid, "SIGTERM");
    setTimeout(() => terminateChildGroup(child.pid, "SIGKILL"), 5_000).unref();
  }, options.timeoutMs);
  timeout.unref();
  const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveDone) => {
    child.once("error", () => resolveDone({ exitCode: null, signal: null }));
    child.once("close", (exitCode, signal) => resolveDone({ exitCode, signal }));
  });
  clearTimeout(timeout);
  await new Promise<void>((resolveDone) => output.end(resolveDone));
  const passed = !timedOut && completion.exitCode === 0;
  return {
    name: gate.name,
    passed,
    exitCode: completion.exitCode,
    signal: completion.signal,
    durationMs: round(performance.now() - started),
    log: relativeLog,
    sessionLocked: currentSession.locked,
    ...(!passed ? { failureTail: await readTail(absoluteLog, 4_096, timedOut ? "gate timed out\n" : "") } : {}),
  };
}

function terminateChildGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function readTail(path: string, maxBytes: number, prefix: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const value = await readFile(path);
  return `${prefix}${value.subarray(Math.max(0, value.length - maxBytes)).toString("utf8")}`;
}

function parseOptions(args: string[]) {
  let lane: Lane = "core";
  let outputRoot = resolve(".build/capability-release");
  let baseUrl = "http://127.0.0.1:7676/api/capabilities/v1";
  let timeoutMs = 30 * 60_000;
  let list = false;
  let continueOnFailure = false;
  const only = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === "--list") { list = true; continue; }
    if (key === "--continue-on-failure") { continueOnFailure = true; continue; }
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--lane") {
      assert.equal(["core", "locked", "unlocked", "browser-transition"].includes(value), true, `unknown lane: ${value}`);
      lane = value as Lane;
    } else if (key === "--output") outputRoot = resolve(value);
    else if (key === "--base-url") baseUrl = normalizeBaseUrl(value);
    else if (key === "--timeout") timeoutMs = parseDuration(value);
    else if (key === "--only") value.split(",").filter(Boolean).forEach((name) => only.add(name));
    else throw new Error(`unknown option: ${key}`);
  }
  return { lane, outputRoot, baseUrl, timeoutMs, list, continueOnFailure, only };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("base URL must use http or https");
  return url.toString().replace(/\/$/, "");
}

function isRuntimeSourceStatus(statusLine: string): boolean {
  const porcelainPath = statusLine.slice(3).trim();
  const path = porcelainPath.includes(" -> ") ? porcelainPath.split(" -> ").at(-1)! : porcelainPath;
  return path === "package.json"
    || path === "package-lock.json"
    || path.startsWith("src/")
    || path.startsWith("scripts/")
    || path.startsWith("native/")
    || path.startsWith("native-host/")
    || path.startsWith("browser-extension/")
    || path.startsWith("tsconfig")
    || path.startsWith("vite.config.");
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error("timeout must use ms, s, m, or h suffix");
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const parsed = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("timeout is out of range");
  return parsed;
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.gates.map((gate) =>
    `| ${gate.passed ? "PASS" : "FAIL"} | ${gate.name} | ${gate.durationMs} | ${gate.log} |`).join("\n");
  return `# Capability release lane\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Release eligible: ${String(reportValue.releaseEligible)}\n- Lane: ${reportValue.lane}\n- Selection: ${reportValue.selection}\n- Commit: ${reportValue.source.commit}\n- Session locked: ${String(reportValue.session.locked)}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Gate | Duration ms | Log |\n| --- | --- | ---: | --- |\n${rows}\n`;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
