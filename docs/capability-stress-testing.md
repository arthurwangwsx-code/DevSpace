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
npm run test:real-mcp-mount
npm run test:desktop-provider-performance
npm run test:desktop-runtime-fixture
npm run test:capability-release -- --lane locked
npm run verify:capability-release -- \
  --locked /path/to/locked/summary.json \
  --unlocked /path/to/unlocked/summary.json \
  --browser-transition /path/to/browser-transition/summary.json \
  --soak /path/to/24h-soak/summary.json

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

`test:real-mcp-mount` is dependency-sensitive rather than deterministic: it
uses the locally installed official `chrome-devtools-mcp`, points it at an
intentionally unreachable loopback browser endpoint so no user page is touched,
and validates the real package's dynamic install/discover/search/reload/remove
process lifecycle. Its receipts are stored under `.build/real-mcp-mount/`.

`test:desktop-runtime-fixture` is deliberately separate from the direct Helper
canary. It drives the deployed REST → Runtime → mounted Provider → signed Host path,
including a real fixture-app process restart and old-lease rejection. It requires an
unlocked session plus Accessibility and Screen Recording permission for the installed
Host, and writes receipts under `.build/desktop-runtime-fixture/`.

## Release lanes

`test:capability-release` is the top-level evidence orchestrator. It runs each gate
as a direct child process, stores console output in a per-gate log, records
the exact Git commit, all dirty paths, and the runtime-source dirty subset, stops
on the first failure by default, and
writes a JSON/Markdown lane receipt under `.build/capability-release/`.

- `core`: typecheck, full unit/integration suite, production build, isolated
  capability stress smoke, and a real external `chrome-devtools-mcp` mount.
- `locked`: all core gates plus the fail-closed desktop lock boundary and live
  production Provider reload/continuous-catalog canary.
- `unlocked`: production service/TCC preflights, all core gates, the current-profile
  local browser fixture, a separate HTTPS open-world read-only snapshot, the direct
  Helper fixture, the deployed production desktop fixture (including stale-process
  lease rejection), and the production Provider canary.
- `browser-transition`: starts unlocked and runs the live extension baseline →
  locked continuation → unlocked recovery matrix through the production REST API.

Use `--list` to inspect a lane without running it, `--only gate1,gate2` for a
targeted rerun (recorded as `releaseEligible: false` even when it passes), and
`--continue-on-failure` when collecting a complete failure
inventory. A release requires passing receipts from `locked`, `unlocked`,
`browser-transition`, and the separate 24-hour capability soak. The orchestrator
never treats a skipped lane, runtime-source dirty run, or precondition failure as
release eligible. Unrelated documentation WIP remains recorded but does not invalidate
the executable-source evidence.

`verify:capability-release` is the final evidence-set gate. It requires explicit paths
for all three lane receipts plus the 24-hour soak, validates every required sub-gate,
checks that lane runtime implementations match current `HEAD`, enforces persistence,
memory/slope and orphan-process soak gates, and rejects current runtime-source WIP.
Legacy soak reports without the source-provenance gate require the explicit
`--accept-legacy-soak` waiver, which is preserved in the final receipt rather than
silently treated as equivalent evidence.

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

The final formal ten-minute delegated-approval soak completed 43,025/43,025
business calls and 5,000 MCP session reconnects with 2 ms discovery / 23 ms
invocation p95. All 26 gates passed: the 2,000-entry history bound held, the
128-call burst produced 66 accepted and 62 explicitly rate-limited calls,
Provider recovery took 1.57 seconds, process-tree RSS peaked at 603.84 MiB, FD
count ended 55 to 54 with one listener, and shutdown left no Provider process.
Post-warm-up RSS growth and fitted slope were both negative. Artifact:
`.build/capability-stress-soak-10m-delegated-final/2026-09-13T04-40-54-345Z`.
The first 24-hour release attempt exposed an unbounded persistent-history gap:
after about 1 hour 30 minutes it had 362,341 invocation rows, 724,682 audit
events, and a 566 MiB fixture database despite the 2,000-entry in-memory limit.
It was stopped rather than allowing a projected multi-gigabyte test artifact to
grow for the sake of elapsed time. Commit `ba9bab5` applies the same count and
retention limits to SQLite, preserves active invocations, and adds persistent
row-count and disk-size release gates. A replacement run started from that
commit under `.build/capability-stress-soak-24h-bounded-final`; it is not a
passing release gate until its final receipt and cooldown checks complete.

After switching the production default to delegated approval, a final local
profile ran without creating any Grant: 1,600/1,600 business calls, 256 MCP
session reconnects, REST/MCP invocation p95 of 38 ms, all 23 gates passed,
66 accepted plus 62 explicit rate-limited burst calls, peak process-tree RSS
626.86 MiB, and no orphan Provider. Artifact:
`.build/capability-stress-local-final-v2/2026-09-13T04-38-38-245Z`.

After canonical `browser.control` routing and the fixed eight-tool contract were
landed, a fresh smoke completed 80/80 calls with 2 ms discovery and 27 ms
invocation p95. All 23 gates passed, including overload normalization,
idempotency, cancellation, timeout, output limit, Provider crash/recovery and
shutdown cleanup; process-tree RSS peaked at 340.13 MiB and no Provider child
survived shutdown. Artifact:
`.build/capability-stress-browser-control-final/2026-09-13T07-45-27-624Z`.

The persistent-bound crossing run completed 2,400/2,400 calls and ended with
exactly 2,000 invocation rows, 4,949 audit events, and 3.62 MiB of SQLite state.
All 26 gates passed, including 36 ms invocation p95 and zero orphan Providers.
Artifact:
`.build/capability-stress-persistent-bounds-crossing/2026-09-13T07-57-14-542Z`.

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

Current Chrome has a bounded real-provider runner:

```bash
npm run test:current-chrome -- --phase unlocked-baseline --fixture-url http://127.0.0.1:19080/
npm run test:current-chrome -- --phase locked-continuation --fixture-url http://127.0.0.1:19080/
npm run test:current-chrome -- --phase unlocked-recovery --fixture-url http://127.0.0.1:19080/
```

It fails before browser invocation when the requested phase does not match the actual macOS lock state.
Only the loopback fixture origin and bounded measurements enter its reports.

The extension path has a stricter single-process transition runner:

```bash
npm run test:browser-extension
```

Start it while macOS is unlocked, then follow its lock and unlock prompts. It
keeps the same extension connection, local fixture, Agent-owned tab and lease
across the unlocked baseline, locked continuation and unlocked recovery phases.
This distinguishes genuine lock continuation from a fresh connection made in
each phase. Unit coverage also verifies bridge fragmentation/disconnect/output
bounds, adopted-versus-Agent tab cleanup, native-messaging framing and a 2 MiB
response relay.

The production desktop Provider also has a non-mutating performance canary:

```bash
npm run test:desktop-provider-performance -- \
  --rest-samples 50 \
  --mcp-samples 25 \
  --reload-provider
```

It is safe to run while locked because it invokes only `desktop.macos.status`.
It verifies the exact eight-tool outer MCP contract, exact eight-capability desktop
catalog, REST and MCP invocation paths, stable Provider PID, permission-health
consistency, local latency gates, bounded RSS growth, and—when explicitly requested—
dynamic reload with continuous Descriptor probes, old-child exit, and new-child recovery.
Any `capability_not_found` gap during reload fails the run. JSON and Markdown receipts
are written under `.build/desktop-provider-performance/`. Passing this canary proves
the deployed control path and status performance; it does not replace unlocked AX,
screenshot, input, restart, or lock-transition fixtures.
