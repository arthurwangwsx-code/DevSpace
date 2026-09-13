#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { SystemSessionStateProbe } from "../src/capabilities/session-state.js";
import type {
  ProviderCapability,
  ProviderContext,
  ProviderLease,
} from "../src/capabilities/provider.js";
import type { JsonObject, JsonValue } from "../src/capabilities/types.js";
import { BrowserExtensionProvider } from "../src/capabilities/providers/browser-extension-provider.js";

interface Options {
  outputRoot: string;
  connectTimeoutMs: number;
  transitionTimeoutMs: number;
  baseUrl?: string;
}

interface StepResult {
  phase: "unlocked-baseline" | "locked-continuation" | "unlocked-recovery" | "setup";
  name: string;
  passed: boolean;
  durationMs: number;
  details?: JsonObject;
}

const options = parseArgs(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = resolve(options.outputRoot, runId);
await mkdir(artifactDir, { recursive: true });

const steps: StepResult[] = [];
const probe = new SystemSessionStateProbe();
const lifetime = new AbortController();
const provider = new BrowserExtensionProvider(process.env);
const socketPath = process.env.DEVSPACE_BROWSER_SOCKET
  || join(os.homedir(), ".devspace", "browser-extension.sock");
let fixtureServer: Server | undefined;
let fixtureUrl: string | undefined;
let capabilities: ProviderCapability[] = [];
let lease: ProviderLease | undefined;
let remoteLeaseId: string | undefined;
let failure: string | undefined;
let providerStarted = false;

try {
  const initialSession = await probe.probe(lifetime.signal);
  if (initialSession.locked) {
    throw new Error("browser extension matrix must start while the macOS session is unlocked");
  }
  if (!options.baseUrl && existsSync(socketPath)) {
    throw new Error("another browser extension bridge or a stale socket already owns the local path");
  }

  const fixture = await startFixture();
  fixtureServer = fixture.server;
  fixtureUrl = fixture.url;
  const failures: string[] = [];
  if (options.baseUrl) {
    await timed("setup", "runtime_extension_connect", () => waitForRemoteExtension(options.baseUrl!, options.connectTimeoutMs));
  } else {
    const context: ProviderContext = {
      signal: lifetime.signal,
      reportFailure: (error) => failures.push(safeError(error)),
      reportCatalogChanged: () => {},
      log: () => {},
    };
    await timed("setup", "provider_start", () => provider.start(context));
    providerStarted = true;
    await timed("setup", "extension_connect", () => waitForExtension(provider, options.connectTimeoutMs));
  }
  capabilities = await timed("setup", "capability_discovery", () => discoverCapabilities(), {
    summarize: (value) => ({ capabilityCount: value.length }),
  });
  assert.equal(capabilities.length, 8, "extension provider must expose exactly eight capabilities");

  const opened = await timed("unlocked-baseline", "open_background_fixture", () =>
    invoke("browser.extension.open_page", { url: fixtureUrl! }), {
      summarize: (value) => ({ ownership: objectValue(value).ownership ?? null }),
    });
  const tabId = objectValue(opened).tabId;
  assert.ok(Number.isInteger(tabId), "extension did not return an agent tab id");
  lease = await timed("unlocked-baseline", "acquire_agent_tab", () => openLease(tabId as number), {
    summarize: (value) => ({ ownership: value.display.ownership ?? null }),
  });
  assert.equal(lease.display.ownership, "agent");
  await exerciseUnlocked("unlocked-baseline", "baseline");

  process.stdout.write("Browser baseline passed. Lock the Mac now; waiting for locked continuation...\n");
  await timed("setup", "wait_for_lock", () => waitForLockState(true, options.transitionTimeoutMs));
  await exerciseLocked();

  process.stdout.write("Locked continuation passed. Unlock the Mac now; waiting for recovery...\n");
  await timed("setup", "wait_for_unlock", () => waitForLockState(false, options.transitionTimeoutMs));
  await exerciseUnlocked("unlocked-recovery", "recovery");
  assert.deepEqual(failures, [], "Provider reported a runtime failure");
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  if (lease) {
    await closeLease().catch(() => {});
  }
  lifetime.abort("matrix_complete");
  if (providerStarted) await provider.stop("matrix_complete").catch(() => {});
  if (fixtureServer) await closeServer(fixtureServer).catch(() => {});
}

const report = {
  ok: failure === undefined,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  fixture: fixtureUrl ? { origin: new URL(fixtureUrl).origin } : undefined,
  transport: options.baseUrl ? "runtime-rest" : "direct-provider",
  steps,
  ...(failure ? { failure } : {}),
};
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, artifactDir, steps: steps.length, failure }));

