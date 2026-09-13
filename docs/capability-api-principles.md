# Capability API Architecture Principles

## P0: the first-level MCP contract is fixed

DevSpace exposes exactly eight first-level tools on the Capability MCP server:

```text
capability_list
capability_search
capability_describe
capability_open
capability_invoke
capability_status
capability_cancel
capability_close
```

This list is a project-level compatibility boundary. Browser, device, desktop,
application, network, automation, and future domains MUST NOT add first-level
MCP tools. Domain growth happens only in the second-level Capability Registry.

Examples of forbidden design drift:

```text
browser_click          # forbidden first-level MCP tool
device_install_app     # forbidden first-level MCP tool
desktop_screenshot     # forbidden first-level MCP tool
```

Equivalent functionality belongs in canonical second-level capabilities:

```text
browser.page.click
device.app.install
desktop.screen.capture
```

and is reached through `capability_search`, `capability_describe`,
`capability_open`, and `capability_invoke`.

## Progressive disclosure

The model-facing discovery sequence is intentionally bounded:

1. The MCP client sees only the fixed eight tools.
2. `capability_search` finds a small set of second-level capability summaries.
3. `capability_describe` expands only the selected capability's schemas,
   effects, permissions, lease requirements, and metadata.
4. `capability_open` binds a resource when stateful ownership is required.
5. `capability_invoke` executes the selected capability through policy, queue,
   timeout, audit, and lease enforcement.

`capability_list` is for structured enumeration and diagnostics; agents should
prefer search-first discovery rather than loading the full catalog into context.

## Canonical capability naming

Public capability IDs describe intent, not transport or implementation:

```text
<domain>.<resource>.<action>
```

Good:

```text
browser.profile.list
browser.tab.open
browser.page.snapshot
browser.page.click
browser.debug.network
browser.file.upload
```

Avoid public IDs that leak a provider/backend:

```text
browser.extension.click
browser.chrome.cdp.network
browser.playwright.snapshot
```

Browser type, profile, tab, device, provider, and transport are resource
identity or routing metadata, not reasons to multiply the public API surface.

## Provider isolation

Providers may have broad technical authority internally, but they MUST expose
bounded, typed capabilities rather than generic escape hatches. In particular,
do not expose arbitrary CDP method execution, arbitrary shell commands, or an
untyped `method + params` transport as a public capability merely because the
backend supports it.

The Capability layer remains the enforcement point for schema validation,
effects, permissions, leases, audit, timeout, concurrency, and redaction.

Backend-only capabilities may use the `internal-backend` tag. Default
`capability_list` and `capability_search` suppress that tag so implementation
details such as legacy Chrome DevTools mappings do not compete with canonical
domain APIs. Explicit provider/tag filters may still reveal them for admin,
diagnostic, migration, and compatibility work.

## Compatibility enforcement

`src/capabilities/mcp-adapter.test.ts` asserts the exact eight-tool MCP surface.
Any intentional change to the first-level contract therefore requires an
explicit architecture decision and a corresponding update to this document,
the project instructions, the constant, and its contract test.
