import type { Request } from "express";
import { Worker } from "node:worker_threads";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
  slowRequestMs: number;
  slowToolCallMs: number;
  eventLoopLagMs: number;
}

type LogFields = Record<string, unknown>;
type WritableLogLevel = Exclude<LogLevel, "silent">;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: WritableLogLevel,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  const asyncLogFile = process.env.DEVSPACE_ASYNC_LOG_FILE?.trim();
  if (asyncLogFile) {
    const sink = getAsyncLogSink(asyncLogFile);
    if (sink.write(`${line}\n`, level)) return;
  }

  writeFallback(line, level);
}

export async function flushLogEvents(): Promise<void> {
  await Promise.all(Array.from(asyncLogSinks.values(), (sink) => sink.flush()));
}

export async function closeLogEvents(): Promise<void> {
  const sinks = Array.from(asyncLogSinks.values());
  asyncLogSinks.clear();
  await Promise.all(sinks.map((sink) => sink.close()));
}

function writeFallback(line: string, level: WritableLogLevel): void {
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const asyncLogSinks = new Map<string, AsyncLogSink>();

function getAsyncLogSink(path: string): AsyncLogSink {
  let sink = asyncLogSinks.get(path);
  if (!sink) {
    sink = new AsyncLogSink(
      path,
      positiveEnvironmentInteger("DEVSPACE_ASYNC_LOG_MAX_BYTES", 64 * 1024 * 1024),
      positiveEnvironmentInteger("DEVSPACE_ASYNC_LOG_BACKUPS", 3),
      positiveEnvironmentInteger("DEVSPACE_ASYNC_LOG_MAX_QUEUED_LINES", 8_192),
    );
    asyncLogSinks.set(path, sink);
  }
  return sink;
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

interface AsyncLogBatchResult {
  sequence: number;
  count: number;
  error?: string;
}

class AsyncLogSink {
  private readonly worker: Worker;
  private readonly pending: string[] = [];
  private readonly batches = new Map<number, number>();
  private readonly waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private scheduled?: NodeJS.Immediate;
  private sequence = 0;
  private inFlightLines = 0;
  private failure?: Error;
  private closed = false;
  private overflowReported = false;

  constructor(
    path: string,
    maxBytes: number,
    backups: number,
    private readonly maxQueuedLines: number,
  ) {
    this.worker = new Worker(ASYNC_LOG_WORKER_SOURCE, {
      eval: true,
      workerData: { path, maxBytes, backups },
    });
    this.worker.unref();
    this.worker.on("message", (result: AsyncLogBatchResult) => {
      const count = this.batches.get(result.sequence);
      if (count === undefined) return;
      this.batches.delete(result.sequence);
      this.inFlightLines = Math.max(0, this.inFlightLines - count);
      if (result.error) this.fail(new Error(result.error));
      this.notifyIfIdle();
    });
    this.worker.on("error", (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) this.fail(new Error(`Async log worker exited with code ${code}.`));
    });
  }

  write(line: string, level: WritableLogLevel): boolean {
    if (this.closed || this.failure) return false;
    if (this.pending.length + this.inFlightLines >= this.maxQueuedLines) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        writeFallback(
          `${new Date().toISOString()} WARN async_log_queue_full maxQueuedLines=${this.maxQueuedLines}`,
          "warn",
        );
      }
      return level !== "warn" && level !== "error";
    }
    this.pending.push(line);
    if (!this.scheduled) {
      this.scheduled = setImmediate(() => {
        this.scheduled = undefined;
        this.drain();
      });
      this.scheduled.unref();
    }
    return true;
  }

  async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = undefined;
    }
    this.drain();
    if (this.pending.length === 0 && this.inFlightLines === 0) return;
    await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush();
    } finally {
      this.closed = true;
      await this.worker.terminate();
    }
  }

  private drain(): void {
    if (this.pending.length === 0 || this.closed || this.failure) {
      this.notifyIfIdle();
      return;
    }
    const lines = this.pending.splice(0);
    const sequence = ++this.sequence;
    this.inFlightLines += lines.length;
    this.batches.set(sequence, lines.length);
    this.worker.postMessage({ sequence, count: lines.length, text: lines.join("") });
  }

  private notifyIfIdle(): void {
    if (this.pending.length > 0 || this.inFlightLines > 0) return;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    writeFallback(`${new Date().toISOString()} ERROR async_log_failed error=${JSON.stringify(this.failure.message)}`, "error");
    for (const waiter of this.waiters) waiter.reject(this.failure);
    this.waiters.clear();
  }
}

const ASYNC_LOG_WORKER_SOURCE = String.raw`
  const { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } = require("node:fs");
  const { dirname } = require("node:path");
  const { parentPort, workerData } = require("node:worker_threads");
  mkdirSync(dirname(workerData.path), { recursive: true, mode: 0o700 });

  function fileSize(path) {
    try { return statSync(path).size; }
    catch (error) { if (error && error.code === "ENOENT") return 0; throw error; }
  }
  function removeIfPresent(path) {
    try { unlinkSync(path); }
    catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  }
  function renameIfPresent(from, to) {
    try { renameSync(from, to); }
    catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  }
  function rotate(incomingBytes) {
    if (fileSize(workerData.path) + incomingBytes <= workerData.maxBytes) return;
    removeIfPresent(workerData.path + "." + workerData.backups);
    for (let index = workerData.backups - 1; index >= 1; index--) {
      renameIfPresent(workerData.path + "." + index, workerData.path + "." + (index + 1));
    }
    renameIfPresent(workerData.path, workerData.path + ".1");
  }
  parentPort.on("message", (batch) => {
    try {
      const bytes = Buffer.byteLength(batch.text);
      rotate(bytes);
      appendFileSync(workerData.path, batch.text, { encoding: "utf8", mode: 0o600 });
      parentPort.postMessage({ sequence: batch.sequence, count: batch.count });
    } catch (error) {
      parentPort.postMessage({
        sequence: batch.sequence,
        count: batch.count,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
`;

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function sessionIdPrefix(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionId.slice(0, 8) : undefined;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
