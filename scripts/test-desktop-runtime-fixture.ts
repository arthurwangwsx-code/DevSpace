#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { SystemSessionStateProbe } from "../src/capabilities/session-state.js";

const execFileAsync = promisify(execFile);
const BUNDLE_ID = "com.devspace.desktop-fixture";
const PROVIDER_ID = "desktop.macos.accessibility";
const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(options.outputRoot, runId);
const steps: Step[] = [];
const leases = new Set<string>();
const fixturePids = new Set<number>();
let session: Awaited<ReturnType<SystemSessionStateProbe["probe"]>> | undefined;
let failure: string | undefined;

await mkdir(artifactDir, { recursive: true });
try {
  session = await new SystemSessionStateProbe().probe(new AbortController().signal);
  assert.equal(session.locked, false, "desktop runtime fixture must run while macOS is unlocked");
  await timed("production_permissions", async () => {
    const status = object(await invoke("desktop.macos.status", {}));
    assert.equal(status.accessibilityTrusted, true, "signed production Host lacks Accessibility permission");
    assert.equal(status.screenCaptureGranted, true, "signed production Host lacks Screen Recording permission");
    assert.equal(status.version, "0.3.0");
    return { processId: status.processId, version: status.version };
  });

  const alreadyRunning = await fixtureApps();
  assert.equal(alreadyRunning.length, 0,
    `desktop fixture is already running with PID(s): ${alreadyRunning.map(({ processId }) => processId).join(",")}`);
  const firstPid = await timed("launch_fixture_generation_1", launchFixture);
  fixturePids.add(firstPid);
  const firstLease = await timed("open_process_bound_lease", () => openLease(firstPid));
  leases.add(firstLease);

  await timed("activate_fixture", () => invoke("desktop.macos.activate_app", {}, firstLease));
  const before = await timed("snapshot_fixture", () => waitForSnapshot(firstLease, "DevSpace Fixture Label"));
  const beforeJson = JSON.stringify(before);
  assert.doesNotMatch(beforeJson, /DO_NOT_LEAK_SECURE_VALUE/);
  const button = findAxNode(before, (node) => node.title === "Increment 0");
  const input = findAxNode(before, (node) => node.value === "fixture-start");
  assert.ok(button, "fixture button is missing from the production AX snapshot");
  assert.ok(input, "fixture input is missing from the production AX snapshot");

  await timed("screenshot_fixture", async () => {
    const screenshot = object(await invoke("desktop.macos.screenshot_app", {
      maxWidth: 800,
      maxHeight: 600,
    }, firstLease));
    assert.equal(screenshot.mimeType, "image/png");
    assert.equal(typeof screenshot.data, "string");
    assert.deepEqual(Buffer.from(screenshot.data as string, "base64").subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return { width: screenshot.width, height: screenshot.height };
  });

  await waitForUserYield();
  await timed("click_fixture_button", () => invoke("desktop.macos.click_point", center(button), firstLease));
  await timed("verify_click", () => waitForSnapshot(firstLease, "Clicked 1"));

  await waitForUserYield();
  await timed("focus_fixture_input", () => invoke("desktop.macos.click_point", center(input), firstLease));
  await waitForUserYield();
  await timed("type_fixture_text", () => invoke("desktop.macos.type_text", {
    text: "typed-through-production-runtime",
  }, firstLease));
  await waitForUserYield();
  await timed("press_allowed_key", () => invoke("desktop.macos.press_key", { key: "Left" }, firstLease));
  await timed("verify_text", () => waitForSnapshot(firstLease, "typed-through-production-runtime"));

  await timed("terminate_fixture_generation_1", () => terminateProcess(firstPid));
  const secondPid = await timed("launch_fixture_generation_2", launchFixture);
  fixturePids.add(secondPid);
  assert.notEqual(secondPid, firstPid, "fixture restart reused the same process ID");
  await timed("old_lease_rejected_after_restart", async () => {
    const invocation = await invokeRaw("desktop.macos.snapshot_app", {}, firstLease);
    assert.equal(invocation.status, "failed");
    assert.equal(invocation.errorCode, "lease_expired");
    return { oldProcessId: firstPid, newProcessId: secondPid, errorCode: invocation.errorCode };
  });

  const secondLease = await timed("open_recovery_lease", () => openLease(secondPid));
  leases.add(secondLease);
  await timed("recovery_snapshot", () => waitForSnapshot(secondLease, "DevSpace Fixture Label"));
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  for (const leaseId of [...leases]) await closeLease(leaseId).catch(() => {});
  for (const processId of [...fixturePids]) await terminateProcess(processId).catch(() => {});
}

const report = {
  ok: failure === undefined,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  endpoint: options.baseUrl,
  fixtureApp: options.fixtureApp,
  session: session ? { awake: session.awake, loggedIn: session.loggedIn, locked: session.locked } : undefined,
  steps,
  ...(failure ? { failure } : {}),
};
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, artifactDir, steps: steps.length, failure }));

