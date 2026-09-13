#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const script = join(root, "scripts", "test-browser-open-world-readonly.ts");

for (const [url, expected] of [
  ["http://example.com/", /must use HTTPS/],
  ["https://user:secret@example.com/", /must not contain credentials/],
]) {
  const result = spawnSync(process.execPath, [runner, script, "--external-url", url], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, expected);
}

console.log("browser open-world read-only tests passed: HTTPS and credential guards");