async function exerciseUnlocked(
  phase: "unlocked-baseline" | "unlocked-recovery",
  marker: string,
): Promise<void> {
  if (phase === "unlocked-recovery") {
    await timed(phase, "navigate_fixture", () => invoke("browser.extension.navigate", { url: fixtureUrl! }));
  }
  const before = await waitForSnapshot(phase, "snapshot_ready");
  const elements = snapshotElements(before);
  const input = elements.find((entry) => entry.label === "bridge input");
  const button = elements.find((entry) => entry.label === "Increment 0");
  assert.ok(input && Number.isInteger(input.index), "fixture input is missing from snapshot");
  assert.ok(button && Number.isInteger(button.index), "fixture button is missing from snapshot");
  await timed(phase, "focus_input", () => invoke("browser.extension.click", { index: input.index }));
  await timed(phase, "type_text", () => invoke("browser.extension.type_text", { text: marker }));
  const typed = await timed(phase, "snapshot_after_type", () => invoke("browser.extension.snapshot", {}), {
    summarize: summarizeSnapshot,
  });
  assert.equal(objectValue(typed).title, `typed:${marker}`);
  await timed(phase, "press_enter", () => invoke("browser.extension.press_key", { key: "Enter" }));
  const entered = await timed(phase, "snapshot_after_key", () => invoke("browser.extension.snapshot", {}), {
    summarize: summarizeSnapshot,
  });
  assert.equal(objectValue(entered).title, `entered:${marker}`);
  await timed(phase, "click_button", () => invoke("browser.extension.click", { index: button.index }));
  const clicked = await timed(phase, "snapshot_after_click", () => invoke("browser.extension.snapshot", {}), {
    summarize: summarizeSnapshot,
  });
  assert.equal(objectValue(clicked).title, "clicked:1");
  await screenshot(phase);
}

async function exerciseLocked(): Promise<void> {
  const session = await probe.probe(lifetime.signal);
  assert.equal(session.locked, true, "session unlocked before locked continuation began");
  await timed("locked-continuation", "snapshot", () => invoke("browser.extension.snapshot", {}), {
    summarize: summarizeSnapshot,
  });
  await screenshot("locked-continuation");
}

async function screenshot(phase: StepResult["phase"]): Promise<void> {
  const value = await timed(phase, "screenshot", () => invoke("browser.extension.screenshot", {}), {
    summarize: (result) => ({ outputBytes: jsonBytes(result), hasPng: hasPng(result) }),
  });
  assert.equal(hasPng(value), true, "extension screenshot is not a PNG payload");
}

async function waitForSnapshot(phase: StepResult["phase"], name: string): Promise<JsonValue> {
  return timed(phase, name, async () => {
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const value = await invoke("browser.extension.snapshot", {});
        if (objectValue(value).title === "DevSpace Browser Fixture") return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    throw lastError ?? new Error("fixture did not become ready");
  }, { summarize: summarizeSnapshot });
}

async function invoke(id: string, argumentsValue: JsonObject): Promise<JsonValue> {
  const selected = capabilities.find((entry) => entry.descriptor.id === id);
  assert.ok(selected, `missing capability: ${id}`);
  if (options.baseUrl) {
    const invocation = await requestJson("POST", `${options.baseUrl}/invocations`, {
      capabilityId: id,
      arguments: argumentsValue,
      mode: "sync",
      ...(selected.descriptor.execution.requiresLease ? { leaseId: remoteLeaseId } : {}),
    });
    if (invocation.status !== "succeeded") {
      throw new Error(`runtime invocation failed: ${safeJson(invocation.error)}`);
    }
    return (invocation.result ?? null) as JsonValue;
  }
  return provider.invoke({
    capabilityId: id,
    descriptor: selected.descriptor,
    binding: selected.binding,
    arguments: argumentsValue,
    ...(selected.descriptor.execution.requiresLease ? { lease } : {}),
  }, { signal: lifetime.signal });
}

async function discoverCapabilities(): Promise<ProviderCapability[]> {
  if (!options.baseUrl) return provider.discover(lifetime.signal);
  const result = await requestJson(
    "GET",
    `${options.baseUrl}/capabilities?providerId=${encodeURIComponent(provider.id)}&availableOnly=false`,
  );
  const items = Array.isArray(result.items) ? result.items : [];
  return Promise.all(items.map(async (summary) => {
    const id = objectValue(summary as JsonValue).id;
    assert.equal(typeof id, "string", "runtime returned a capability without an id");
    const descriptor = await requestJson(
      "GET",
      `${options.baseUrl}/capabilities/${encodeURIComponent(id as string)}`,
    );
    return { descriptor: descriptor as unknown as ProviderCapability["descriptor"], binding: {} };
  }));
}

async function openLease(tabId: number): Promise<ProviderLease> {
  if (!options.baseUrl) {
    return provider.open!({
      resourceType: "browser_page",
      selector: { tabId },
    }, { signal: lifetime.signal });
  }
  const result = await requestJson("POST", `${options.baseUrl}/leases`, {
    providerId: provider.id,
    resourceType: "browser_page",
    selector: { tabId },
    ttlSeconds: Math.max(60, Math.ceil(options.transitionTimeoutMs * 2 / 1_000)),
  });
  assert.equal(typeof result.id, "string", "runtime did not return a lease id");
  remoteLeaseId = result.id as string;
  return {
    handle: { tabId },
    display: objectValue((result.display ?? {}) as JsonValue),
  };
}

