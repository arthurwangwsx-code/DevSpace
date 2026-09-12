# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_AUTH_MODE` | `oauth` (default), or `trusted-local` for an authenticated outbound tunnel while binding only to loopback. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## Resource Limits

DevSpace bounds live MCP sessions, request concurrency, queues, child processes,
and retained command output. Defaults are conservative for a single-user local
server and prevent reconnect-heavy clients from retaining sessions until the
Node heap is exhausted.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DEVSPACE_MCP_MAX_REQUEST_BYTES` | `16777216` | MCP JSON body limit: 16 MiB, configurable up to 64 MiB. Oversized calls receive JSON-RPC HTTP 413 before execution. |
| `DEVSPACE_WORKSPACE_MEMORY_IDLE_TIMEOUT_SECONDS` | `14400` | Evict workspace metadata after four idle hours while keeping its persistent `workspaceId` recoverable. |
| `DEVSPACE_MCP_MAX_SESSIONS` | `512` | Hard limit including active sessions and concurrent initialize reservations. |
| `DEVSPACE_MCP_MAX_IDLE_SESSIONS` | `384` | LRU bound for sessions without in-flight requests. |
| `DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS` | `43200` | Twelve-hour safety TTL for abandoned transports. Capacity and memory pressure can evict older idle sessions sooner. |
| `DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_SECONDS` | `30` | TTL and memory-pressure cleanup interval. |
| `DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS` | `64` | Maximum `/mcp` requests executing at once. |
| `DEVSPACE_MCP_MAX_QUEUED_REQUESTS` | `128` | FIFO waiting queue bound; `0` disables queuing. |
| `DEVSPACE_MCP_REQUEST_QUEUE_TIMEOUT_MS` | `30000` | Maximum time a request may wait for an execution slot. |
| `DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT` | `65` | Shrink the least-recently-used idle set after V8 heap use reaches this percentage. |
| `DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT` | `80` | Reject new initialize requests and close all idle sessions at this percentage. |
| `DEVSPACE_PROCESS_MAX_CONCURRENT` | `16` | Maximum concurrently running command processes. |
| `DEVSPACE_PROCESS_MAX_SESSIONS` | `64` | Maximum retained running and completed process sessions. |
| `DEVSPACE_PROCESS_BUFFER_CHARACTERS` | `524288` | Head/tail output buffer retained per process session. |

The idle session limit must not exceed the total session limit. The heap soft
percentage must be lower than the hard percentage, and the process session
limit must be at least the concurrent process limit. Overloaded MCP requests
return HTTP 503, JSON-RPC error `-32002`, and `Retry-After: 1`.
Before JSON parsing, a separate 128 MiB body-reservation budget admits at most
`min(MCP concurrency, floor(128 MiB / body limit))` simultaneous POSTs (8 by
default). It holds reservations until responses end and returns HTTP 503 with
`Retry-After: 2` when busy. This prevents large decoded requests accumulating
outside the existing execution gate. Compression is not accepted.

Text reads use bounded UTF-8 streaming: at most 1 MiB per page, default 20,000
lines. Continue using the returned `byteOffset`, omitting line `offset`; this
also works for very long lines and multi-GiB files without loading the whole file.
Line seeking has a 10-second scan budget; use byte seeking for distant offsets.
Images retain Pi processing with a 16 MiB input limit. In-memory edit/patch
targets are limited to 32 MiB each, and patch input plus original snapshots to
64 MiB per call. Larger transformations should use streaming commands.
These are local limits; a connector or tunnel may impose a smaller independent
limit. There is no safe universal "unlimited" setting or absolute OOM guarantee.

Workspace memory eviction is intentionally separate from MCP transport cleanup.
`release_workspace` and the workspace idle timeout only unload reconstructable
metadata. They do not delete a checkout/worktree, terminate a command, or
invalidate the `workspaceId`. A later workspace tool call restores that ID from
SQLite, and `open_workspace` in checkout mode resumes the latest session for the
same path unless `forceNew: true` is explicitly requested.

See [MCP Resource Control](mcp-resource-control.md) for lifecycle, memory-pressure,
and load-test details.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `release_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `release_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
