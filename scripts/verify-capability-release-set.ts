#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

type Lane = "locked" | "unlocked" | "browser-transition";
type Check = { name: string; passed: boolean; actual: unknown; expected: string };
type Component = { name: string; path: string; checks: Check[]; passed: boolean };

const EXPECTED_LANE_GATES: Record<Lane, string[]> = {
  locked: [
    "production_service_identity",
    "typecheck",
    "unit_and_integration",
    "production_build",
    "capability_stress_smoke",
    "real_external_mcp_mount",
    "desktop_lock_boundary",
    "production_desktop_reload",
  ],
  unlocked: [
    "production_service_identity",
    "production_desktop_permissions",
    "typecheck",
    "unit_and_integration",
    "production_build",
    "capability_stress_smoke",
    "real_external_mcp_mount",
    "production_browser_real_smoke",
    "production_browser_open_world_readonly",
    "direct_desktop_helper_fixture",
    "production_desktop_fixture",
    "production_desktop_reload",
  ],
  "browser-transition": [
    "production_service_identity",
    "production_browser_lock_matrix",
  ],
};

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(options.outputRoot, runId);
await mkdir(artifactDir, { recursive: true });

const components = await Promise.all([
  validateLane("locked", options.locked),
  validateLane("unlocked", options.unlocked),
  validateLane("browser-transition", options.browserTransition),
  validateSoak(options.soak, options.acceptLegacySoak),
]);
const source = await sourceMetadata();
const releaseEligible = components.every(({ passed }) => passed)
  && source.runtimeSourceDirtyPaths.length === 0
  && !source.error;
const report = {
  ok: releaseEligible,
  releaseEligible,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  source,
  legacySoakWaiver: options.acceptLegacySoak,
  components,
};
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, releaseEligible, artifactDir }));
if (!releaseEligible) process.exitCode = 1;

async function validateLane(expectedLane: Lane, path: string): Promise<Component> {
  const checks: Check[] = [];
  try {
    const value = await readJson(path);
    check(checks, "lane_identity", value.lane, expectedLane);
    check(checks, "lane_result", value.ok, true);
    check(checks, "lane_release_eligible", value.releaseEligible, true);
    check(checks, "complete_lane_selection", value.selection, "complete-lane");
    const source = object(value.source);
    const dirty = array(source.sourceDirtyPaths);
    check(checks, "lane_runtime_source_clean", dirty.length, 0);
    const commit = typeof source.commit === "string" ? source.commit : "";
    check(checks, "lane_commit_present", commit.length > 0, true);
    const gates = array(value.gates).map(object);
    check(checks, "all_lane_gates_passed", gates.every((gate) => gate.passed === true), true);
    const required = array(value.requiredGates).map(String).sort();
    const executed = gates.map((gate) => String(gate.name)).sort();
    check(checks, "current_required_gates", required, [...EXPECTED_LANE_GATES[expectedLane]].sort());
    check(checks, "all_required_gates_executed", executed, required);
    if (commit) {
      check(checks, "lane_runtime_matches_head", await runtimeMatchesHead(commit), true);
    }
  } catch (error) {
    checks.push({ name: "receipt_readable", passed: false, actual: safeError(error), expected: "valid lane receipt" });
  }
  return { name: expectedLane, path, checks, passed: checks.length > 0 && checks.every(({ passed }) => passed) };
}