interface Step {
  name: string;
  passed: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
}

type AxNode = {
  title?: unknown;
  value?: unknown;
  position?: { x?: unknown; y?: unknown };
  size?: { width?: unknown; height?: unknown };
};

async function timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const value = await operation();
    const details = summarize(value);
    steps.push({
      name,
      passed: true,
      durationMs: round(performance.now() - started),
      ...(details ? { details } : {}),
    });
    return value;
  } catch (error) {
    steps.push({
      name,
      passed: false,
      durationMs: round(performance.now() - started),
      details: { error: safeError(error) },
    });
    throw error;
  }
}

async function launchFixture(): Promise<number> {
  await execFileAsync("/usr/bin/open", ["-n", options.fixtureApp]);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const apps = await fixtureApps();
    const fresh = apps.find(({ processId }) => !fixturePids.has(processId));
    if (fresh) return fresh.processId;
    await sleep(100);
  }
  throw new Error("fixture app did not appear in desktop.macos.list_apps");
}

async function fixtureApps(): Promise<Array<{ processId: number; name?: string }>> {
  const value = object(await invoke("desktop.macos.list_apps", {}));
  const apps = Array.isArray(value.apps) ? value.apps : [];
  return apps.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const app = entry as Record<string, unknown>;
    if (app.bundleId !== BUNDLE_ID || typeof app.processId !== "number") return [];
    return [{ processId: app.processId, ...(typeof app.name === "string" ? { name: app.name } : {}) }];
  });
}

async function openLease(expectedProcessId: number): Promise<string> {
  const lease = object(await request("POST", "/leases", {
    providerId: PROVIDER_ID,
    resourceType: "app_window",
    selector: { bundleId: BUNDLE_ID },
    ttlSeconds: 300,
  }));
  assert.equal(typeof lease.id, "string");
  const display = object(lease.display);
  assert.equal(display.bundleId, BUNDLE_ID);
  assert.equal(display.processId, expectedProcessId, "runtime lease did not bind the expected application generation");
  return lease.id as string;
}

async function closeLease(leaseId: string): Promise<void> {
  await request("DELETE", `/leases/${encodeURIComponent(leaseId)}`);
  leases.delete(leaseId);
}

async function invoke(
  capabilityId: string,
  argumentsValue: Record<string, unknown>,
  leaseId?: string,
): Promise<unknown> {
  const invocation = await invokeRaw(capabilityId, argumentsValue, leaseId);
  if (invocation.status !== "succeeded") {
    throw new Error(`${capabilityId} ${String(invocation.status)}: ${String(invocation.errorCode ?? "unknown")}`);
  }
  return invocation.result;
}

function invokeRaw(
  capabilityId: string,
  argumentsValue: Record<string, unknown>,
  leaseId?: string,
): Promise<Record<string, unknown>> {
  return request("POST", "/invocations", {
    capabilityId,
    arguments: argumentsValue,
    mode: "sync",
    ...(leaseId ? { leaseId } : {}),
  }).then(object);
}

