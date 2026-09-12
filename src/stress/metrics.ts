export interface LatencySummary {
  count: number;
  errors: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

const DEFAULT_MAX_TRACKED_MS = 60_000;

export class LatencyHistogram {
  private readonly buckets: Uint32Array;
  private count = 0;
  private errors = 0;
  private totalMs = 0;
  private minMs = Number.POSITIVE_INFINITY;
  private maxMs = 0;

  constructor(private readonly maxTrackedMs = DEFAULT_MAX_TRACKED_MS) {
    if (!Number.isInteger(maxTrackedMs) || maxTrackedMs < 1) {
      throw new Error("maxTrackedMs must be a positive integer");
    }
    this.buckets = new Uint32Array(maxTrackedMs + 2);
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("durationMs must be finite and non-negative");
    }
    const bucket = Math.min(this.maxTrackedMs + 1, Math.floor(durationMs));
    this.buckets[bucket]++;
    this.count++;
    this.totalMs += durationMs;
    this.minMs = Math.min(this.minMs, durationMs);
    this.maxMs = Math.max(this.maxMs, durationMs);
  }

  recordError(): void {
    this.errors++;
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      errors: this.errors,
      minMs: this.count === 0 ? 0 : rounded(this.minMs),
      meanMs: this.count === 0 ? 0 : rounded(this.totalMs / this.count),
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: rounded(this.maxMs),
    };
  }

  percentile(percentile: number): number {
    if (this.count === 0) return 0;
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
      throw new Error("percentile must be between 0 and 1");
    }
    const target = Math.max(1, Math.ceil(this.count * percentile));
    let seen = 0;
    for (let index = 0; index < this.buckets.length; index++) {
      seen += this.buckets[index];
      if (seen >= target) return Math.min(index, this.maxTrackedMs + 1);
    }
    return this.maxTrackedMs + 1;
  }
}

export class StressMetrics {
  private readonly operations = new Map<string, LatencyHistogram>();
  private readonly failures = new Map<string, number>();
  private readonly failureExamples = new Map<string, string[]>();

  async measure<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const histogram = this.histogram(operation);
    const startedAt = performance.now();
    try {
      const result = await action();
      histogram.record(performance.now() - startedAt);
      return result;
    } catch (error) {
      histogram.recordError();
      const key = classifyFailure(error);
      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
      const examples = this.failureExamples.get(key) ?? [];
      if (examples.length < 5) {
        examples.push(error instanceof Error ? error.message : String(error));
        this.failureExamples.set(key, examples);
      }
      throw error;
    }
  }

  report(): {
    operations: Record<string, LatencySummary>;
    failures: Record<string, number>;
    failureExamples: Record<string, string[]>;
  } {
    return {
      operations: Object.fromEntries(
        Array.from(this.operations.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, histogram]) => [name, histogram.summary()]),
      ),
      failures: Object.fromEntries(Array.from(this.failures.entries()).sort()),
      failureExamples: Object.fromEntries(Array.from(this.failureExamples.entries()).sort()),
    };
  }

  private histogram(operation: string): LatencyHistogram {
    let histogram = this.operations.get(operation);
    if (!histogram) {
      histogram = new LatencyHistogram();
      this.operations.set(operation, histogram);
    }
    return histogram;
  }
}

function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b413\b|too large|request size/i.test(message)) return "payload_too_large";
  if (/\b503\b|overload|queue|capacity|budget busy/i.test(message)) return "overloaded";
  if (/timeout/i.test(message)) return "timeout";
  if (/ECONNRESET|fetch failed|connection/i.test(message)) return "connection";
  return "other";
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
