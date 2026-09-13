// launchd owns this supervisor and its foreground child. No detached processes.
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const [role, pidFile, healthSource, upstream, separator, command, ...args] = process.argv.slice(2);
if (role !== "server" || separator !== "--" || !command) process.exit(2);

const interval = positiveNumber("DEVSPACE_WATCHDOG_INTERVAL_MS", 10_000);
const grace = positiveNumber("DEVSPACE_WATCHDOG_GRACE_MS", 300_000);
const backoffBase = positiveNumber("DEVSPACE_WATCHDOG_BACKOFF_MS", 5_000);
const healthTimeout = positiveNumber("DEVSPACE_WATCHDOG_HEALTH_TIMEOUT_MS", 10_000);
const slowProbe = positiveNumber("DEVSPACE_WATCHDOG_SLOW_PROBE_MS", 1_000);
const failureLimit = positiveNumber("DEVSPACE_WATCHDOG_FAILURE_LIMIT", 6);
const stallRestartMs = positiveNumber("DEVSPACE_WATCHDOG_STALL_RESTART_MS", 300_000);
const maxLoadPerCpu = positiveNumber("DEVSPACE_WATCHDOG_MAX_LOAD_PER_CPU", 1.5);

let stopping = false;
let child;
let exited;
let stopPromise;
const log = (message) => console.log(`${new Date().toISOString()} supervisor role=${role} ${message}`);
const systemSnapshot = () => {
  const loads = loadavg();
  return `load1=${loads[0].toFixed(2)} load5=${loads[1].toFixed(2)} `
    + `freeMemoryMb=${Math.round(freemem() / 1024 / 1024)} totalMemoryMb=${Math.round(totalmem() / 1024 / 1024)}`;
};
const hostUnderPressure = () => loadavg()[0] / Math.max(1, availableParallelism()) >= maxLoadPerCpu;

async function probe(url) {
  const started = performance.now();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)) {
      return { ok: false, status: 0, durationMs: performance.now() - started, error: "invalid_loopback_url" };
    }
    const response = await fetch(parsed, { signal: AbortSignal.timeout(healthTimeout), redirect: "error" });
    await response.body?.cancel();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      error: response.ok ? undefined : `http_${response.status}`,
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause && typeof error.cause === "object"
      && "code" in error.cause ? `:${String(error.cause.code)}` : "";
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      error: `${error instanceof Error ? error.name : "probe_error"}${cause}`,
    };
  }
}

async function stopChild() {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    const current = child;
    if (!current) return;
    current.kill("SIGTERM");
    const forced = setTimeout(() => current.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(forced);
    if ((await readFile(pidFile, "utf8").catch(() => "")).trim() === String(current.pid)) {
      await unlink(pidFile).catch(() => {});
    }
    child = undefined;
  })();
  await stopPromise;
  stopPromise = undefined;
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { stopping = true; void stopChild(); });
}

let backoff = backoffBase;
while (!stopping) {
  const started = Date.now();
  child = spawn(command, args, { stdio: "inherit" });
  const current = child;
  exited = new Promise((resolve) => {
    current.once("exit", (code, signal) => {
      log(`child_exit code=${code} signal=${signal} uptimeMs=${Date.now() - started}`);
      resolve();
    });
    current.once("error", (error) => { log(`spawn_error code=${error.code}`); resolve(); });
  });
  if (current.pid) await writeFile(pidFile, `${current.pid}\n`, { mode: 0o600 });
  log(`child_started pid=${current.pid}`);

  let failures = 0;
  let seenHealthy = false;
  let readySince;
  let unhealthySince;
  while (!stopping && current.exitCode === null && current.signalCode === null && current.pid) {
    await Promise.race([delay(interval), exited]);
    if (stopping || current.exitCode !== null || current.signalCode !== null) break;
    const result = await probe(healthSource);
    if (result.durationMs >= slowProbe) {
      log(`health_probe_slow status=${result.status} durationMs=${result.durationMs} thresholdMs=${slowProbe}`);
    }
    if (result.ok) {
      if (failures > 0) log(`health_recovered previousConsecutive=${failures}`);
      failures = 0;
      unhealthySince = undefined;
      seenHealthy = true;
      readySince ??= Date.now();
      if (Date.now() - readySince > 60_000) backoff = backoffBase;
      continue;
    }
    readySince = undefined;
    if (!seenHealthy && Date.now() - started < grace) continue;
    unhealthySince ??= Date.now();
    failures += 1;
    log(`health_failed consecutive=${failures} status=${result.status} durationMs=${result.durationMs} error=${result.error}`);
    if (failures < failureLimit) continue;
    const unhealthyMs = Date.now() - unhealthySince;
    if (hostUnderPressure()) {
      log(`restart_suppressed_host_pressure unhealthyMs=${unhealthyMs} ${systemSnapshot()}`);
      failures = 0;
      continue;
    }
    if (unhealthyMs < stallRestartMs) {
      log(`restart_deferred_unhealthy unhealthyMs=${unhealthyMs} stallRestartMs=${stallRestartMs}`);
      failures = 0;
      continue;
    }
    log(`restarting_unhealthy_child unhealthyMs=${unhealthyMs} ${systemSnapshot()}`);
    break;
  }
  await stopChild();
  if (!stopping) {
    log(`retry_in_ms=${backoff}`);
    for (let elapsed = 0; elapsed < backoff && !stopping; elapsed += 250) await delay(250);
    backoff = Math.min(60_000, backoff * 2);
  }
}
log("stopped");

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
