#!/usr/bin/env node
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Chrome allows native hosts to send at most 1 MiB to an extension, while an
// extension may send up to 64 MiB to its host. Screenshot replies travel in
// the larger extension-to-host direction.
const MAX_HOST_TO_CHROME_BYTES = 1024 * 1024;
const MAX_CHROME_TO_HOST_BYTES = 64 * 1024 * 1024;
const socketPath = process.env.DEVSPACE_BROWSER_SOCKET
  || path.join(os.homedir(), ".devspace", "browser-extension.sock");
let nativeBuffer = Buffer.alloc(0);
let socketBuffer = "";
const socket = net.createConnection(socketPath);

function writeNative(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > MAX_HOST_TO_CHROME_BYTES) throw new Error("native messaging request exceeds 1 MiB");
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header); process.stdout.write(payload);
}

process.stdin.on("data", (chunk) => {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (length > MAX_CHROME_TO_HOST_BYTES) process.exit(2);
    if (nativeBuffer.length < length + 4) return;
    const payload = nativeBuffer.subarray(4, length + 4); nativeBuffer = nativeBuffer.subarray(length + 4);
    socket.write(payload); socket.write("\n");
  }
});

socket.on("data", (chunk) => {
  socketBuffer += chunk.toString("utf8");
  if (Buffer.byteLength(socketBuffer) > MAX_HOST_TO_CHROME_BYTES) process.exit(2);
  for (;;) {
    const newline = socketBuffer.indexOf("\n"); if (newline < 0) break;
    const line = socketBuffer.slice(0, newline); socketBuffer = socketBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { writeNative(JSON.parse(line)); } catch { writeNative({ protocol: 1, ok: false, error: "invalid DevSpace bridge response" }); }
  }
});
socket.on("error", () => process.exit(1));
process.stdin.on("end", () => socket.end());