async function closeLease(): Promise<void> {
  if (options.baseUrl) {
    if (!remoteLeaseId) return;
    await requestJson("DELETE", `${options.baseUrl}/leases/${encodeURIComponent(remoteLeaseId)}`);
    remoteLeaseId = undefined;
    return;
  }
  if (lease && providerStarted) {
    await provider.close(lease, { signal: new AbortController().signal });
  }
}

async function timed<T>(
  phase: StepResult["phase"],
  name: string,
  operation: () => Promise<T>,
  optionsValue: { summarize?: (value: T) => JsonObject } = {},
): Promise<T> {
  const started = performance.now();
  try {
    const value = await operation();
    steps.push({
      phase,
      name,
      passed: true,
      durationMs: round(performance.now() - started),
      ...(optionsValue.summarize ? { details: optionsValue.summarize(value) } : {}),
    });
    return value;
  } catch (error) {
    steps.push({
      phase,
      name,
      passed: false,
      durationMs: round(performance.now() - started),
      details: { error: safeError(error) },
    });
    throw error;
  }
}

async function waitForExtension(target: BrowserExtensionProvider, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await target.health(lifetime.signal)).state === "ready") return;
    await sleep(500);
  }
  throw new Error("browser extension did not connect; reload it or verify the native host installation");
}

async function waitForRemoteExtension(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await requestJson("POST", `${baseUrl}/invocations`, {
        capabilityId: "browser.extension.list_pages",
        arguments: { all: true },
        mode: "sync",
      });
      if (result.status === "succeeded") return;
      lastError = new Error(`runtime extension probe failed: ${safeJson(result.error)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error("browser extension did not connect to the running DevSpace runtime");
}

async function requestJson(method: "GET" | "POST" | "DELETE", url: string, body?: JsonObject): Promise<JsonObject> {
  const token = process.env.DEVSPACE_CAPABILITY_BEARER_TOKEN;
  const response = await fetch(url, {
    method,
    signal: lifetime.signal,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const envelope = await response.json() as { data?: JsonObject; error?: unknown };
  if (!response.ok || !envelope.data) {
    throw new Error(`runtime request failed (${response.status}): ${safeJson(envelope.error)}`);
  }
  return envelope.data;
}

async function waitForLockState(locked: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await probe.probe(lifetime.signal);
    if (state.locked === locked) return;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for macOS to become ${locked ? "locked" : "unlocked"}`);
}

async function startFixture(): Promise<{ server: Server; url: string }> {
  const html = `<!doctype html><meta charset="utf-8"><title>DevSpace Browser Fixture</title>
<input aria-label="bridge input" autofocus><button>Increment 0</button>
<script>
const input=document.querySelector('input'); const button=document.querySelector('button'); let count=0;
input.addEventListener('input',()=>document.title='typed:'+input.value);
input.addEventListener('keydown',(event)=>{if(event.key==='Enter')document.title='entered:'+input.value});
button.addEventListener('click',()=>{button.textContent='Increment '+(++count);document.title='clicked:'+count});
</script>`;
  const server = createServer((request, response) => {
    if (request.url !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'",
    });
    response.end(html);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

function snapshotElements(value: JsonValue): Array<{ index?: number; label?: string }> {
  const elements = objectValue(value).elements;
  return Array.isArray(elements) ? elements.filter((entry): entry is { index?: number; label?: string } =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
}

function summarizeSnapshot(value: JsonValue): JsonObject {
  return { title: typeof objectValue(value).title === "string" ? objectValue(value).title : null, outputBytes: jsonBytes(value) };
}

function objectValue(value: JsonValue): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasPng(value: JsonValue): boolean {
  const object = objectValue(value);
  return object.mimeType === "image/png" && typeof object.data === "string" && object.data.startsWith("iVBOR");
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseArgs(args: string[]): Options {
  const result: Options = {
    outputRoot: ".build/browser-extension-matrix",
    connectTimeoutMs: 90_000,
    transitionTimeoutMs: 10 * 60_000,
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || value === undefined) throw new Error(`Missing value for ${flag ?? "argument"}`);
    if (flag === "--output") result.outputRoot = value;
    else if (flag === "--connect-timeout") result.connectTimeoutMs = parseDuration(value);
    else if (flag === "--transition-timeout") result.transitionTimeoutMs = parseDuration(value);
    else if (flag === "--base-url") result.baseUrl = normalizeBaseUrl(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("base URL must use http or https");
  return url.toString().replace(/\/$/, "");
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m)$/);
  if (!match) throw new Error("duration must use ms, s, or m suffix");
  return Number(match[1]) * (match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000);
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.steps.map((step) =>
    `| ${step.passed ? "PASS" : "FAIL"} | ${step.phase} | ${step.name} | ${step.durationMs} |`).join("\n");
  return `# Browser extension lock matrix\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Transport: ${reportValue.transport}\n- Fixture origin: ${reportValue.fixture?.origin ?? "not started"}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Phase | Step | Duration ms |\n| --- | --- | --- | ---: |\n${rows}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
