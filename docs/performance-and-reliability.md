# Performance and reliability plan

This document separates shipped controls from future experiments. The target is a
long-lived local MCP service that keeps reusable connections and workspace handles
available, while degrading predictably under host, network, or client pressure.

## Failure model

The request path has four independent layers:

```text
ChatGPT -> OpenAI control plane -> tunnel-client -> DevSpace -> filesystem/process
```

A healthy process is not sufficient evidence that the complete path works. Use the
following gates in order:

1. DevSpace `/healthz` responds within its latency objective.
2. `tunnel-client health --require-control-plane-poll` succeeds. A raw `/readyz`
   HTTP 200 can carry a degraded body and is not enough on its own.
3. MCP initialize and `tools/list` succeed.
4. A real `open_workspace`, small `read`, and `exec_command` succeed.

The OpenAI [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
also treats health, readiness, metrics, and a current tunnel-client release as
separate operational checks.

## Shipped controls

### Keep connections, recover workspaces

- Idle MCP transports remain reusable. Capacity, heap pressure, LRU, and the
  twelve-hour abandoned-session TTL are the cleanup mechanisms.
- Workspace metadata sleeps after four idle hours, but its SQLite `workspaceId`
  remains recoverable. A conversation can continue without reopening the folder.
- Checkout-mode `open_workspace` resumes the latest handle. `forceNew: true`
  supersedes the prior active checkout handle instead of accumulating many active
  rows; the older ID can still be restored directly.

### Keep the event loop responsive

- Workspace activity timestamps are coalesced for one second and written in a
  dedicated Node worker thread using one SQLite transaction. Tool calls no longer
  perform a synchronous SQLite write on the HTTP event loop.
- The writer has one bounded in-flight drain and an explicit shutdown flush, so
  it cannot create an unbounded promise or message backlog.
- Large file reads, MCP request bodies, edit snapshots, process output, discovery,
  request concurrency, and waiting queues all have explicit budgets.

Node's official guidance is to keep expensive work off the event loop and use
[worker threads](https://nodejs.org/api/worker_threads.html) for appropriate
parallel work. The worker here isolates synchronous SQLite activity; shell builds
remain child processes.

### Fair CPU and process use

- Process execution now has both a global cap and a per-workspace cap. A build-heavy
  workspace cannot consume every command slot.
- The AiBox production launcher uses four global child-process slots, one per
  workspace, and retains at most 32 process sessions. These are admission limits,
  not limits on the threads spawned internally by Xcode, Gradle, or compilers.
- The launcher uses a 4 GiB V8 old-space ceiling by default and allows explicit
  configuration up to 8 GiB. Heap watermarks remain at 65% and 80%; raising the
  ceiling does not replace leak or queue controls.

### Avoid restart amplification

- A tunnel is not restarted merely because its local DevSpace upstream is slow or
  unavailable. Keeping the healthy tunnel process preserves its control-plane
  connection while DevSpace recovers.
- Health-only restarts are suppressed while one-minute host load per available CPU
  is high, and otherwise require five minutes of sustained failure. A real child
  exit is still restarted immediately with backoff.
- macOS runs the latency-sensitive gateway as LaunchAgent `ProcessType=Standard`,
  rather than opting into background throttling.

### Low-noise tracing

- Routine successful HTTP and tool-call logs are disabled in the production
  launcher. Slow requests, slow tools, failures, overload events, event-loop lag,
  resource snapshots, supervisor transitions, and tunnel poll failures remain.
- Workspace touch persistence is asynchronous. Log volume is bounded further by
  retaining only 1,000 tunnel admin-UI events.
- Diagnostics never need request bodies, file contents, shell command bodies, or
  credentials. Correlate DevSpace `requestId`, timestamps, supervisor events, and
  tunnel status instead.

## Production profile

The package defaults remain suitable for development and tests. The long-lived
AiBox launcher intentionally applies a tighter latency profile:

| Resource | Launcher value |
| --- | ---: |
| V8 old-space | 4096 MiB, configurable 1024-8192 MiB |
| MCP executing requests | 16 |
| MCP queued requests | 32 |
| tunnel requests dispatched to MCP | 8 per profile |
| tunnel control-plane buffered commands | 16 per profile |
| command processes | 4 global / 1 per workspace |
| retained process sessions | 32 |
| MCP sessions | 512 total / 384 idle |
| workspace sleep / MCP abandoned TTL | 4 h / 12 h |

These values favor interactive latency on a workstation that may also be running
Xcode or Gradle. Increase concurrency only after a soak test shows spare CPU and a
stable event-loop-lag distribution.

## Framework and protocol decisions

Do not replace Express based only on framework microbenchmarks. The observed stalls
were dominated by host load, synchronous persistence, session churn, and unconstrained
build concurrency. A framework migration adds compatibility risk without addressing
those causes.

The next protocol experiment should be the official MCP TypeScript SDK v2 HTTP
handler in a feature branch. If the client path does not require server-to-client
notifications or resumable streams, benchmark stateless Streamable HTTP because it
can avoid retaining one server/transport object for every reconnect. The
[Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
allows a server not to issue an MCP session ID. Preserve the existing stateful path
until ChatGPT, tunnel-client, tools, Apps resources, DELETE behavior, and older MCP
clients all pass the same contract suite.

Only benchmark Fastify or another HTTP adapter after extracting a transport-neutral
handler. Compare p50/p95/p99 latency, event-loop delay, RSS/heap, session churn, and
error rate under identical payloads. The decision threshold is a material measured
improvement, not requests-per-second marketing data.

## Remaining experiments

1. Add a local MCP canary that runs initialize, `tools/list`, `open_workspace`,
   `read`, and `exec_command`; export one concise result event.
2. Add a bounded asynchronous rotating file-log sink. Keep stderr as a fallback
   and verify that queue overflow drops low-priority success events before errors.
3. Run a 24-hour two-profile soak with reconnect churn and concurrent Xcode/Gradle
   load. Acceptance: no linear session/heap growth, no restart loop, stable p95,
   and no lost slow/error events.
4. Evaluate SDK v2 stateless mode behind a flag, then remove legacy state only after
   client compatibility is demonstrated.
5. Add histograms/counters suitable for local Prometheus scraping if the current
   structured logs prove insufficient. Do not expose diagnostics on a public bind.

## Verification

Every resource-control change must pass:

```bash
npm run typecheck
npm test
npm run build
```

Deployment validation additionally requires the built-in tunnel health command and
a real MCP tool sequence. A successful process launch or raw HTTP probe alone is not
release evidence.
