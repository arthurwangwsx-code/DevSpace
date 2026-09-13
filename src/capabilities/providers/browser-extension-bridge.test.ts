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
const competingBridge = new BrowserExtensionBridge(socketPath, 512);
await assert.rejects(competingBridge.start(), /already in use/);

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

const profileA = net.createConnection(socketPath);
const profileB = net.createConnection(socketPath);
await Promise.all([
  new Promise<void>((resolve, reject) => { profileA.once("connect", resolve); profileA.once("error", reject); }),
  new Promise<void>((resolve, reject) => { profileB.once("connect", resolve); profileB.once("error", reject); }),
]);
profileA.write(JSON.stringify({ protocol: 1, event: "profile_hello", profile: { profileId: "profile-a", focused: false, extensionVersion: "0.2.0" } }) + "\n");
profileB.write(JSON.stringify({ protocol: 1, event: "profile_hello", profile: { profileId: "profile-b", focused: true, extensionVersion: "0.2.0" } }) + "\n");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(bridge.listProfiles().map((profile) => profile.profileId).sort(), ["profile-a", "profile-b"]);

let inputA = "";
let inputB = "";
profileA.setEncoding("utf8");
profileB.setEncoding("utf8");
profileA.on("data", (chunk) => respond(profileA, "a", chunk));
profileB.on("data", (chunk) => respond(profileB, "b", chunk));
assert.deepEqual(await bridge.call("who", {}, controller.signal, 2_000, "profile-a"), { profile: "a" });
assert.deepEqual(await bridge.call("who", {}, controller.signal, 2_000), { profile: "b" });

function respond(socket: net.Socket, label: string, chunk: string | Buffer) {
  if (socket === profileA) inputA += chunk;
  else inputB += chunk;
  const value = socket === profileA ? inputA : inputB;
  const newline = value.indexOf("\n");
  if (newline < 0) return;
  const request = JSON.parse(value.slice(0, newline));
  if (socket === profileA) inputA = value.slice(newline + 1);
  else inputB = value.slice(newline + 1);
  socket.write(JSON.stringify({ protocol: 1, id: request.id, ok: true, result: { profile: label } }) + "\n");
}

profileA.destroy();
profileB.destroy();

await bridge.stop();
await rm(root, { recursive: true, force: true });
console.log("browser extension bridge tests passed: singleton socket, fragmented reply, abort, disconnect, size limit, multi-profile routing");
