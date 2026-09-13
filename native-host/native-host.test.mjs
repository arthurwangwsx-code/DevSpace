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
let server = net.createServer();
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

// DevSpace restarts must not require reloading the Chrome extension. Drop the
// Unix-socket server while leaving the native host alive, then recreate it and
// verify the same host process reconnects in both directions.
socket.destroy();
await new Promise((resolve) => server.close(resolve));
await rm(socketPath, { force: true });
server = net.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});
const reconnected = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("native host did not reconnect")), 5_000);
  server.once("connection", (value) => { clearTimeout(timer); resolve(value); });
});
reconnected.write(JSON.stringify({ protocol: 1, id: "after-restart", command: "hello", params: {} }) + "\n");
await waitFor(() => {
  let offset = 0;
  while (stdout.length >= offset + 4) {
    const size = stdout.readUInt32LE(offset);
    if (stdout.length < offset + 4 + size) return false;
    const value = JSON.parse(stdout.subarray(offset + 4, offset + 4 + size).toString("utf8"));
    if (value.id === "after-restart") return true;
    offset += 4 + size;
  }
  return false;
});
let reconnectedInput = "";
reconnected.setEncoding("utf8");
reconnected.on("data", (chunk) => { reconnectedInput += chunk; });
const afterRestart = Buffer.from(JSON.stringify({ protocol: 1, id: "extension-after-restart", ok: true, result: { ok: true } }));
const afterRestartHeader = Buffer.alloc(4);
afterRestartHeader.writeUInt32LE(afterRestart.length, 0);
child.stdin.write(afterRestartHeader);
child.stdin.write(afterRestart);
await waitFor(() => reconnectedInput.includes("extension-after-restart"));

child.stdin.end();
reconnected.destroy();
server.close();
await new Promise((resolve) => child.once("exit", resolve));
await rm(root, { recursive: true, force: true });
console.log("browser native host tests passed: framing, large relay, and DevSpace restart reconnect");

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for native host data");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
