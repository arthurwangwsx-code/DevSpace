import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "devspace-native-host-"));
const socketPath = path.join(root, "bridge.sock");
const here = path.dirname(fileURLToPath(import.meta.url));
const server = net.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});

const child = spawn(process.execPath, [path.join(here, "devspace-browser-native-host.mjs")], {
  env: { ...process.env, DEVSPACE_BROWSER_SOCKET: socketPath },
  stdio: ["pipe", "pipe", "pipe"],
});
const socket = await new Promise((resolve, reject) => {
  server.once("connection", resolve);
  child.once("error", reject);
});

let stdout = Buffer.alloc(0);
child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
socket.write(JSON.stringify({ protocol: 1, id: "request", command: "hello", params: {} }) + "\n");
await waitFor(() => stdout.length >= 4 && stdout.length >= 4 + stdout.readUInt32LE(0));
const requestLength = stdout.readUInt32LE(0);
assert.deepEqual(JSON.parse(stdout.subarray(4, 4 + requestLength).toString("utf8")), {
  protocol: 1,
  id: "request",
  command: "hello",
  params: {},
});

let socketInput = Buffer.alloc(0);
socket.on("data", (chunk) => { socketInput = Buffer.concat([socketInput, chunk]); });
const largeResult = "x".repeat(2 * 1024 * 1024);
const response = Buffer.from(JSON.stringify({ protocol: 1, id: "request", ok: true, result: largeResult }));
const header = Buffer.alloc(4);
header.writeUInt32LE(response.length, 0);
child.stdin.write(header);
child.stdin.write(response);
await waitFor(() => socketInput.includes(0x0a));
const newline = socketInput.indexOf(0x0a);
const relayed = JSON.parse(socketInput.subarray(0, newline).toString("utf8"));
assert.equal(relayed.result.length, largeResult.length);

child.stdin.end();
socket.destroy();
server.close();
await new Promise((resolve) => child.once("exit", resolve));
await rm(root, { recursive: true, force: true });
console.log("browser native host tests passed: framing and 2 MiB extension response relay");

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for native host data");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
