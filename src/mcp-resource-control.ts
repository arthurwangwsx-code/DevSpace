import { getHeapStatistics } from "node:v8";

export type ResourceLimitReason =
  | "queue_full"
  | "queue_timeout"
  | "memory_pressure"
  | "session_capacity";

export class ResourceLimitError extends Error {
  constructor(
    readonly reason: ResourceLimitReason,
    message: string,
  ) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

interface QueuedRequest {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RequestGateStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

export interface BoundedRequestGateOptions {
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export class BoundedRequestGate {
  private active = 0;
  private readonly queue: QueuedRequest[] = [];
  private closed = false;

  constructor(private readonly options: BoundedRequestGateOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer.");
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer.");
    }
    if (!Number.isInteger(options.queueTimeoutMs) || options.queueTimeoutMs < 1) {
      throw new Error("queueTimeoutMs must be a positive integer.");
    }
  }

  get stats(): RequestGateStats {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueued: this.options.maxQueued,
    };
  }

  acquire(): Promise<() => void> {
    if (this.closed) {
      return Promise.reject(new ResourceLimitError("queue_full", "MCP request gate is closed."));
    }

    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    if (this.queue.length >= this.options.maxQueued) {
      return Promise.reject(
        new ResourceLimitError("queue_full", "MCP request queue is full; retry later."),
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const queued: QueuedRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) this.queue.splice(index, 1);
          reject(
            new ResourceLimitError("queue_timeout", "MCP request timed out while waiting for capacity."),
          );
        }, this.options.queueTimeoutMs),
      };
      queued.timer.unref();
      this.queue.push(queued);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queued of this.queue.splice(0)) {
      clearTimeout(queued.timer);
      queued.reject(new ResourceLimitError("queue_full", "MCP request gate is closed."));
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.createRelease());
        return;
      }

      this.active -= 1;
    };
  }
}

export type HeapPressureLevel = "normal" | "soft" | "hard";

export interface MemorySnapshot {
  level: HeapPressureLevel;
  heapUsed: number;
  heapLimit: number;
  heapRatio: number;
  rss: number;
  external: number;
  arrayBuffers: number;
}

export interface MemoryGuardOptions {
  softLimitRatio: number;
  hardLimitRatio: number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapLimit?: () => number;
}

export class MemoryGuard {
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly heapLimit: () => number;

  constructor(private readonly options: MemoryGuardOptions) {
    if (
      options.softLimitRatio <= 0
      || options.hardLimitRatio >= 1
      || options.softLimitRatio >= options.hardLimitRatio
    ) {
      throw new Error("Memory pressure ratios must satisfy 0 < soft < hard < 1.");
    }
    this.memoryUsage = options.memoryUsage ?? process.memoryUsage;
    this.heapLimit = options.heapLimit ?? (() => getHeapStatistics().heap_size_limit);
  }

  snapshot(): MemorySnapshot {
    const usage = this.memoryUsage();
    const heapLimit = this.heapLimit();
    const heapRatio = heapLimit > 0 ? usage.heapUsed / heapLimit : 1;
    const level: HeapPressureLevel = heapRatio >= this.options.hardLimitRatio
      ? "hard"
      : heapRatio >= this.options.softLimitRatio
        ? "soft"
        : "normal";

    return {
      level,
      heapUsed: usage.heapUsed,
      heapLimit,
      heapRatio,
      rss: usage.rss,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    };
  }
}
