import { randomUUID } from "node:crypto";
import { mkdir, chmod, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "../types.js";

export const BROWSER_EXTENSION_PROTOCOL = 1;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

interface PendingCall {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class BrowserExtensionBridge {
  private server?: net.Server;
  private extension?: net.Socket;
  private extensionBuffer = "";
  private pending = new Map<string, PendingCall>();

  constructor(
    readonly socketPath: string,
    private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    this.rejectPending(new Error("browser extension bridge stopped"));
    this.extension?.destroy();
    this.extension = undefined;
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined; await rm(this.socketPath, { force: true });
  }

  get connected(): boolean { return Boolean(this.extension && !this.extension.destroyed); }

  call(command: string, params: JsonObject, signal: AbortSignal, timeoutMs = 10_000): Promise<JsonValue> {
    if (signal.aborted) return Promise.reject(new Error("browser extension request aborted"));
    const socket = this.extension;
    if (!socket || socket.destroyed) return Promise.reject(new Error("browser extension is not connected"));
    const id = randomUUID();
    return new Promise<JsonValue>((resolve, reject) => {
      const finish = (error?: Error, value?: JsonValue) => {
        const entry = this.pending.get(id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(id); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value ?? null);
      };
      const aborted = () => finish(new Error("browser extension request aborted"));
      const timer = setTimeout(() => finish(new Error(`browser extension request timed out: ${command}`)), timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error), timer });
      signal.addEventListener("abort", aborted, { once: true });
      socket.write(
        JSON.stringify({ protocol: BROWSER_EXTENSION_PROTOCOL, id, command, params }) + "\n",
        (error) => {
          if (error) finish(new Error(`browser extension bridge write failed: ${error.message}`));
        },
      );
    });
  }

  private accept(socket: net.Socket): void {
    if (this.extension && !this.extension.destroyed) {
      this.rejectPending(new Error("browser extension connection was replaced"));
      this.extension.destroy();
    }
    this.extension = socket; this.extensionBuffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.consume(String(chunk)));
    socket.on("error", () => {
      if (this.extension === socket) this.rejectPending(new Error("browser extension connection failed"));
    });
    socket.on("close", () => {
      if (this.extension === socket) {
        this.extension = undefined;
        this.extensionBuffer = "";
        this.rejectPending(new Error("browser extension disconnected"));
      }
    });
  }

  private consume(chunk: string): void {
    this.extensionBuffer += chunk;
    if (Buffer.byteLength(this.extensionBuffer) > this.maxMessageBytes) {
      this.rejectPending(new Error("browser extension response exceeds the bridge limit"));
      this.extension?.destroy();
      return;
    }
    for (;;) {
      const newline = this.extensionBuffer.indexOf("\n"); if (newline < 0) return;
      const line = this.extensionBuffer.slice(0, newline); this.extensionBuffer = this.extensionBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { protocol?: number; id?: string; ok?: boolean; result?: JsonValue; error?: string };
        if (message.protocol !== BROWSER_EXTENSION_PROTOCOL || !message.id) continue;
        const pending = this.pending.get(message.id); if (!pending) continue;
        if (message.ok) pending.resolve(message.result ?? null); else pending.reject(new Error(message.error || "browser extension request failed"));
      } catch {}
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
