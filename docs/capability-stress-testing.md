# Capability runtime performance and reliability testing

DevSpace has a separate capability stress harness because mounted MCP providers
add failure modes that the workspace-only `/mcp` runner cannot exercise. The
harness starts an isolated loopback DevSpace process and a real stdio MCP child,
uses only temporary state, runs in the production-default delegated-approval
mode without creating a DevSpace Grant, and removes the fixture after the run.
This also verifies that an upstream Agent does not encounter a second permission
workflow inside DevSpace.

It never connects to Chrome, macOS Accessibility, a public tunnel, production
provider manifests, or approved user workspaces.

## Commands

```bash
npm run stress:capabilities:smoke
npm run stress:capabilities:local
npm run stress:capabilities:soak

# Reproduce one dimension
npm run stress:capabilities -- \
  --profile local \
  --concurrency 24 \
  --operations 200 \
  --churn 500 \
  --capacity-requests 96
```

Use `--duration 30m`, `--think-time 100`, and `--cooldown 60s` for accelerated
soaks. `--keep-fixture` is diagnostic-only. Results are written as stable
`summary.json`, human-readable `summary.md`, and bounded `server-output.log`
under `artifacts/capability-stress/<timestamp>/`. Setup failures write
`failure.json` as well.

| Profile | Clients | Calls/client | MCP session churn | Duration |
| --- | ---: | ---: | ---: | ---: |
| `smoke` | 4 | 20 | 16 | bounded |
| `local` | 16 | 100 | 256 | bounded |
| `soak` | 8 | duration-based | 5,000 | 24 h + 60 s cooldown |

Normal calls run below the configured 2-active/64-queued provider envelope.
The separate capacity phase sends 80 requests in `smoke` and 128 in
`local`/`soak`, so explicit overload behavior is still exercised without
polluting ordinary latency and success metrics.
The fixture also lowers the in-memory invocation-history ceiling to 2,000 so a
medium or soak run must cross and verify the eviction boundary; production keeps
the configurable 10,000-entry default.

## What the harness proves

The normal workload alternates REST and fixed-MCP invocation calls while also
checking list, search, describe, catalog revision consistency, the exact
eight-tool MCP surface, and repeated stateless MCP initialization/closure.

Every run then executes controlled fault cases:

- the router admits work up to its per-provider/global limits and returns only
  explicit `rate_limited` errors beyond the queue;
- the accepted queue drains and a following invocation succeeds;
- async cancellation reaches `cancelled`;
- timeout and oversized output become stable public error codes, while a
  secure-field-shaped argument reaches the Provider in delegated-approval mode
  without being copied into the report or audit log;
- an idempotency key returns the same invocation;
- the downstream stdio MCP exits with a non-zero code once, the supervisor enters
  a non-ready state, restarts it after backoff, and a subsequent call succeeds;
- runtime counters end at zero active and zero queued invocations;
- completed invocation state and its idempotency index are retained for at most
  24 hours and 10,000 in-memory entries by default;
- process-tree RSS, descendant count, file descriptors, and listening sockets
  include both DevSpace and its provider; after graceful server shutdown no
  descendant provider process remains. FD/socket data is reported when `lsof`
  is available.

Latency histograms report min/mean/p50/p95/p99/max for REST discovery, REST
invocation, fixed MCP invocation, MCP initialization, tool listing, and runtime
status. Smoke/local gates are discovery p95 below 100 ms, invocation p95 below
150 ms, process-tree RSS below 1 GiB, zero unexpected failures, and all correctness
checks passing.

Runs of ten minutes or longer additionally gate post-warm-up process-tree RSS
growth below 64 MiB and fitted RSS slope below 32 MiB/hour. When `lsof` is
available, they also gate file-descriptor growth below 64 descriptors; an
unavailable measurement is reported as unavailable instead of becoming false
pass evidence. Short-run slopes are not release evidence because
JIT, SQLite, native buffers, and garbage collection
dominate a few seconds of samples. The 24-hour profile remains the release memory
gate; running the framework does not imply that this duration has been completed.

### 2026-09-13 bounded baselines

The final smoke profile completed 80/80 normal calls with a 33 ms worst-interface
p95; its 80-call burst accepted 66 and explicitly rate-limited 14, all fault cases
were normalized, process-tree RSS peaked at 338.59 MiB, and the pre-shutdown
Provider PID was confirmed absent after shutdown. No child process was left
behind. The local profile completed 1,600/1,600 calls and 256 MCP reconnects
with a 41 ms p95; its 128-call
burst accepted 66 and explicitly rate-limited 62, with zero other failures.

A one-minute accelerated soak completed 4,283/4,283 calls and 200 reconnects at
19 ms REST / 22 ms MCP p95. RSS peaked at 590.69 MiB, FD count changed from 55 to
56, one listening socket remained stable, provider recovery took 1.36 seconds,
and shutdown left no descendant. A follow-up 3,200-call run used the 2,000-entry
fixture history ceiling and ended at exactly 2,000 tracked records, proving the
eviction path instead of merely checking its configuration. These bounded runs
do not replace the 24-hour release gate.

The formal ten-minute soak completed 42,913/42,913 business calls and 5,000 MCP
session reconnects with 23 ms REST / 27 ms MCP p95. All 26 gates passed: the
2,000-entry history bound held, the 128-call burst produced 66 accepted and 62
explicitly rate-limited calls, Provider recovery took 1.52 seconds, process-tree
RSS peaked at 611.19 MiB, FD count ended 55 to 54 with one listener, and shutdown
left no Provider process. Post-warm-up RSS growth and fitted slope were both
negative. Artifact: `.build/capability-stress-soak-10m-final/2026-09-13T03-59-43-839Z`.
The 24-hour release run remains outstanding.

After switching the production default to delegated approval, a final local
profile ran without creating any Grant: 1,600/1,600 business calls, 256 MCP
session reconnects, REST/MCP invocation p95 of 38 ms, all 23 gates passed,
66 accepted plus 62 explicit rate-limited burst calls, peak process-tree RSS
626.86 MiB, and no orphan Provider. Artifact:
`.build/capability-stress-local-final-v2/2026-09-13T04-38-38-245Z`.

## Real-provider matrix

The isolated fixture establishes runtime and bridge behavior, but it cannot prove
Chrome/TCC/session behavior. Run real providers separately and keep evidence
distinct:

| Provider | Safe fixture | User-controlled gates | Required evidence |
| --- | --- | --- | --- |
| Current Chrome | local static page only | approve Chrome remote debugging; manually unlock after lock test | list, lease, snapshot, screenshot, mutation, child/Chrome restart, lock matrix |
| macOS desktop | bundled fixture app | grant Accessibility/Screen Recording to stable signed helper; manually unlock | AX snapshot, normal/secure-field input, secure-value redaction, screenshot, helper restart, lock matrix |

Never run mutation load against a real account or production page. A real-provider
soak must use a dedicated profile/config, explicit target constraints, a local
fixture, and a human-agreed lock/unlock window.
