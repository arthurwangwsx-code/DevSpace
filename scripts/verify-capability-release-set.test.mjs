#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "devspace-release-verifier-"));

try {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const expected = {
    locked: [
      "production_service_identity", "typecheck", "unit_and_integration", "production_build",
      "capability_stress_smoke", "real_external_mcp_mount", "desktop_lock_boundary",
      "production_desktop_reload",
    ],
    unlocked: [
      "production_service_identity", "production_desktop_permissions", "typecheck",
      "unit_and_integration", "production_build", "capability_stress_smoke",
      "real_external_mcp_mount", "production_browser_real_smoke", "direct_desktop_helper_fixture",
      "production_desktop_fixture", "production_desktop_reload",
    ],
    "browser-transition": ["production_service_identity", "production_browser_lock_matrix"],
  };

  for (const [lane, required] of Object.entries(expected)) {
    const listed = spawnSync(process.execPath, [
      join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, "scripts", "test-capability-release.ts"),
      "--lane", lane,
      "--list",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const names = JSON.parse(listed.stdout).gates.map((gate) => gate.name);
    assert.deepEqual(names, required, `${lane} release lane must match the current gate contract`);
    assert.equal(new Set(names).size, names.length, `${lane} release lane gates must be unique`);
  }

  const paths = {};
  for (const [lane, required] of Object.entries(expected)) {
    const declared = lane === "locked"
      ? required.filter((name) => name !== "production_service_identity")
      : required;
    const path = join(temp, `${lane}.json`);
    await writeFile(path, JSON.stringify({
      ok: true,
      releaseEligible: true,
      lane,
      selection: "complete-lane",
      source: { commit, sourceDirtyPaths: [] },
      requiredGates: declared,
      gates: declared.map((name) => ({ name, passed: true })),
    }));
    paths[lane] = path;
  }

  const soak = join(temp, "soak.json");
  const soakGateNames = [
    "fixed_mcp_surface", "business_invocations", "provider_recovered",
    "no_orphan_provider_after_shutdown", "persistent_invocation_history_bounded",
    "persistent_audit_history_bounded", "persistent_state_below_128_mib",
    "steady_process_tree_rss_growth", "steady_process_tree_rss_slope",
    "runtime_source_provenance",
  ];
  await writeFile(soak, JSON.stringify({
    ok: true,
    run: { profile: "soak", isolatedFixture: true },
    workload: { options: { durationMs: 86_400_000 }, durationMs: 86_400_000, ok: true },
    checks: soakGateNames.map((name) => ({ name, passed: true })),
    persistentState: { invocationRows: 0, auditEventRows: 0, mib: 0 },
  }));

  const output = join(temp, "output");
  const run = spawnSync(process.execPath, [
    join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    join(root, "scripts", "verify-capability-release-set.ts"),
    "--locked", paths.locked,
    "--unlocked", paths.unlocked,
    "--browser-transition", paths["browser-transition"],
    "--soak", soak,
    "--output", output,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  const report = JSON.parse(await readFile(join(result.artifactDir, "summary.json"), "utf8"));
  const locked = report.components.find((component) => component.name === "locked");
  assert.equal(locked.checks.find((check) => check.name === "current_required_gates").passed, false);
  assert.equal(locked.passed, false);
  console.log("verify-capability-release-set tests passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
