import assert from "node:assert/strict";
import { summarizeTunnelMetrics } from "./tunnel-metrics.js";

const before = `
commands_enqueued_total 2
command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_response",request_method="tools/call"} 2
command_end_to_end_latency_milliseconds_sum{latency_type="enqueue_to_response",request_method="tools/call"} 20
http_client_request_duration_seconds_count 2
http_client_request_duration_seconds_sum 0.02
go_memstats_heap_alloc_bytes 1048576
go_goroutines 10
`;
const after = `
commands_enqueued_total 7
command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_response",request_method="tools/call"} 5
command_end_to_end_latency_milliseconds_sum{latency_type="enqueue_to_response",request_method="tools/call"} 80
http_client_request_duration_seconds_count 5
http_client_request_duration_seconds_sum 0.08
commands_queue_length 0
commands_queue_capacity 256
dispatcher_worker_pool_occupancy 0
dispatcher_worker_pool_capacity 16
go_memstats_heap_alloc_bytes 2097152
go_goroutines 12
`;
const summary = summarizeTunnelMetrics(before, after);
assert.equal(summary.commandsEnqueued, 5);
assert.equal(summary.toolCalls, 3);
assert.equal(summary.toolCallMeanEndToEndMs, 20);
assert.equal(summary.httpClientMeanMs, 20);
assert.equal(summary.queueCapacity, 256);
assert.equal(summary.heapAllocGrowthMb, 1);
assert.equal(summary.goroutineGrowth, 2);
