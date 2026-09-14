# DevSpace Product Capability Map

This is the canonical product-level inventory of DevSpace. Start here to answer “what can DevSpace do?” without reverse-engineering the source tree. Domain documents remain authoritative for protocol details and validation evidence.

## Product definition

DevSpace is a self-hosted local execution and capability gateway for MCP-capable AI clients. It gives a remote Agent controlled access to approved development workspaces and, through a fixed capability gateway, to browser, macOS desktop, and external MCP providers. Planning stays in the upper Agent; DevSpace owns local execution, resource identity, policy, lifecycle, diagnostics, and evidence.

The architecture has two deliberately separate surfaces: **workspace tools** are the small stable coding surface exposed directly to MCP clients; **capabilities** are a second-level catalog reached through a fixed capability control plane. Browser, desktop, device, app, or future domains must not add new first-level MCP tools.

## Capability inventory

| Area | What is implemented | Primary documentation |
| --- | --- | --- |
| Workspace lifecycle | Open/resume approved checkout workspaces; isolated Git worktrees; persistent `workspaceId`; release reconstructable in-memory state; instruction discovery | [Coding workflow](chatgpt-coding-workflow.md), [Security](security.md) |
| Files and code | Read, targeted edit/full write or Codex patching; grep/glob/list in full mode; bounded shell/command execution; long-running process sessions | [Coding workflow](chatgpt-coding-workflow.md), [Configuration](configuration.md) |
| Project context | Automatic `AGENTS.md` / `CLAUDE.md` discovery; project Skill discovery; optional workspace control-plane routing | [Coding workflow](chatgpt-coding-workflow.md), [Workspace control plane](workspace-control-plane.md) |
| Parallel development | Checkout reuse plus managed Git worktrees so Agents can work without forcing branch switches in another checkout | [Coding workflow](chatgpt-coding-workflow.md), [Security](security.md) |
| Local subagents | Profiles and resumable provider sessions for Codex, Claude, OpenCode, Pi, Cursor and Copilot/ACP when installed | [Agent profile schema](agent-profile-schema.md) |
| Review UX | Change/review checkpoints and MCP Apps-compatible tool/change cards | [Coding workflow](chatgpt-coding-workflow.md) |
| Capability runtime | Catalog, search, descriptors, leases, invocation lifecycle, cancellation, provider supervision, policy, audit/redaction, events, health and persistence | [Runtime design](capability-runtime-implementation-plan.md), [API principles](capability-api-principles.md) |
| Dynamic providers | Install/load/unload/remove external stdio or Streamable HTTP MCP servers without changing the first-level public API | [MCP mounts](mcp-provider-mounts.md), [Dynamic provider management](dynamic-provider-management.md) |
| Browser control | Current-profile Chrome control through extension/native bridge plus deep-debug provider: tabs, snapshots/HTML/screenshots, navigation, click/scroll/type/keys/wait, console/network/performance and bounded upload/download workflows | [Browser extension](browser-extension-architecture.md), [Current Chrome provider](chrome-current-profile-provider.md) |
| macOS Computer Use | Signed desktop Host; app/window discovery, AX semantic snapshots, exact-window capture, activate, semantic/coordinate click, focus, scroll, drag, type and bounded keys; PID/window/snapshot identity checks | [macOS desktop Host](macos-desktop-helper.md), [Computer Use assessment](computer-use-readiness-plan-2026-09-13.md) |
| Startup and permissions | DevSpace-owned LaunchAgent/watchdog, staged activation, release/source identity, permission doctor and explicit TCC request path | [macOS desktop Host](macos-desktop-helper.md) |
| Distribution and updates | Native App + embedded Node runtime, one-command bootstrap install, SHA-256 verified release manifest, transactional update/rollback/uninstall, GUI Updates page | [Distribution and Control Center](distribution-and-control-center.md) |
| Distribution and Control Center | Native SwiftUI macOS App with embedded Node runtime, first-run Setup Assistant, menu-bar controls, managed Tunnel ID/preset configuration, bundled Browser Bridge installation guidance, macOS permission guidance, login startup and release packaging | [Distribution and Control Center](distribution-and-control-center.md), [Native macOS onboarding](native-macos-onboarding-and-control-center.md) |
| Security | Allowed filesystem roots, OAuth/owner authentication, host/public URL controls, leases, lock-screen fail-closed desktop behavior, secure-field redaction, bounded inputs and audit redaction | [Security](security.md), [Capability grants](capability-grants.md) |
| Reliability | Request/session/process limits, backpressure, cancellation, provider recovery, bounded payloads, observability and release evidence | [Performance and reliability](performance-and-reliability.md), [MCP resource control](mcp-resource-control.md) |
| Verification | Unit/integration tests, MCP contract capture, browser/desktop real-provider fixtures, capability stress/soak and release gates | [Stress testing](stress-testing.md), [Capability stress](capability-stress-testing.md) |

## Public workspace tool modes

The exact schemas are captured in `test-fixtures/mcp-api-contract.json` and guarded by contract tests.

