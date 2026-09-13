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
let socket;
let socketConnected = false;
let reconnectTimer;
let stdinEnded = false;
const pendingNativePayloads = [];
let cachedProfileHello;

function connectSocket() {
  if (stdinEnded || socket) return;
  const current = net.createConnection(socketPath);
  socket = current;
  current.setEncoding("utf8");
  current.on("connect", () => {
    if (socket !== current) return;
    socketConnected = true;
    socketBuffer = "";
    // The extension sends profile_hello only when it opens the native port.
    // A DevSpace restart replaces the Unix-socket server without replacing
    // that port, so replay the cached identity before any queued commands.
    if (cachedProfileHello) {
      current.write(cachedProfileHello);
      current.write("\n");
    }
    while (pendingNativePayloads.length > 0) {
      current.write(pendingNativePayloads.shift());
      current.write("\n");
    }
  });
  current.on("data", consumeSocketData);
  current.on("error", () => {
    // DevSpace may legitimately restart while Chrome keeps this native host
    // alive. Do not kill the host; reconnect to the stable Unix socket.
  });
  current.on("close", () => {
    if (socket === current) {
      socket = undefined;
      socketConnected = false;
      socketBuffer = "";
    }
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (stdinEnded || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectSocket();
  }, 250);
  reconnectTimer.unref?.();
}

function relayToSocket(payload) {
  if (isProfileHello(payload)) cachedProfileHello = payload;
  if (socket && socketConnected && !socket.destroyed) {
    socket.write(payload);
    socket.write("\n");
    return;
  }
  // profile_hello is state, not an RPC. The cached copy is replayed exactly
  // once per socket connection and must not also accumulate in the queue.
  if (!isProfileHello(payload)) pendingNativePayloads.push(payload);
  // Bound memory while DevSpace is offline. Chrome's extension side will retry
  // higher-level requests, so retaining the newest messages is preferable to
  // an unbounded native-host queue.
  if (pendingNativePayloads.length > 128) pendingNativePayloads.shift();
  connectSocket();
}

function isProfileHello(payload) {
  try {
    const value = JSON.parse(payload.toString("utf8"));
    return value?.protocol === 1 && value?.event === "profile_hello";
  } catch {
    return false;
  }
}

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
    relayToSocket(payload);
  }
});

function consumeSocketData(chunk) {
  socketBuffer += chunk.toString("utf8");
  if (Buffer.byteLength(socketBuffer) > MAX_HOST_TO_CHROME_BYTES) process.exit(2);
  for (;;) {
    const newline = socketBuffer.indexOf("\n"); if (newline < 0) break;
    const line = socketBuffer.slice(0, newline); socketBuffer = socketBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { writeNative(JSON.parse(line)); } catch { writeNative({ protocol: 1, ok: false, error: "invalid DevSpace bridge response" }); }
  }
}

process.stdin.on("end", () => {
  stdinEnded = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.end();
});

connectSocket();
