#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "darwin") process.exit(2);

const args = parseArgs(process.argv.slice(2));
const uid = integer(args.uid, "uid", 0, Number.MAX_SAFE_INTEGER);
const label = required(args.label, "label");
const plistPath = resolve(required(args.plist, "plist"));
const healthUrl = new URL(required(args.health, "health"));
const statusPath = resolve(required(args.status, "status"));
const activationId = required(args["activation-id"], "activation-id");
const launchctl = resolve(args.launchctl ?? "/bin/launchctl");
const delayMs = integer(args["delay-ms"] ?? "1500", "delay-ms", 0, 60_000);
const timeoutMs = integer(args["timeout-ms"] ?? "30000", "timeout-ms", 1_000, 300_000);
const domain = `gui/${uid}`;
const service = `${domain}/${label}`;

if (healthUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(healthUrl.hostname)) {
  throw new Error("health must be a loopback HTTP URL");
}

await record({ state: "scheduled", activationId, label, service, pid: process.pid });
await delay(delayMs);
await record({ state: "activating", activationId, label, service, pid: process.pid });

let bootoutAttempted = false;
try {
  try {
    execFileSync(launchctl, ["bootout", domain, plistPath], { stdio: "ignore" });
    bootoutAttempted = true;
  } catch {
    // An absent service is already in the state required before bootstrap.
  }

  let loaded = false;
  let lastError;
  for (let attempt = 1; attempt <= 20 && !loaded; attempt += 1) {
    try {
      execFileSync(launchctl, ["bootstrap", domain, plistPath], { stdio: "ignore" });
      loaded = true;
    } catch (error) {
      lastError = error;
      loaded = serviceExists();
      if (!loaded) await delay(Math.min(1_000, attempt * 100));
    }
  }
  if (!loaded) throw lastError ?? new Error("launchctl bootstrap failed");

  execFileSync(launchctl, ["enable", service], { stdio: "ignore" });
  const health = await waitForHealth();
  await record({
    state: "ready",
    activationId,
    label,
    service,
    pid: process.pid,
    bootoutAttempted,
    health,
  });
} catch (error) {
  // If activation failed after bootout, make one final best-effort bootstrap.
  // The helper is detached from the service being replaced, so this recovery
  // still runs when activation was requested through DevSpace itself.
  try {
    if (!serviceExists()) execFileSync(launchctl, ["bootstrap", domain, plistPath], { stdio: "ignore" });
    execFileSync(launchctl, ["enable", service], { stdio: "ignore" });
  } catch {}
  await record({
    state: "failed",
    activationId,
    label,
    service,
    pid: process.pid,
    bootoutAttempted,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}

function serviceExists() {
  try {
    execFileSync(launchctl, ["print", service], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  let lastError = "not_started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.ok) return { ok: true, status: response.status, url: healthUrl.href };
      lastError = `http_${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`service health did not recover within ${timeoutMs}ms (status=${lastStatus}, error=${lastError})`);
}

async function record(value) {
  mkdirSync(dirname(statusPath), { recursive: true, mode: 0o700 });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(temporary, statusPath);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = values[++index];
    if (!value) throw new Error(`${token} requires a value`);
    result[token.slice(2)] = value;
  }
  return result;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(raw, name, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}`);
  return value;
}
