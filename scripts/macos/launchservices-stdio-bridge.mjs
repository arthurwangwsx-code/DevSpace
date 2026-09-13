#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.error("LaunchServices stdio bridge requires macOS.");
  process.exit(2);
}

const bundlePath = resolve(process.argv[2] ?? "");
if (!bundlePath.endsWith(".app") || !existsSync(join(bundlePath, "Contents", "Info.plist"))) {
  console.error("Usage: launchservices-stdio-bridge.mjs <absolute-app-bundle-path>");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "devspace-launchservices-stdio-"));
const inputPath = join(root, "stdin.fifo");
const outputPath = join(root, "stdout.fifo");
const stderrPath = join(root, "app.stderr.log");
for (const path of [inputPath, outputPath]) {
  const created = spawnSync("/usr/bin/mkfifo", [path], { encoding: "utf8" });
  if (created.status !== 0) fail(`mkfifo failed: ${created.stderr.trim()}`);
}

let settled = false;
let input;
let output;
let launcher;
let startupTimer;

try {
  launcher = spawn("/usr/bin/open", [
    "-n", "-j",
    "-i", inputPath,
    "-o", outputPath,
    "--stderr", stderrPath,
    bundlePath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  launcher.stderr?.pipe(process.stderr);
  launcher.once("error", (error) => fail(`LaunchServices failed: ${error.message}`));
  launcher.once("exit", (code) => {
    if (code !== 0) fail(`LaunchServices exited with code ${code ?? "unknown"}.`);
  });

  output = createReadStream(outputPath);
  input = createWriteStream(inputPath);
  output.on("data", () => {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
  });
  output.pipe(process.stdout, { end: false });
  output.once("end", () => finish(0));
  output.once("error", (error) => fail(`Desktop Host stdout bridge failed: ${error.message}`));
  input.once("error", (error) => fail(`Desktop Host stdin bridge failed: ${error.message}`));
  process.stdin.pipe(input);
  process.stdin.once("end", () => input?.end());

  startupTimer = setTimeout(() => fail("Desktop Host did not produce MCP output within 15 seconds."), 15_000);
  startupTimer.unref();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    input?.destroy();
    output?.destroy();
    finish(0);
  });
}

function fail(message) {
  if (settled) return;
  const appStderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
  console.error(appStderr ? `${message}\n${appStderr}` : message);
  finish(1);
}

function finish(code) {
  if (settled) return;
  settled = true;
  if (startupTimer) clearTimeout(startupTimer);
  process.stdin.unpipe(input);
  input?.destroy();
  output?.destroy();
  launcher?.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
}
