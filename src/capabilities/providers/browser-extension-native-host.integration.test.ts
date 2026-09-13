import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserExtensionBridge } from "./browser-extension-bridge.js";

interface NativeMessage {
  protocol?: number;
  id?: string;
  event?: string;
  command?: string;
  [key: string]: unknown;
}

interface TestHost {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  messages: NativeMessage[];
  send(value: NativeMessage): void;
}

const root = await mkdtemp(path.join(os.tmpdir(), "devspace-browser-host-integration-"));
const socketPath = path.join(root, "bridge.sock");
const nativeHostPath = fileURLToPath(new URL("../../../native-host/devspace-browser-native-host.mjs", import.meta.url));
const bridge = new BrowserExtensionBridge(socketPath);
const controller = new AbortController();
const hosts: TestHost[] = [];

try {
  await bridge.start();

  const first = startHost("first", socketPath);
  hosts.push(first);
  first.send(profileHello("shared-profile", "0.3.1"));
  await waitFor(() => bridge.listProfiles().some(({ profileId }) => profileId === "shared-profile"));
  assert.deepEqual(
    await bridge.call("who", {}, controller.signal, 2_000, "shared-profile"),
    { host: "first" },
  );

  const replacement = startHost("replacement", socketPath);
  hosts.push(replacement);
  replacement.send(profileHello("shared-profile", "0.3.2"));
  const firstExit = await withTimeout(first.exit, 5_000, "superseded native host did not exit");
  assert.deepEqual(firstExit, { code: 0, signal: null });
  assert.equal(
    first.messages.some(({ event }) => event === "native_host_shutdown"),
    false,
    "the local retirement frame must not be forwarded to Chrome",
  );
  await waitFor(() => bridge.listProfiles().some(({ profileId, extensionVersion }) => (
    profileId === "shared-profile" && extensionVersion === "0.3.2"
  )));
  assert.deepEqual(
    await bridge.call("who", {}, controller.signal, 2_000, "shared-profile"),
    { host: "replacement" },
  );

  await assert.rejects(
    bridge.call("never_replies", {}, controller.signal, 25, "shared-profile"),
    /timed out/,
  );
  const replacementExit = await withTimeout(replacement.exit, 5_000, "timed-out native host did not exit");
  assert.deepEqual(replacementExit, { code: 0, signal: null });
  await waitFor(() => !bridge.listProfiles().some(({ profileId }) => profileId === "shared-profile"));

  const recovered = startHost("recovered", socketPath);
  hosts.push(recovered);
  recovered.send(profileHello("shared-profile", "0.3.2"));
  await waitFor(() => bridge.listProfiles().some(({ profileId }) => profileId === "shared-profile"));
  assert.deepEqual(
    await bridge.call("who", {}, controller.signal, 2_000, "shared-profile"),
    { host: "recovered" },
  );
} finally {
  controller.abort();
  await bridge.stop();
  await Promise.all(hosts.map(async ({ child, exit }) => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    try {
      await withTimeout(exit, 2_000, "native host cleanup timed out");
    } catch {
      child.kill("SIGTERM");
      await exit;
    }
  }));
  await rm(root, { recursive: true, force: true });
}

console.log("browser bridge/native host integration passed: replacement, timeout retirement, and recovery");

function startHost(name: string, bridgeSocketPath: string): TestHost {
  const child = spawn(process.execPath, [nativeHostPath], {
    env: { ...process.env, DEVSPACE_BROWSER_SOCKET: bridgeSocketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: NativeMessage[] = [];
  let stdout = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    for (;;) {
      if (stdout.length < 4) return;
      const length = stdout.readUInt32LE(0);
      if (stdout.length < length + 4) return;
      const message = JSON.parse(stdout.subarray(4, length + 4).toString("utf8")) as NativeMessage;
      stdout = stdout.subarray(length + 4);
      messages.push(message);
      if (typeof message.id !== "string" || message.command === "never_replies") continue;
      writeNativeFrame(child, {
        protocol: 1,
        id: message.id,
        ok: true,
        result: { host: name },
      });
    }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exit,
    messages,
    send(value) { writeNativeFrame(child, value); },
  };
}

function profileHello(profileId: string, extensionVersion: string): NativeMessage {
  return {
    protocol: 1,
    event: "profile_hello",
    profile: { profileId, focused: true, extensionVersion },
  };
}

function writeNativeFrame(child: ChildProcessWithoutNullStreams, value: NativeMessage): void {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  child.stdin.write(header);
  child.stdin.write(payload);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for browser bridge state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
