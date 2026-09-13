import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devspace-native-host-"));
const socketPath = path.join(root, "bridge.sock");
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline));
    assert.equal(request.command, "hello");
    socket.write(JSON.stringify({ protocol: 1, id: request.id, ok: true, result: { pong: true } }) + "\n");
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });

const child = spawn(process.execPath, ["native-host/devspace-browser-native-host.mjs"], {
  cwd: process.cwd(), env: { ...process.env, DEVSPACE_BROWSER_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"],
});
const request = Buffer.from(JSON.stringify({ protocol: 1, id: "test", command: "hello", params: {} }));
const header = Buffer.alloc(4); header.writeUInt32LE(request.length, 0);
child.stdin.write(Buffer.concat([header, request]));

const reply = await new Promise((resolve, reject) => {
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) return;
    resolve(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
  });
  child.once("error", reject);
  setTimeout(() => reject(new Error("native host test timed out")), 3000).unref();
});
assert.deepEqual(reply, { protocol: 1, id: "test", ok: true, result: { pong: true } });
child.kill();
await new Promise((resolve) => server.close(resolve));
fs.rmSync(root, { recursive: true, force: true });
console.log("browser native host transport test passed");