| Mode | First-level workspace tools |
| --- | --- |
| `minimal` | `open_workspace`, `release_workspace`, `read`, `edit`, `write`, `bash` |
| `codex` | `open_workspace`, `release_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin` |
| `full` | `open_workspace`, `release_workspace`, `read`, `edit`, `write`, `bash`, `grep`, `glob`, `ls` |

Production macOS service installation currently selects `codex` unless explicitly configured otherwise. These workspace tools are separate from the fixed Capability MCP control plane.

## Fixed Capability architecture

The product invariant is **fixed first-level API, extensible second-level capabilities**. Domain features are registered in the catalog and discovered progressively. The fixed control plane covers listing/searching and describing capabilities, opening a scoped lease/session, invoking work, observing status, cancelling work and closing the scope. Exact names and schemas are compatibility-tested in the runtime; see [Capability API Architecture Principles](capability-api-principles.md) and [Runtime design](capability-runtime-implementation-plan.md).

Do not add `browser_*`, `desktop_*`, `device_*`, or application-specific first-level MCP tools. A new domain belongs behind a Provider and second-level capability descriptors.

## Browser capability groups

The browser stack separates ordinary current-profile automation from deeper debugging. It can discover/create/own/release tabs, inspect page state, HTML and screenshots, navigate and interact with page content, wait for state, and expose debugging-oriented console/network/performance operations. File upload and download paths are bounded and approval-aware. User tabs, temporarily adopted tabs and Agent-created tabs have different ownership semantics so releasing a user tab does not silently close it.

The extension/native-host route is preferred for controlling the already logged-in Chrome profile. Deep debugging can use the Chrome DevTools provider. Provider fallback must remain explicit; browser failure must not silently become foreground desktop clicking.

## macOS desktop capability groups

The current desktop Host exposes 14 second-level operations documented individually in [macOS Desktop Helper](macos-desktop-helper.md): status, app/window discovery, semantic AX snapshot, app/window screenshot, activation, coordinate and semantic click, semantic focus, scroll, drag, text input and bounded key input. Resource leases are tied to the exact process; semantic handles are short-lived; stale process, window or snapshot identity fails closed.

The desktop boundary intentionally excludes whole-screen capture, arbitrary key chords, secure-field value reading, clipboard access, login-window control, Touch ID, FileVault bypass and Mac unlock. TCC permissions belong to the stable signed Host and are requested only through the explicit permission flow.

## Local Agent orchestration

DevSpace can delegate a scoped coding task to a configured local Agent provider while keeping the workspace as the execution boundary. Current adapters cover Codex, Claude, OpenCode, Pi, Cursor and Copilot/ACP. Profile metadata can select provider, model and thinking level; availability is discovered at runtime rather than assuming every provider exists. This is optional orchestration, not a replacement for direct workspace tools.

## Runtime, security and operational model

DevSpace is remote access to selected local machine capabilities, so security is part of the product model. Filesystem roots are allowlisted; authentication and public-host validation protect the MCP endpoint; leases bind operations to scoped resources; Provider supervision contains failures; audit/redaction prevents routine diagnostics from becoming a secret store; request, process and payload budgets bound resource use.

The macOS service has a repository-owned LaunchAgent/watchdog path and records installed/running release identity. Permission health, process health and feature availability are distinct states. A healthy HTTP process alone is not proof that browser or desktop automation is usable.

## Known boundaries and evidence status

Capability presence and production validation are different claims. The repository contains broad automated coverage and bounded stress tests, but real browser/desktop behavior also depends on Chrome state, macOS TCC, lock state and the installed/running release. Historical performance or soak receipts must not be presented as proof for a newer checkout.

For the latest evidence and unresolved validation work, use [Computer Use readiness](computer-use-readiness-plan-2026-09-13.md), [Performance and reliability](performance-and-reliability.md), and generated `.build/` receipts. The product intentionally fails closed at lock-screen/TCC boundaries rather than attempting to bypass them.

## Documentation map

Recommended reading order:

1. **This page** — product definition and complete capability map.
2. [Setup](setup.md) + [Configuration](configuration.md) — installation and knobs.
3. [Coding workflow](chatgpt-coding-workflow.md) — how an MCP Agent uses workspaces.
4. [Capability API principles](capability-api-principles.md) — the non-negotiable extension rule.
5. [Runtime design](capability-runtime-implementation-plan.md) — Provider/catalog/lease/invocation internals.
6. [Browser extension](browser-extension-architecture.md) and [Current Chrome provider](chrome-current-profile-provider.md) — browser architecture.
7. [macOS desktop Host](macos-desktop-helper.md) — Computer Use contract and permission boundary.
8. [Security](security.md) + [Performance and reliability](performance-and-reliability.md) — production boundaries.
9. Stress/fixture documents — evidence and release gates.

## Documentation maintenance rule

Any change that adds/removes a user-visible capability, Provider, local Agent adapter, first-level workspace tool, permission boundary, startup mechanism, or supported platform must update this page in the same change. Protocol-level changes must also update their domain document and contract/fixture. Test evidence belongs in the relevant verification document or generated receipt; do not rewrite aspirational plans as if they were validated runtime facts.