async function validateSoak(path: string, acceptLegacy: boolean): Promise<Component> {
  const checks: Check[] = [];
  try {
    const value = await readJson(path);
    check(checks, "soak_result", value.ok, true);
    const run = object(value.run);
    check(checks, "soak_profile", run.profile, "soak");
    check(checks, "isolated_fixture", run.isolatedFixture, true);
    const workload = object(value.workload);
    const workloadOptions = object(workload.options);
    check(checks, "requested_24h", numeric(workloadOptions.durationMs), 24 * 60 * 60_000, ">=");
    check(checks, "completed_24h", numeric(workload.durationMs), 24 * 60 * 60_000, ">=");
    check(checks, "workload_result", workload.ok, true);
    const reportChecks = array(value.checks).map(object);
    check(checks, "all_soak_checks_passed", reportChecks.every((entry) => entry.passed === true), true);
    for (const required of [
      "fixed_mcp_surface",
      "business_invocations",
      "provider_recovered",
      "no_orphan_provider_after_shutdown",
      "persistent_invocation_history_bounded",
      "persistent_audit_history_bounded",
      "persistent_state_below_128_mib",
      "steady_process_tree_rss_growth",
      "steady_process_tree_rss_slope",
    ]) {
      check(checks, `soak_gate_${required}`, reportChecks.some((entry) => entry.name === required && entry.passed === true), true);
    }
    const hasProvenance = reportChecks.some((entry) => entry.name === "runtime_source_provenance" && entry.passed === true);
    check(checks, "soak_source_provenance", hasProvenance || acceptLegacy, true);
    const state = object(value.persistentState);
    check(checks, "soak_invocation_rows", numeric(state.invocationRows), 2_000, "<=");
    check(checks, "soak_audit_rows", numeric(state.auditEventRows), 8_000, "<=");
    check(checks, "soak_state_mib", numeric(state.mib), 128, "<");
  } catch (error) {
    checks.push({ name: "receipt_readable", passed: false, actual: safeError(error), expected: "valid 24h soak receipt" });
  }
  return { name: "24h-soak", path, checks, passed: checks.length > 0 && checks.every(({ passed }) => passed) };
}

async function runtimeMatchesHead(commit: string): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "diff", "--quiet", commit, "HEAD", "--",
      "src", "native", "native-host", "browser-extension", "scripts", "test-fixtures",
      "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "vite.config.ts",
    ], { cwd: process.cwd() });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

async function sourceMetadata() {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }),
      execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: process.cwd() }),
    ]);
    const dirtyPaths = status.trim().split("\n").filter(Boolean);
    return {
      commit: commit.trim(),
      dirtyPaths,
      runtimeSourceDirtyPaths: dirtyPaths.filter(isRuntimeSourceStatus),
    };
  } catch (error) {
    return { commit: undefined, dirtyPaths: [], runtimeSourceDirtyPaths: [], error: safeError(error) };
  }
}

function check(
  checks: Check[],
  name: string,
  actual: unknown,
  expected: unknown,
  comparison: "=" | ">=" | "<=" | "<" = "=",
): void {
  const passed = comparison === ">=" ? Number(actual) >= Number(expected)
    : comparison === "<=" ? Number(actual) <= Number(expected)
      : comparison === "<" ? Number(actual) < Number(expected)
        : JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, passed, actual, expected: `${comparison === "=" ? "" : `${comparison} `}${String(expected)}` });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(resolve(path), "utf8")));
}

function parseOptions(args: string[]) {
  let locked = "";
  let unlocked = "";
  let browserTransition = "";
  let soak = "";
  let outputRoot = resolve(".build/capability-release-set");
  let acceptLegacySoak = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === "--accept-legacy-soak") { acceptLegacySoak = true; continue; }
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--locked") locked = value;
    else if (key === "--unlocked") unlocked = value;
    else if (key === "--browser-transition") browserTransition = value;
    else if (key === "--soak") soak = value;
    else if (key === "--output") outputRoot = resolve(value);
    else throw new Error(`unknown option: ${key}`);
  }
  for (const [name, value] of Object.entries({ locked, unlocked, browserTransition, soak })) {
    if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return { locked, unlocked, browserTransition, soak, outputRoot, acceptLegacySoak };
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

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

function numeric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected a finite number");
  return value;
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.components.flatMap((component) => component.checks.map((entry) =>
    `| ${entry.passed ? "PASS" : "FAIL"} | ${component.name} | ${entry.name} | ${String(entry.actual)} | ${entry.expected} |`)).join("\n");
  return `# Capability release evidence set\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Release eligible: ${String(reportValue.releaseEligible)}\n- Current commit: ${reportValue.source.commit ?? "unavailable"}\n- Runtime source dirty paths: ${reportValue.source.runtimeSourceDirtyPaths.length}\n- Legacy soak waiver: ${String(reportValue.legacySoakWaiver)}\n\n| Result | Component | Check | Actual | Expected |\n| --- | --- | --- | --- | --- |\n${rows}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
