#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { CapabilityError } from "../src/capabilities/errors.js";
import { CapabilityRuntime } from "../src/capabilities/runtime.js";
import { SystemSessionStateProbe } from "../src/capabilities/session-state.js";
import {
  createMacosDesktopManifest,
  MacosDesktopProvider,
} from "../src/capabilities/providers/macos-desktop-provider.js";
import type { CapabilityPrincipal, JsonObject } from "../src/capabilities/types.js";

const helper = resolve(process.argv[2] ?? ".build/devspace-desktop-helper");
const outputRoot = resolve(process.argv[3] ?? ".build/desktop-lock-boundary");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(outputRoot, runId);
const stateDir = mkdtempSync(join(os.tmpdir(), "devspace-desktop-lock-"));
const session = await new SystemSessionStateProbe().probe(new AbortController().signal);
const principal: CapabilityPrincipal = {
  id: `local:${process.getuid?.() ?? "user"}`,
  kind: "test",
  resource: "local:desktop-lock-boundary",
  scopes: [],
};
const steps: Array<{ name: string; passed: boolean; details?: JsonObject }> = [];
let failure: string | undefined;

const provider = new MacosDesktopProvider(createMacosDesktopManifest(helper));
const runtime = new CapabilityRuntime({
  stateDir,
  enforcePolicy: false,
  providers: [{ provider, kind: "native:macos-accessibility", enabled: true }],
});

try {
  assert.equal(session.locked, true, "desktop lock-boundary test must run while macOS is locked");
  await runtime.start();

  const status = await runtime.router.invoke({
    requestId: "desktop-lock-status",
    principal,
    capabilityId: "desktop.macos.status",
    arguments: {},
  });
  assert.equal(status.status, "succeeded");
  steps.push({
    name: "status_allowed_while_locked",
    passed: true,
    details: { providerState: runtime.supervisor.getHealth(provider.id)?.state ?? null },
  });

  const invokeError = await captureError(runtime.router.invoke({
    requestId: "desktop-lock-list-apps",
    principal,
    capabilityId: "desktop.macos.list_apps",
    arguments: {},
  }));
  assertLockedDenial(invokeError);
  steps.push({
    name: "desktop_call_rejected_while_locked",
    passed: true,
    details: { code: invokeError.code, retryable: invokeError.retryable },
  });

  const leaseError = await captureError(runtime.router.openLease({
    requestId: "desktop-lock-open-lease",
    principal,
    providerId: provider.id,
    resourceType: "app_window",
    selector: { bundleId: "com.google.Chrome" },
  }));
  assertLockedDenial(leaseError);
  steps.push({
    name: "app_lease_rejected_while_locked",
    passed: true,
    details: { code: leaseError.code, retryable: leaseError.retryable },
  });
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  await runtime.close().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}

const report = {
  ok: failure === undefined,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  session: {
    awake: session.awake,
    loggedIn: session.loggedIn,
    locked: session.locked,
  },
  steps,
  ...(failure ? { failure } : {}),
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, artifactDir, steps: steps.length, failure }));


async function captureError(operation: Promise<unknown>): Promise<CapabilityError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CapabilityError) return error;
    throw error;
  }
  throw new Error("expected the locked desktop operation to fail");
}

function assertLockedDenial(error: CapabilityError): void {
  assert.equal(error.code, "temporarily_unavailable");
  assert.equal(error.retryable, true);
  assert.equal(error.details?.locked, true);
  assert.deepEqual(error.details?.unavailable, ["unlocked"]);
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.steps.map((step) =>
    `| ${step.passed ? "PASS" : "FAIL"} | ${step.name} |`).join("\n");
  return `# macOS desktop lock boundary\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Session locked: ${String(reportValue.session.locked)}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Step |\n| --- | --- |\n${rows}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
