import { randomUUID } from "node:crypto";
import { mkdir, chmod, rm, stat } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "../types.js";

export const BROWSER_EXTENSION_PROTOCOL = 1;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const NATIVE_HOST_SHUTDOWN_EVENT = "native_host_shutdown";

interface PendingCall {
  socket: net.Socket;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ExtensionConnection {
  socket: net.Socket;
  buffer: string;
  profileId?: string;
  profile?: JsonObject;
}

export class BrowserExtensionBridge {
  private server?: net.Server;
  private socketIdentity?: { dev: number; ino: number };
  private readonly connections = new Set<ExtensionConnection>();
  private readonly profiles = new Map<string, ExtensionConnection>();
  private pending = new Map<string, PendingCall>();

  constructor(
    readonly socketPath: string,
    private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (await socketAcceptsConnections(this.socketPath)) {
      throw new Error(`browser extension socket is already in use: ${this.socketPath}`);
    }
    await rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(this.socketPath, 0o600);
    const socketInfo = await stat(this.socketPath);
    this.socketIdentity = { dev: socketInfo.dev, ino: socketInfo.ino };
  }

  async stop(): Promise<void> {
    this.rejectPending(new Error("browser extension bridge stopped"));
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    this.profiles.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    const identity = this.socketIdentity;
    this.socketIdentity = undefined;
    if (identity) {
      try {
        const current = await stat(this.socketPath);
        if (current.dev === identity.dev && current.ino === identity.ino) {
          await rm(this.socketPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  get connected(): boolean { return [...this.connections].some(({ socket }) => !socket.destroyed); }

  listProfiles(): JsonObject[] {
    return [...this.profiles.entries()].map(([profileId, connection]) => ({
      profileId,
      ...(connection.profile ?? {}),
    }));
  }

  call(
    command: string,
    params: JsonObject,
    signal: AbortSignal,
    timeoutMs = 10_000,
    profileId?: string,
  ): Promise<JsonValue> {
    if (signal.aborted) return Promise.reject(new Error("browser extension request aborted"));
    const socket = this.selectConnection(profileId)?.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error(profileId
        ? `browser extension profile is not connected: ${profileId}`
        : "browser extension is not connected"));
    }
    const id = randomUUID();
    return new Promise<JsonValue>((resolve, reject) => {
      const finish = (error?: Error, value?: JsonValue) => {
        const entry = this.pending.get(id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(id); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value ?? null);
      };
      const aborted = () => finish(new Error("browser extension request aborted"));
      const timer = setTimeout(() => {
        this.retireSocket(socket, "request_timeout");
        finish(new Error(`browser extension request timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { socket, resolve: (value) => finish(undefined, value), reject: (error) => finish(error), timer });
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
    const connection: ExtensionConnection = { socket, buffer: "" };
    this.connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.consume(connection, String(chunk)));
    socket.on("error", () => {
      this.rejectPendingForSocket(socket, new Error("browser extension connection failed"));
    });
    socket.on("close", () => {
      this.connections.delete(connection);
      if (connection.profileId && this.profiles.get(connection.profileId) === connection) {
        this.profiles.delete(connection.profileId);
      }
      this.rejectPendingForSocket(socket, new Error("browser extension disconnected"));
    });
  }

  private consume(connection: ExtensionConnection, chunk: string): void {
    connection.buffer += chunk;
    if (Buffer.byteLength(connection.buffer) > this.maxMessageBytes) {
      this.rejectPendingForSocket(connection.socket, new Error("browser extension response exceeds the bridge limit"));
      connection.socket.destroy();
      return;
    }
    for (;;) {
      const newline = connection.buffer.indexOf("\n"); if (newline < 0) return;
      const line = connection.buffer.slice(0, newline); connection.buffer = connection.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as {
          protocol?: number;
          id?: string;
          ok?: boolean;
          result?: JsonValue;
          error?: string;
          event?: string;
          profile?: JsonObject;
        };
        if (message.protocol !== BROWSER_EXTENSION_PROTOCOL) continue;
        if (message.event === "profile_hello" && message.profile) {
          const profileId = typeof message.profile.profileId === "string" ? message.profile.profileId : undefined;
          if (!profileId) continue;
          const replaced = this.profiles.get(profileId);
          if (replaced && replaced !== connection) this.retireSocket(replaced.socket, "profile_replaced");
          connection.profileId = profileId;
          connection.profile = message.profile;
          this.profiles.set(profileId, connection);
          continue;
        }
        if (!message.id) continue;
        const pending = this.pending.get(message.id); if (!pending) continue;
        if (pending.socket !== connection.socket) continue;
        if (message.ok) pending.resolve(message.result ?? null); else pending.reject(new Error(message.error || "browser extension request failed"));
      } catch {}
    }
  }

  private selectConnection(profileId?: string): ExtensionConnection | undefined {
    if (profileId) return this.profiles.get(profileId);
    const focused = [...this.profiles.values()].find(({ profile }) => profile?.focused === true);
    if (focused) return focused;
    if (this.profiles.size > 0) return this.profiles.values().next().value;
    if (this.connections.size === 1) return this.connections.values().next().value;
    return undefined;
  }

  private retireSocket(socket: net.Socket, reason: "profile_replaced" | "request_timeout"): void {
    if (socket.destroyed) return;
    const fallback = setTimeout(() => socket.destroy(), 250);
    fallback.unref();
    socket.end(`${JSON.stringify({
      protocol: BROWSER_EXTENSION_PROTOCOL,
      event: NATIVE_HOST_SHUTDOWN_EVENT,
      reason,
    })}\n`, () => {
      clearTimeout(fallback);
      socket.destroy();
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPendingForSocket(socket: net.Socket, error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (error: Error | undefined, active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(active);
    };
    const timer = setTimeout(() => finish(new Error(`timed out probing browser extension socket: ${socketPath}`), false), 1_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(undefined, true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish(undefined, false);
      else finish(error, false);
    });
  });
}
