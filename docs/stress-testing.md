# Stress and soak testing

DevSpace includes an isolated MCP workload runner for latency, concurrency,
workspace recovery, reconnect churn, streaming commands, and memory behavior.
It creates disposable fixtures under the operating system temporary directory,
starts a separate loopback-only DevSpace process, and never uses production
DevSpace state or approved project roots.

## Workload matrix

| Scenario | Evidence |
| --- | --- |
| Concurrent project work | Persistent MCP clients distributed across multiple workspaces alternate bounded reads and `apply_patch` writes. |
| Interactive latency | Read and write p50/p95/p99/max histograms; the default p95 objective is below 50 ms. |
| Long-running work | Commands return an early process handle and all five output chunks are recovered through `write_stdin`. |
| Capacity boundary | 128 blocked polls exceed the 32 executing + 64 queued performance profile. Explicit 503 overload is accepted; unrelated failures are not. |
| Session churn | Short-lived clients repeatedly initialize, list tools, and terminate their own MCP sessions. |
| Large files | A multi-page UTF-8 file is read to completion using returned byte cursors. |
| Workspace reuse | `release_workspace` unloads metadata, then the same persistent `workspaceId` restores without reopening. |
| Memory stability | RSS is sampled four times per second and correlated with one-minute `resource_snapshot` events. Long runs check post-warm-up RSS and heap slopes. |
| Local tunnel data path | `tunnel-client dev proxy` adds the in-memory control plane, dispatcher, queue, and tunnel client; before/after Prometheus metrics are retained. |

The overload scenario checks graceful degradation, not throughput alone. For a
direct server, excess requests must receive an explicit retryable overload while
admitted requests complete and a following read succeeds. A tunnel may apply
backpressure and complete all requests; other errors and failed recovery still
fail the run.

## Commands

```bash
npm run stress:smoke
npm run stress:local
npm run stress:tunnel-local
npm run stress:soak
```

| Profile | Clients | Workspaces | Business operations | Session churn | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| `smoke` | 8 | 4 | 20/client | 32 | bounded |
| `local` | 32 | 8 | 100/client | 512 | bounded |
| `soak` | 16 | 8 | duration-based, 100 ms think time | 5,000 alongside load | 24 h + 60 s cooldown |

Override dimensions when reproducing a problem:

```bash
npm run stress -- \
  --profile local \
  --concurrency 40 \
  --workspaces 10 \
  --operations 200 \
  --churn 1000 \
  --server-concurrency 32 \
  --server-queue 64 \
  --capacity-requests 128

npm run stress -- \
  --profile soak \
  --duration 30m \
  --think-time 100 \
  --cooldown 60s
```

Use `--keep-fixture` only while diagnosing a failed run. `--output /path`
changes the artifact root. A normal run writes `summary.json`, `summary.md`,
bounded process output, and structured events under
`artifacts/stress/<timestamp>/`. Setup or execution failures still write
`failure.json` and captured process output.

## Acceptance criteria

A bounded run passes only when:

- normal read and write p95 are both below 50 ms;
- business operations and session churn have no unexpected errors;
- long-task output is complete;
- multi-page reads and same-ID workspace restoration work;
- the capacity burst is completed or rejected explicitly as overload, and the
  next normal request succeeds;
- no fatal runtime error or heap-pressure event appears;
- DevSpace remains below 1 GiB RSS for the test profile.

Runs of ten minutes or longer additionally require less than 64 MiB post-warm-up
RSS growth, less than 32 MiB/hour RSS slope, and less than 16 MiB/hour V8 heap
slope. These are regression gates, not a mathematical proof of leak absence.
The 24-hour profile is the release-quality memory gate: sessions, heap, RSS,
queue depth, and latency should form a plateau.

Short-run RSS slopes are reported but not used as leak gates. Startup, JIT
compilation, native buffers, and delayed garbage collection make an hourly
extrapolation from a few seconds meaningless.

## Tunnel layers

`--transport tunnel-local` uses `tunnel-client dev proxy`. It exercises queueing,
dispatcher workers, polling, response delivery, and tunnel-client memory without
depending on the public network. The report includes command counts, mean end-to-
end latency, upstream HTTP latency, queue/worker state, Go heap, and goroutine
deltas.

It does not model Internet packet loss, the hosted control plane, regional edge
latency, OAuth approval, or account-specific throttling. Validate those with a
low-impact canary against the real tunnel:

```bash
tunnel-client health --require-control-plane-poll
devspace verify /path/to/an/already-approved-test-workspace \
  --url https://your-tunnel-host.example.com/mcp
```

Do not point the stress runner at a production workspace or public tunnel. For
hosted load testing, create a separate tunnel/profile and disposable approved
root, start at smoke volume, and coordinate the rate with the hosted service's
limits. Keep local and hosted reports separate so network/control-plane failures
are not mistaken for DevSpace tool latency.

The OpenAI [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
documents the health, readiness, metrics, and admin UI surfaces used by this
layered validation approach.
