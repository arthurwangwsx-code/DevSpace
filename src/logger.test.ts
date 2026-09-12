import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLogEvents, flushLogEvents, logEvent, type LoggingConfig } from "./logger.js";

const root = await mkdtemp(join(tmpdir(), "devspace-async-log-test-"));
const original = {
  path: process.env.DEVSPACE_ASYNC_LOG_FILE,
  maxBytes: process.env.DEVSPACE_ASYNC_LOG_MAX_BYTES,
  backups: process.env.DEVSPACE_ASYNC_LOG_BACKUPS,
};
const config: LoggingConfig = {
  level: "info",
  format: "json",
  requests: false,
  assets: false,
  toolCalls: false,
  shellCommands: false,
  trustProxy: false,
  slowRequestMs: 3_000,
  slowToolCallMs: 5_000,
  eventLoopLagMs: 1_000,
};

try {
  const logPath = join(root, "events.log");
  process.env.DEVSPACE_ASYNC_LOG_FILE = logPath;
  process.env.DEVSPACE_ASYNC_LOG_MAX_BYTES = "1048576";
  for (let index = 0; index < 100; index++) logEvent(config, "info", "async_test", { index });
  await flushLogEvents();
  const entries = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 100);
  assert.deepEqual(entries.map((entry) => entry.index), Array.from({ length: 100 }, (_, index) => index));

  await closeLogEvents();
  const rotatingPath = join(root, "rotating.log");
  process.env.DEVSPACE_ASYNC_LOG_FILE = rotatingPath;
  process.env.DEVSPACE_ASYNC_LOG_MAX_BYTES = "512";
  process.env.DEVSPACE_ASYNC_LOG_BACKUPS = "2";
  for (let index = 0; index < 30; index++) {
    logEvent(config, "info", "rotation_test", { index, payload: "x".repeat(80) });
    await flushLogEvents();
  }
  await closeLogEvents();
  const rotated = (await readdir(root)).filter((name) => name.startsWith("rotating.log"));
  assert.deepEqual(rotated.sort(), ["rotating.log", "rotating.log.1", "rotating.log.2"]);
  assert.match(await readFile(rotatingPath, "utf8"), /"index":29/);
  console.log("logger tests passed: asynchronous ordering, flush, bounded rotation");
} finally {
  await closeLogEvents().catch(() => {});
  if (original.path === undefined) delete process.env.DEVSPACE_ASYNC_LOG_FILE;
  else process.env.DEVSPACE_ASYNC_LOG_FILE = original.path;
  if (original.maxBytes === undefined) delete process.env.DEVSPACE_ASYNC_LOG_MAX_BYTES;
  else process.env.DEVSPACE_ASYNC_LOG_MAX_BYTES = original.maxBytes;
  if (original.backups === undefined) delete process.env.DEVSPACE_ASYNC_LOG_BACKUPS;
  else process.env.DEVSPACE_ASYNC_LOG_BACKUPS = original.backups;
  await rm(root, { recursive: true, force: true });
}
