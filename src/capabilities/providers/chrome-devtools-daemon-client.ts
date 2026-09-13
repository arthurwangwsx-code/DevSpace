import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CapabilityError } from "../errors.js";
import type { JsonObject, JsonValue } from "../types.js";

const execFileAsync = promisify(execFile);
const MAX_DAEMON_RESPONSE_BYTES = 64 * 1024 * 1024;

interface DaemonResponse {
  success: boolean;
  result?: string;
  error?: string;
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}

export class ChromeDevToolsDaemonClient {
  readonly socketPath: string;
  private invocationTail: Promise<void> = Promise.resolve();
  private readonly activeSockets = new Set<Socket>();

  constructor(
    private readonly command: string,
    private readonly startArgs: string[],
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.socketPath = daemonSocketPath(environment);
  }

  async ensureRunning(signal: AbortSignal): Promise<void> {
    try {
      await this.status(signal);
      return;
    } catch (error) {
      if (socketExists(this.socketPath)) throw error;
    }
    if (this.startArgs[0] !== "start") {
      throw new CapabilityError(
        "provider_unavailable",
        "Chrome DevTools daemon is not running and the Provider has no start command.",
      );
    }
    try {
      await execFileAsync(this.command, this.startArgs, {
        env: this.environment,
        signal,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      throw new CapabilityError("provider_unavailable", "Chrome DevTools daemon could not be started.", {
        cause: error,
      });
    }
    await this.status(signal);
  }

  async status(signal: AbortSignal): Promise<JsonObject> {
    const response = await this.send({ method: "status" }, signal, 5_000);
    if (!response.success || typeof response.result !== "string") {
      throw new CapabilityError("provider_unavailable", response.error ?? "Chrome DevTools daemon is unavailable.");
    }
    return jsonObject(parseJson(response.result, "Chrome DevTools daemon status"), "Chrome DevTools daemon status");
  }

  disconnect(): void {
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
  }

  async callTool(tool: string, args: JsonObject, signal: AbortSignal): Promise<JsonValue> {
    const operation = this.invocationTail.then(async () => {
      if (signal.aborted) {
        throw new CapabilityError("cancelled", "Chrome DevTools daemon call cancelled.");
      }
      return this.send(
        { method: "invoke_tool", tool, args },
        signal,
        120_000,
        true,
      );
    });
    // A daemon command cannot be cancelled after it has crossed the socket. Keep
    // later calls behind the real downstream completion even if the Router has
    // already returned a cancellation or timeout to its caller.
    this.invocationTail = operation.then(() => undefined, () => undefined);
    const response = await raceAbort(operation, signal);
    if (!response.success || typeof response.result !== "string") {
      throw new CapabilityError("provider_unavailable", response.error ?? "Chrome DevTools daemon call failed.");
    }
    const result = parseJson(response.result, `${tool} result`) as McpToolResult;
    if (result.isError) {
      throw new CapabilityError("internal_error", toolErrorMessage(result.content));
    }
    const structured = result.structuredContent === undefined
      ? undefined
      : jsonObject(result.structuredContent, `${tool} structured result`);
    const content = result.content === undefined
      ? undefined
      : jsonValue(result.content, `${tool} content`);
    if (structured && content !== undefined && hasNonTextContent(result.content)) {
      return { ...structured, content };
    }
    return structured ?? { content: content ?? [] };
  }

  private send(
    request: JsonObject,
    signal: AbortSignal,
    timeoutMs: number,
    keepRunningAfterSend = false,
  ): Promise<DaemonResponse> {
    if (signal.aborted) {
      return Promise.reject(new CapabilityError("cancelled", "Chrome DevTools daemon call cancelled."));
    }
    assertDaemonSocket(this.socketPath);
    return new Promise((resolve, reject) => {
      let socket: Socket | undefined;
      let settled = false;
      let pending = Buffer.alloc(0);
      const finish = (error?: unknown, response?: DaemonResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (socket) this.activeSockets.delete(socket);
        socket?.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      const abort = () => finish(new CapabilityError("cancelled", "Chrome DevTools daemon call cancelled."));
      const timer = setTimeout(() => finish(new CapabilityError(
        "timeout",
        "Chrome DevTools daemon did not respond before the deadline.",
      )), timeoutMs);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      try {
        socket = createConnection({ path: this.socketPath });
        this.activeSockets.add(socket);
      } catch (error) {
        finish(error);
        return;
      }
      socket.once("connect", () => {
        if (settled) return;
        socket!.write(`${JSON.stringify(request)}\0`);
        if (keepRunningAfterSend) signal.removeEventListener("abort", abort);
      });
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.byteLength > MAX_DAEMON_RESPONSE_BYTES) {
          finish(new CapabilityError("output_too_large", "Chrome DevTools daemon response exceeded 64 MiB."));
          return;
        }
        const boundary = pending.indexOf(0);
        if (boundary === -1) return;
        try {
          finish(undefined, JSON.parse(pending.toString("utf8", 0, boundary)) as DaemonResponse);
        } catch (error) {
          finish(new CapabilityError("internal_error", "Chrome DevTools daemon returned invalid JSON.", {
            cause: error,
          }));
        }
      });
      socket.once("error", (error) => finish(new CapabilityError(
        "provider_unavailable",
        "Chrome DevTools daemon socket failed.",
        { cause: error },
      )));
      socket.once("close", () => {
        if (!settled) finish(new CapabilityError("provider_unavailable", "Chrome DevTools daemon socket closed."));
      });
    });
  }
}

