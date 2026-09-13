import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { DevspaceTunnelConfig } from "./user-config.js";

export interface TunnelRuntimeStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  pid?: number;
  command?: string;
  publicBaseUrl?: string | null;
  restartCount: number;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  lastError?: string;
}

export class TunnelSupervisor {
  private child?: ChildProcess;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private restartCount = 0;
  private lastExitCode?: number | null;
  private lastExitSignal?: NodeJS.Signals | null;
  private lastError?: string;

  constructor(
    private readonly config: DevspaceTunnelConfig | undefined,
    private readonly localMcpUrl: string,
  ) {}

  start(): void {
    if (!this.shouldRun() || this.child) return;
    this.stopping = false;
    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveDone) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveDone();
      });
      child.kill("SIGTERM");
    });
  }

  status(): TunnelRuntimeStatus {
    return {
      configured: Boolean(this.config?.command),
      enabled: this.shouldRun(),
      running: Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null),
      pid: this.child?.pid,
      command: this.config?.command,
      publicBaseUrl: this.config?.publicBaseUrl,
      restartCount: this.restartCount,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastError: this.lastError,
    };
  }

  private shouldRun(): boolean {
    return Boolean(this.config?.enabled && this.config.autoStart !== false && this.config.command?.trim());
  }

  private spawnChild(): void {
    const config = this.config;
    if (!config?.command) return;
    const publicBaseUrl = config.publicBaseUrl ?? "";
    const replace = (value: string) => value
      .replaceAll("${localMcpUrl}", this.localMcpUrl)
      .replaceAll("${publicBaseUrl}", publicBaseUrl);
    const command = replace(expandHomePath(config.command));
    const args = (config.args ?? []).map(replace);
    const cwd = config.cwd ? resolve(expandHomePath(config.cwd)) : undefined;
    try {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          DEVSPACE_LOCAL_MCP_URL: this.localMcpUrl,
          DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
          ...(config.environment ?? {}),
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      this.child = child;
      child.once("error", (error) => {
        this.lastError = error.message;
      });
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = undefined;
        this.lastExitCode = code;
        this.lastExitSignal = signal;
        if (this.stopping || config.restartOnExit === false) return;
        this.restartCount += 1;
        this.restartTimer = setTimeout(() => this.spawnChild(), Math.min(30_000, 1_000 * (this.restartCount + 1)));
        this.restartTimer.unref();
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}