async function waitForSnapshot(leaseId: string, marker: string): Promise<unknown> {
  const deadline = Date.now() + options.timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await invoke("desktop.macos.snapshot_app", { maxDepth: 8, maxNodes: 500 }, leaseId);
    if (JSON.stringify(last).includes(marker)) return last;
    await sleep(100);
  }
  throw new Error(`desktop snapshot did not contain ${JSON.stringify(marker)}; last bytes=${jsonBytes(last)}`);
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path.replace(/^\//, ""), ensureTrailingSlash(options.baseUrl));
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  const token = process.env.DEVSPACE_CAPABILITY_BEARER_TOKEN;
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let envelope: Record<string, unknown>;
  try { envelope = object(JSON.parse(text)); }
  catch { throw new Error(`Capability API returned non-JSON: ${text.slice(0, 300)}`); }
  if (!response.ok) {
    const error = object(envelope.error);
    throw new Error(`HTTP ${response.status}: ${String(error.code ?? "unknown")} ${String(error.message ?? "")}`);
  }
  return envelope.data;
}

async function terminateProcess(processId: number): Promise<void> {
  try { process.kill(processId, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(processId, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await sleep(100);
  }
  throw new Error(`fixture PID ${processId} did not exit after SIGTERM`);
}

function findAxNode(value: unknown, matches: (node: AxNode) => boolean): AxNode | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findAxNode(child, matches);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const node = value as AxNode;
  if (matches(node)) return node;
  for (const child of Object.values(node)) {
    const found = findAxNode(child, matches);
    if (found) return found;
  }
  return undefined;
}

function center(node: AxNode): { x: number; y: number } {
  assert.equal(typeof node.position?.x, "number");
  assert.equal(typeof node.position?.y, "number");
  assert.equal(typeof node.size?.width, "number");
  assert.equal(typeof node.size?.height, "number");
  return { x: node.position.x + node.size.width / 2, y: node.position.y + node.size.height / 2 };
}

function parseOptions(args: string[]) {
  let baseUrl = "http://127.0.0.1:7676/api/capabilities/v1/";
  let fixtureApp = resolve(".build/DevSpaceDesktopFixture.app");
  let outputRoot = resolve(".build/desktop-runtime-fixture");
  let timeoutMs = 15_000;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || value === undefined) throw new Error(`missing value for ${key ?? "argument"}`);
    if (key === "--url") baseUrl = ensureTrailingSlash(value);
    else if (key === "--fixture-app") fixtureApp = resolve(value);
    else if (key === "--output") outputRoot = resolve(value);
    else if (key === "--timeout-ms") timeoutMs = positiveInteger(value, key);
    else throw new Error(`unknown option: ${key}`);
  }
  return { baseUrl, fixtureApp, outputRoot, timeoutMs };
}

function ensureTrailingSlash(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http or https");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120_000) {
    throw new Error(`${name} must be an integer from 1 to 120000`);
  }
  return parsed;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function summarize(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "number") return { processId: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = ["processId", "oldProcessId", "newProcessId", "version", "errorCode", "width", "height"];
  const summary = Object.fromEntries(allowed.flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]));
  return Object.keys(summary).length > 0 ? summary : { outputBytes: jsonBytes(value) };
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.steps.map((step) =>
    `| ${step.passed ? "PASS" : "FAIL"} | ${step.name} | ${step.durationMs} | ${JSON.stringify(step.details ?? {})} |`).join("\n");
  return `# Production desktop runtime fixture\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Endpoint: ${reportValue.endpoint}\n- Session locked: ${String(reportValue.session?.locked)}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Gate | Duration ms | Details |\n| --- | --- | ---: | --- |\n${rows}\n`;
}

function waitForUserYield(): Promise<void> { return sleep(1_100); }
function sleep(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function round(value: number): number { return Math.round(value * 100) / 100; }
function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