function daemonSocketPath(environment: NodeJS.ProcessEnv): string {
  const override = environment.DEVSPACE_CHROME_DAEMON_SOCKET;
  if (override) return override;
  const suffix = environment.DEVSPACE_CHROME_DAEMON_SESSION_ID
    ? `-${environment.DEVSPACE_CHROME_DAEMON_SESSION_ID}`
    : "";
  const name = `chrome-devtools-mcp${suffix}`;
  if (process.platform === "win32") {
    return join("\\\\.\\pipe", `${name}-${userInfo().username}`, "server.sock");
  }
  if (environment.XDG_RUNTIME_DIR) return join(environment.XDG_RUNTIME_DIR, name, "server.sock");
  return join("/tmp", `${name}-${userInfo().uid}.sock`);
}

function socketExists(path: string): boolean {
  if (process.platform === "win32") return false;
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CapabilityError("internal_error", `${label} was not valid JSON.`, { cause: error });
  }
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new CapabilityError("cancelled", "Chrome DevTools daemon call cancelled.");
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(new CapabilityError("cancelled", "Chrome DevTools daemon call cancelled."));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

function assertDaemonSocket(path: string): void {
  if (process.platform === "win32") return;
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new CapabilityError("provider_unavailable", "Chrome DevTools daemon socket does not exist.", {
      cause: error,
    });
  }
  if (!stats.isSocket()) {
    throw new CapabilityError("provider_unavailable", "Chrome DevTools daemon endpoint is not a Unix socket.");
  }
  const current = process.getuid?.();
  if (current !== undefined && stats.uid !== current) {
    throw new CapabilityError("provider_unavailable", "Chrome DevTools daemon socket belongs to another user.");
  }
}

function jsonObject(value: unknown, label: string): JsonObject {
  const parsed = jsonValue(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapabilityError("internal_error", `${label} must be a JSON object.`);
  }
  return parsed;
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (error) {
    throw new CapabilityError("internal_error", `${label} is not JSON serializable.`, { cause: error });
  }
}

function toolErrorMessage(content: unknown): string {
  if (!Array.isArray(content)) return "Chrome DevTools tool returned an error.";
  const message = content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" && item.type === "text" && typeof item.text === "string",
    ))
    .map(({ text }) => text)
    .join(" ");
  return message || "Chrome DevTools tool returned an error.";
}

function hasNonTextContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((item) =>
    item && typeof item === "object" && item.type !== "text");
}
