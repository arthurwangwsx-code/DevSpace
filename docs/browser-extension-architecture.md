# Browser Extension Provider

## Goal

DevSpace should drive the user's already-running Chrome profile without making
Chrome remote debugging a prerequisite. Normal page automation uses a Chrome
extension attached to explicit tabs; the existing Chrome DevTools provider is
retained for deep debugging such as console/network/performance inspection.

The public capability contract remains provider-independent. Agents acquire a
`browser_page` lease and call stable DevSpace capabilities instead of receiving
an arbitrary CDP session.

## Repository decision

Keep the extension and native host in this repository while the bridge protocol
is evolving:

```text
devspace/
  browser-extension/       Manifest V3 Chrome extension
  native-host/             Chrome native-messaging bridge
  src/capabilities/        provider/runtime integration
```

They build independently but share one repository and protocol version. Split a
separate repository only when the bridge becomes a reusable product with an
independent release cadence (for example AiBox/Device MCP also consume it).

## Architecture

```text
MCP client
   |
DevSpace capability runtime
   |
BrowserExtensionProvider
   |
local Unix socket (~/.devspace/browser-extension.sock)
   |
native messaging host (Chrome-owned process)
   |
Chrome extension (nativeMessaging + tabs + debugger)
   |
explicit Chrome tab in the extension's current profile
```

The native host is deliberately a transport bridge. Authorization, leases,
provider selection and stable capability semantics stay in DevSpace. The
extension does not expose a generic `sendCommand(method, params)` capability.

## Ownership model

Tabs have explicit ownership:

- `user`: existing user tab, not controlled by an agent.
- `adopted`: an existing user tab temporarily acquired by a DevSpace lease.
- `agent`: a tab created for an agent. It may be cleaned up by that agent.

Closing an adopted tab means releasing it, never deleting the user's tab. The
extension attaches `chrome.debugger` only after a tab is acquired and detaches
on release/lease close.

## Protocol v1

Messages are request/reply JSON envelopes. Native Messaging framing terminates
at the native host; the DevSpace socket uses newline-delimited JSON.

```json
{"protocol":1,"id":"...","command":"list_tabs","params":{"clientId":"...","all":true}}
{"protocol":1,"id":"...","ok":true,"result":{}}
```

Initial commands are `hello`, `list_tabs`, `use_tab`, `release_tab`, `close_tab`,
`open_tab`, `snapshot`, `navigate`, `click`, `type`, `press`, and `screenshot`.
Every page command except discovery requires ownership by the requesting
`clientId`. Native-messaging direction limits are enforced separately:
DevSpace-to-extension messages are capped at 1 MiB and extension-to-DevSpace
responses at 64 MiB, so screenshots use Chrome's larger response allowance.

## Provider routing

Extension-first is the target behavior for ordinary browser work:

```text
snapshot / navigate / click / type / key -> extension provider
console / network / performance          -> Chrome DevTools provider
browser/system chrome UI                 -> desktop/computer-use provider
```

The first implementation registers the extension as
`browser.chrome.extension` with `browser.extension.*` capability IDs so it can
be validated alongside the existing provider without creating duplicate public
IDs. A later router migration aliases ordinary `browser.chrome.*` calls to the
extension after real-browser validation is complete.

During phase 1 the provider is opt-in with `DEVSPACE_BROWSER_EXTENSION=1`, so a
machine that has not installed the extension/native host remains healthy and
the existing DevTools provider behavior is unchanged.

## Development installation on macOS

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select this repository's `browser-extension/` directory.
2. Copy the 32-character extension ID shown by Chrome, then run
   `node native-host/install.mjs <extension-id>`.
3. Start DevSpace with `DEVSPACE_BROWSER_EXTENSION=1`. Reload the extension or
   wait for its one-minute reconnect alarm, then query provider health and the
   capability catalog.

The installer copies the bridge into Application Support and creates a launcher
pinned to the absolute Node executable used at install time. This matters
because GUI-launched Chrome does not normally inherit an nvm-managed shell
`PATH`. Re-run the installer after changing the Node installation used by
DevSpace.

No DevSpace Grant or per-operation approval is used in the default
delegated-approval mode. Installing the extension and Chrome's `debugger`
attachment indication are browser-level behavior; the upstream Agent owns any
approval workflow. The extension does not try to bypass Chrome or macOS
security controls.

After installation, run the real lock-transition acceptance while initially
unlocked:

```bash
npm run test:browser-extension
```

The runner creates only a loopback fixture and an inactive Agent-owned tab. It
keeps one Provider connection and one page lease across all three phases,
prompts for manual lock and unlock, validates snapshot/screenshot/click/type/key
operations, and closes the Agent tab at the end. It refuses to start when the
Mac is already locked or another process owns the bridge socket, and writes a
redacted JSON/Markdown receipt under `.build/browser-extension-matrix/`.

## Security boundaries

- No arbitrary CDP passthrough.
- Native host manifest pins `allowed_origins` to the installed extension ID.
- Socket defaults to `~/.devspace/browser-extension.sock` and is user-only.
- Page operations require a server-side lease and tab ownership.
- Existing user tabs are never closed by cleanup.
- Releasing an adopted lease leaves the tab open; releasing an agent-created
  tab closes only that agent-created tab.
- The bridge does not persist cookies, page contents, passwords or CDP sessions.

## Delivery phases

1. **Bridge foundation**: protocol, native host, extension, provider and unit
   tests. Keep existing DevTools behavior unchanged.
2. **Real Chrome validation**: install unpacked extension/native host, turn off
   remote debugging, verify list/adopt/snapshot/click/type/navigation/release on
   the user's normal profile without stealing focus.
3. **Extension-first routing**: introduce browser routing/profile registry and
   make normal `browser.chrome.*` operations prefer the extension.
4. **Product hardening**: profile selection, install/doctor CLI, reconnect,
   packaged extension, Edge/Chromium compatibility and soak tests.

## Acceptance criteria

- Remote debugging is disabled and normal page automation still works.
- Existing logged-in browser state is reused; no cookie export is required.
- Current-profile tabs can be enumerated and an explicit tab adopted.
- Adoption does not activate/reload the tab.
- Snapshot, navigate, click, type and key operations work on an acquired tab.
- Releasing an adopted tab detaches the debugger and leaves the tab open.
- Agent-created tabs and user/adopted tabs have different cleanup semantics.
- Existing Chrome DevTools provider remains available for deep debugging.
