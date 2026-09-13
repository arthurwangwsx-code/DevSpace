#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { SystemSessionStateProbe } from "../src/capabilities/session-state.js";
import type {
  ProviderCapability,
  ProviderContext,
  ProviderLease,
} from "../src/capabilities/provider.js";
import type { JsonObject, JsonValue } from "../src/capabilities/types.js";
import {
  ChromeDevToolsProvider,
  createChromeDevToolsManifest,
  findChromeDevToolsMcpCommand,
} from "../src/capabilities/providers/chrome-devtools-provider.js";

type Phase = "unlocked-baseline" | "locked-continuation" | "unlocked-recovery";

interface Options {
  phase: Phase;
  fixtureUrl: string;
  outputRoot: string;
  timeoutMs: number;
}

interface StepResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details?: JsonObject;
}

const execFileAsync = promisify(execFile);
const options = parseArgs(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = resolve(options.outputRoot, runId);
await mkdir(artifactDir, { recursive: true });

const startedAt = new Date().toISOString();
const steps: StepResult[] = [];
let provider: ChromeDevToolsProvider | undefined;
let providerStarted = false;
let failure: string | undefined;
let sessionState: Awaited<ReturnType<SystemSessionStateProbe["probe"]>> | undefined;
let daemonBefore = "unknown";
let daemonAfter = "unknown";
let pageId: number | undefined;
let pageCount: number | undefined;

try {
  const fixture = new URL(options.fixtureUrl);
  if (!isLoopback(fixture.hostname)) throw new Error("fixture URL must use loopback");
  sessionState = await new SystemSessionStateProbe().probe(new AbortController().signal);
  const expectedLocked = options.phase === "locked-continuation";
  if (sessionState.locked !== expectedLocked) {
    throw new Error(
      `${options.phase} requires the macOS session to be ${expectedLocked ? "locked" : "unlocked"}`,
    );
  }

  const command = findChromeDevToolsMcpCommand();
  daemonBefore = await daemonStatus(command);
  const failures: string[] = [];
  provider = new ChromeDevToolsProvider(createChromeDevToolsManifest(command));
  const lifetime = new AbortController();
  const context: ProviderContext = {
    signal: lifetime.signal,
    reportFailure: (error) => failures.push(safeError(error)),
    reportCatalogChanged: () => {},
    log: () => {},
  };
  await timedStep("provider_start", steps, () => provider!.start(context));
  providerStarted = true;
  const capabilities = await timedStep("capability_discovery", steps, () =>
    withTimeout(options.timeoutMs, (signal) => provider!.discover(signal)), {
      summarize: (value) => ({ capabilityCount: value.length }),
    });
  assert.equal(capabilities.length, 9, "Chrome preset must expose exactly nine capabilities");

  const pages = await timedStep("list_pages", steps, () =>
    invoke(provider!, capability(capabilities, "browser.chrome.list_pages"), {}, undefined, options.timeoutMs), {
      summarize: (value) => ({ outputBytes: jsonBytes(value) }),
    });
  const found = findFixturePage(pages, fixture.href);
  pageId = found.pageId;
  pageCount = found.pageCount;
  assert.equal(typeof pageId, "number", "loopback fixture page is not open in current Chrome");

  const lease = await timedStep("open_page_lease", steps, () =>
    withTimeout(options.timeoutMs, (signal) => provider!.open!({
      resourceType: "browser_page",
      selector: { pageId: pageId! },
    }, { signal })), {
      summarize: (value) => ({ origin: value.display.origin as JsonValue }),
    });

  const snapshotCapability = capability(capabilities, "browser.chrome.take_snapshot");
  const snapshot = await timedStep("take_snapshot", steps, () =>
    invoke(provider!, snapshotCapability, { verbose: false }, lease, options.timeoutMs), {
      summarize: (value) => ({ outputBytes: jsonBytes(value), mentionsFixture: JSON.stringify(value).includes(fixture.host) }),
    });
  assert.ok(jsonBytes(snapshot) > 32, "snapshot output is unexpectedly empty");

  const screenshot = await timedStep("take_screenshot", steps, () =>
    invoke(
      provider!,
      capability(capabilities, "browser.chrome.take_screenshot"),
      { format: "png", fullPage: false },
      lease,
      options.timeoutMs,
    ), {
      summarize: (value) => ({ outputBytes: jsonBytes(value), hasImage: containsImage(value) }),
    });
  assert.equal(containsImage(screenshot), true, "screenshot result does not contain an MCP image");

  if (options.phase !== "locked-continuation") {
    await timedStep("navigate_same_fixture", steps, () =>
      invoke(
        provider!,
        capability(capabilities, "browser.chrome.navigate"),
        { type: "url", url: fixture.href, timeout: options.timeoutMs },
        lease,
        options.timeoutMs,
      ), { summarize: (value) => ({ outputBytes: jsonBytes(value) }) });
    await timedStep("post_mutation_snapshot", steps, () =>
      invoke(provider!, snapshotCapability, { verbose: false }, lease, options.timeoutMs), {
        summarize: (value) => ({ outputBytes: jsonBytes(value) }),
      });
  }

  assert.deepEqual(failures, [], "Provider reported a runtime failure");
  lifetime.abort("test_complete");
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  await provider?.stop("real_chrome_test_complete").catch(() => {});
  try {
    daemonAfter = await daemonStatus(findChromeDevToolsMcpCommand());
  } catch (error) {
    daemonAfter = safeError(error);
  }
}

const report = {
  ok: failure === undefined,
  phase: options.phase,
  startedAt,
  finishedAt: new Date().toISOString(),
  fixture: { origin: new URL(options.fixtureUrl).origin },
  session: sessionState ? {
    awake: sessionState.awake,
    loggedIn: sessionState.loggedIn,
    locked: sessionState.locked,
    consoleUserPresent: Boolean(sessionState.consoleUser),
  } : undefined,
  chrome: {
    daemonBefore,
    daemonAfter,
    daemonPersistedAfterProviderStop: providerStarted ? daemonAfter === "running" : undefined,
    pageCount,
    fixturePageId: pageId,
  },
  steps,
  ...(failure ? { failure } : {}),
};
await writeFile(resolve(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, phase: report.phase, artifactDir, steps: report.steps }));

