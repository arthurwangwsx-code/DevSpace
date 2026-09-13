#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(options.outputRoot, runId);
const steps: string[] = [];
let tabId: number | undefined;
let leaseId: string | undefined;
let failure: string | undefined;

try {
  const search = await requestJson("POST", `${options.baseUrl}/capabilities/search`, {
    query: "browser page snapshot wait",
    limit: 50,
  });
  const capabilities = objectArray(objectValue(search.data).items)
    .map((item) => objectValue(objectValue(item).capability));
  for (const id of ["browser.page.snapshot", "browser.page.wait"]) {
    const descriptor = capabilities.find((entry) => entry.id === id);
    assert.ok(descriptor, `${id} is absent from the canonical catalog`);
    const effects = objectValue(descriptor.effects);
    assert.equal(effects.readOnly, true, `${id} must be read-only`);
    assert.equal(effects.openWorld, true, `${id} must declare openWorld`);
  }
  pass("open_world_readonly_contract");

  const connection = objectValue(await invoke("browser.connection.status", {}));
  assert.match(String(connection.extensionVersion ?? ""), /^0\.[3-9]\.|^[1-9]\d*\./);
  pass("extension_connected");

  const opened = objectValue(await invoke("browser.tab.open", { url: options.externalUrl }));
  assert.ok(Number.isInteger(opened.tabId));
  tabId = Number(opened.tabId);
  pass("agent_tab_opened");

  const lease = await requestJson("POST", `${options.baseUrl}/leases`, {
    providerId: "browser.control",
    resourceType: "browser_page",
    selector: { tabId },
  });
  leaseId = String(objectValue(lease.data).id);
  assert.ok(leaseId.startsWith("lease_"));
  pass("page_lease_opened");

  const waited = objectValue(await invoke("browser.page.wait", {
    text: options.expectedText,
    timeoutMs: 15_000,
    intervalMs: 100,
  }, true));
  assert.equal(waited.condition, "text");
  pass("external_page_loaded");

  const snapshot = objectValue(await invoke("browser.page.snapshot", {}, true));
  assert.match(JSON.stringify(snapshot), new RegExp(escapeRegExp(options.expectedText), "i"));
  pass("external_snapshot_read");
} catch (error) {
  failure = safeError(error);
} finally {
  if (leaseId) {
    try {
      await requestJson("DELETE", `${options.baseUrl}/leases/${leaseId}`);
      const tabs = objectValue(await invoke("browser.tab.list", { all: true }));
      const remaining = objectArray(tabs.tabs).map(objectValue);
      assert.equal(remaining.some((tab) => tab.tabId === tabId), false, "agent-owned external tab was not closed");
      pass("agent_tab_closed");
    } catch (error) {
      failure ??= `cleanup: ${safeError(error)}`;
    }
  }
}

const report = {
  ok: failure === undefined,
  mode: "live-current-profile-open-world-readonly",
  baseUrl: options.baseUrl,
  externalUrl: options.externalUrl,
  expectedText: options.expectedText,
  pageMutations: 0,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  passed: steps.length,
  steps,
  ...(failure ? { failure } : {}),
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ...report, artifactDir }, null, 2));
if (!report.ok) process.exitCode = 1;

async function invoke(capabilityId: string, argumentsValue: Record<string, unknown>, useLease = false): Promise<unknown> {
  const response = await requestJson("POST", `${options.baseUrl}/invocations`, {
    capabilityId,
    arguments: argumentsValue,
    ...(useLease ? { leaseId } : {}),
  });
  if (response.error) throw new Error(`${capabilityId}: ${JSON.stringify(response.error)}`);
  const data = objectValue(response.data);
  assert.equal(data.status, "succeeded", `${capabilityId} did not succeed`);
  return data.result ?? null;
}

async function requestJson(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  return value;
}

function parseOptions(args: string[]) {
  let baseUrl = process.env.DEVSPACE_BROWSER_REAL_BASE_URL
    ?? "http://127.0.0.1:7676/api/capabilities/v1";
  let externalUrl = "https://example.com/";
  let expectedText = "Example Domain";
  let outputRoot = resolve(".build/browser-open-world-readonly");
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--base-url") baseUrl = value;
    else if (key === "--external-url") externalUrl = value;
    else if (key === "--expected-text") expectedText = value;
    else if (key === "--output") outputRoot = resolve(value);
    else throw new Error(`unknown option: ${key}`);
  }
  const target = new URL(externalUrl);
  assert.equal(target.protocol, "https:", "external read-only target must use HTTPS");
  assert.equal(target.username, "", "external read-only target must not contain credentials");
  assert.equal(target.password, "", "external read-only target must not contain credentials");
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    externalUrl: target.toString(),
    expectedText,
    outputRoot,
  };
}

function pass(name: string): void {
  steps.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}

function objectArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected array");
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMarkdown(value: typeof report): string {
  return `# Browser open-world read-only smoke\n\n- Result: ${value.ok ? "PASS" : "FAIL"}\n- Mode: ${value.mode}\n- External URL: ${value.externalUrl}\n- Page mutations: ${value.pageMutations}\n- Steps passed: ${value.passed}\n${value.failure ? `- Failure: ${value.failure}\n` : ""}\n| Step | Result |\n| --- | --- |\n${value.steps.map((step) => `| ${step} | PASS |`).join("\n")}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
