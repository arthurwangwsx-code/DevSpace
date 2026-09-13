import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { BrowserExtensionBridge } from "./browser-extension-bridge.js";

const root = await mkdtemp(join(os.tmpdir(), "devspace-browser-bridge-"));
const socketPath = join(root, "bridge.sock");
const bridge = new BrowserExtensionBridge(socketPath, 512);
await bridge.start();
assert.equal(bridge.connected, false);

const extension = net.createConnection(socketPath);
await new Promise<void>((resolve, reject) => { extension.once("connect", resolve); extension.once("error", reject); });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(bridge.connected, true);

let input = "";
extension.setEncoding("utf8");
extension.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
    if (request.command === "wait_for_disconnect") continue;
    const response = JSON.stringify({ protocol: 1, id: request.id, ok: true, result: { pong: request.command } }) + "\n";
    extension.write(response.slice(0, 7));
    extension.write(response.slice(7));
  }
});
const controller = new AbortController();
assert.deepEqual(await bridge.call("hello", {}, controller.signal), { pong: "hello" });

const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(bridge.call("never_sent", {}, alreadyAborted.signal), /request aborted/);

const disconnected = bridge.call("wait_for_disconnect", {}, controller.signal, 2_000);
extension.destroy();
await assert.rejects(disconnected, /disconnected/);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(bridge.connected, false);

const oversizedExtension = net.createConnection(socketPath);
await new Promise<void>((resolve, reject) => { oversizedExtension.once("connect", resolve); oversizedExtension.once("error", reject); });
await new Promise((resolve) => setTimeout(resolve, 10));
let oversizedInput = "";
oversizedExtension.setEncoding("utf8");
oversizedExtension.on("data", (chunk) => {
  oversizedInput += chunk;
  const newline = oversizedInput.indexOf("\n");
  if (newline < 0) return;
  const request = JSON.parse(oversizedInput.slice(0, newline));
  oversizedExtension.write(JSON.stringify({ protocol: 1, id: request.id, ok: true, result: "x".repeat(600) }) + "\n");
});
const oversized = bridge.call("oversized", {}, controller.signal, 2_000);
await assert.rejects(oversized, /exceeds the bridge limit/);

await bridge.stop();
await rm(root, { recursive: true, force: true });
console.log("browser extension bridge tests passed: fragmented reply, abort, disconnect, size limit");
