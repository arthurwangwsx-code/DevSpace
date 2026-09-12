interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface TunnelMetricsSummary {
  commandsEnqueued: number;
  toolCalls: number;
  toolCallMeanEndToEndMs: number;
  httpClientRequests: number;
  httpClientMeanMs: number;
  finalQueueLength: number;
  queueCapacity: number;
  workerOccupancy: number;
  workerCapacity: number;
  finalHeapAllocMb: number;
  heapAllocGrowthMb: number;
  finalGoroutines: number;
  goroutineGrowth: number;
}

export function summarizeTunnelMetrics(before: string, after: string): TunnelMetricsSummary {
  const initial = parsePrometheus(before);
  const final = parsePrometheus(after);
  const selector = (labels: Record<string, string>) =>
    labels.latency_type === "enqueue_to_response" && labels.request_method === "tools/call";
  const toolCalls = delta(initial, final, "command_end_to_end_latency_milliseconds_count", selector);
  const toolLatencySum = delta(initial, final, "command_end_to_end_latency_milliseconds_sum", selector);
  const httpRequests = delta(initial, final, "http_client_request_duration_seconds_count");
  const httpLatencySeconds = delta(initial, final, "http_client_request_duration_seconds_sum");
  const initialHeap = total(initial, "go_memstats_heap_alloc_bytes");
  const finalHeap = total(final, "go_memstats_heap_alloc_bytes");
  const initialGoroutines = total(initial, "go_goroutines");
  const finalGoroutines = total(final, "go_goroutines");
  return {
    commandsEnqueued: rounded(delta(initial, final, "commands_enqueued_total")),
    toolCalls: rounded(toolCalls),
    toolCallMeanEndToEndMs: rounded(toolCalls > 0 ? toolLatencySum / toolCalls : 0),
    httpClientRequests: rounded(httpRequests),
    httpClientMeanMs: rounded(httpRequests > 0 ? httpLatencySeconds / httpRequests * 1_000 : 0),
    finalQueueLength: rounded(total(final, "commands_queue_length")),
    queueCapacity: rounded(total(final, "commands_queue_capacity")),
    workerOccupancy: rounded(total(final, "dispatcher_worker_pool_occupancy")),
    workerCapacity: rounded(total(final, "dispatcher_worker_pool_capacity")),
    finalHeapAllocMb: rounded(finalHeap / 1024 / 1024),
    heapAllocGrowthMb: rounded((finalHeap - initialHeap) / 1024 / 1024),
    finalGoroutines: rounded(finalGoroutines),
    goroutineGrowth: rounded(finalGoroutines - initialGoroutines),
  };
}

function parsePrometheus(text: string): PrometheusSample[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/);
    if (!match) return [];
    const value = Number(match[3]);
    if (!Number.isFinite(value)) return [];
    const labels: Record<string, string> = {};
    for (const label of match[2]?.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g) ?? []) {
      labels[label[1]!] = label[2]!.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
    return [{ name: match[1]!, labels, value }];
  });
}

function total(
  samples: PrometheusSample[],
  name: string,
  predicate: (labels: Record<string, string>) => boolean = () => true,
): number {
  return samples.reduce((sum, sample) =>
    sample.name === name && predicate(sample.labels) ? sum + sample.value : sum, 0);
}

function delta(
  before: PrometheusSample[],
  after: PrometheusSample[],
  name: string,
  predicate?: (labels: Record<string, string>) => boolean,
): number {
  return Math.max(0, total(after, name, predicate) - total(before, name, predicate));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