async function invoke(
  target: ChromeDevToolsProvider,
  selected: ProviderCapability,
  argumentsValue: JsonObject,
  lease: ProviderLease | undefined,
  timeoutMs: number,
): Promise<JsonValue> {
  return withTimeout(timeoutMs, (signal) => target.invoke({
    capabilityId: selected.descriptor.id,
    descriptor: selected.descriptor,
    binding: selected.binding,
    arguments: argumentsValue,
    lease,
  }, { signal }));
}

function capability(items: ProviderCapability[], id: string): ProviderCapability {
  const found = items.find(({ descriptor }) => descriptor.id === id);
  assert.ok(found, `missing capability: ${id}`);
  return found;
}

async function timedStep<T>(
  name: string,
  results: StepResult[],
  operation: () => Promise<T>,
  optionsValue: { summarize?: (value: T) => JsonObject } = {},
): Promise<T> {
  const started = performance.now();
  try {
    const value = await operation();
    results.push({
      name,
      passed: true,
      durationMs: round(performance.now() - started),
      ...(optionsValue.summarize ? { details: optionsValue.summarize(value) } : {}),
    });
    return value;
  } catch (error) {
    results.push({
      name,
      passed: false,
      durationMs: round(performance.now() - started),
      details: { error: safeError(error) },
    });
    throw error;
  }
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  timer.unref();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function findFixturePage(value: JsonValue, fixtureHref: string): { pageId?: number; pageCount?: number } {
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.pages)) {
    const pages = value.pages;
    for (const page of pages) {
      if (!page || typeof page !== "object" || Array.isArray(page) || typeof page.url !== "string") continue;
      const candidateId = typeof page.id === "number" ? page.id
        : typeof page.pageId === "number" ? page.pageId : undefined;
      if (candidateId !== undefined && normalizeUrl(page.url) === fixtureHref) {
        return { pageId: candidateId, pageCount: pages.length };
      }
    }
    return { pageCount: pages.length };
  }
  if (value && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = findFixturePage(child, fixtureHref);
      if (found.pageId !== undefined || found.pageCount !== undefined) return found;
    }
  }
  return {};
}

function containsImage(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== "object") return false;
  if (value.type === "image" && typeof value.data === "string" && value.data.length > 0) return true;
  return Object.values(value).some(containsImage);
}

async function daemonStatus(command: string): Promise<string> {
  const { stdout } = await execFileAsync(command, ["status"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return /daemon is running/i.test(stdout) ? "running" : "stopped";
}

function parseArgs(args: string[]): Options {
  const result: Options = {
    phase: "unlocked-baseline",
    fixtureUrl: "http://127.0.0.1:19080/",
    outputRoot: ".build/current-chrome-provider",
    timeoutMs: 60_000,
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || value === undefined) throw new Error(`Missing value for ${flag ?? "argument"}`);
    if (flag === "--phase") {
      if (!["unlocked-baseline", "locked-continuation", "unlocked-recovery"].includes(value)) {
        throw new Error(`Unknown phase: ${value}`);
      }
      result.phase = value as Phase;
    } else if (flag === "--fixture-url") result.fixtureUrl = new URL(value).href;
    else if (flag === "--output") result.outputRoot = value;
    else if (flag === "--timeout") result.timeoutMs = parseDuration(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (result.timeoutMs < 1_000 || result.timeoutMs > 120_000) {
    throw new Error("timeout must be between 1s and 120s");
  }
  return result;
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m)$/);
  if (!match) throw new Error("duration must use ms, s, or m suffix");
  const scale = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000;
  return Number(match[1]) * scale;
}

function normalizeUrl(value: string): string | undefined {
  try { return new URL(value).href; } catch { return undefined; }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.steps.map((step) =>
    `| ${step.passed ? "PASS" : "FAIL"} | ${step.name} | ${step.durationMs} |`).join("\n");
  return `# Current Chrome Provider test\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Phase: ${reportValue.phase}\n- Fixture origin: ${reportValue.fixture.origin}\n- Session locked: ${String(reportValue.session?.locked)}\n- Daemon persisted after Provider stop: ${String(reportValue.chrome.daemonPersistedAfterProviderStop)}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Step | Duration ms |\n| --- | --- | ---: |\n${rows}\n`;
}
