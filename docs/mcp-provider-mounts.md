# Mount external MCP servers as DevSpace capabilities

For the built-in current-profile Chrome preset, see
[`chrome-current-profile-provider.md`](./chrome-current-profile-provider.md).

DevSpace can keep one downstream MCP client per configured provider, discover its tools and
protocol assets, register them in the shared capability catalog, and expose them through both:

- `POST /capabilities/mcp` — a fixed eight-tool MCP interface.
- `/api/capabilities/v1` — a stable REST interface suitable for scripts and CI.

The existing workspace endpoint `/mcp` is unchanged. Enable this preview explicitly:

```bash
export DEVSPACE_CAPABILITIES=1
devspace serve
```

## Install a manifest

Create a JSON or YAML manifest, then validate and copy it into the protected provider directory:

```bash
devspace providers add-mcp --manifest /absolute/path/to/provider.json
```

The command does not overwrite an existing provider and reports `restartRequired: true` because the
local-file CLI deliberately does not mutate a running server. Provider
manifests default to `~/.devspace/capabilities`; override with
`DEVSPACE_CAPABILITY_CONFIG_DIR`. After installation, restart the shared DevSpace process and check:

```bash
devspace providers list --json
devspace capabilities list --provider example.remote.mcp --json
```

For install/update/load without a restart, use the fixed administrator REST endpoints
or invoke the catalog capabilities `devspace.providers.install`,
`devspace.providers.update`, `devspace.providers.control`, and `devspace.providers.remove` through
`capability_invoke`. See [Dynamic Provider management](dynamic-provider-management.md).

In OAuth mode, the CLI accepts an audience-bound token through
`DEVSPACE_CAPABILITY_BEARER_TOKEN`. In `trusted-local` mode it connects directly to the loopback API.

## Manifest contract

There are two registration modes:

- `discoverAllTools: true` automatically projects every downstream MCP tool into the Catalog. This is the
  recommended mode when the upstream Agent owns approval and needs a general MCP mount.
- `tools` provides explicit stable IDs and metadata for selected tools. It can be combined with
  `discoverAllTools`; explicit entries override the generated descriptor for those tool names.

Automatically discovered IDs use `<provider-id>.<normalized-tool-name>`. Name collisions receive a stable
eight-character hash suffix. Their default effects are `mutation + openWorld + non-idempotent`; these are
descriptive metadata rather than an approval gate in the default delegated mode. Generated descriptors use
`discoveredToolVersion` (default `1.0.0`). If an upstream upgrade changes a generated tool Schema, increment
that field before reload, or add an explicit mapping with its own version.

The smallest general-purpose manifest is therefore:

```json
{
  "apiVersion": "devspace.capabilities/v1",
  "kind": "McpProvider",
  "metadata": { "id": "example.remote.mcp", "title": "Example MCP" },
  "spec": {
    "enabled": true,
    "transport": {
      "type": "stdio",
      "command": "/absolute/path/to/example-mcp",
      "args": []
    },
    "discoverAllTools": true,
    "discoveredToolVersion": "1.0.0"
  }
}
```

Use explicit mappings when stable product-facing IDs or more precise effect/availability metadata are useful:

```json
{
  "apiVersion": "devspace.capabilities/v1",
  "kind": "McpProvider",
  "metadata": { "id": "example.remote.mcp", "title": "Example MCP" },
  "spec": {
    "enabled": true,
    "discoverAllTools": true,
    "transport": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/server.js"],
      "envFrom": { "API_TOKEN": "EXAMPLE_API_TOKEN" }
    },
    "tools": [
      {
        "tool": "lookup",
        "capabilityId": "example.remote.lookup",
        "title": "Lookup",
        "description": "Read a record from the configured example service.",
        "tags": ["example", "read"],
        "effects": {
          "readOnly": true,
          "destructive": false,
          "idempotent": true,
          "openWorld": true
        },
        "availability": {
          "requiresAwake": false,
          "requiresLoggedInSession": false,
          "requiresUnlocked": false,
          "requiresForegroundApp": false
        }
      }
    ]
  }
}
```

For Streamable HTTP, replace the transport with:

```json
{
  "type": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "headersFromEnv": { "Authorization": "EXAMPLE_AUTHORIZATION_HEADER" }
}
```

Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`. Stdio commands and working
directories must be absolute, no shell is involved, and only the SDK safe environment plus declared
`envFrom` entries reaches the child process. Secrets belong in environment variables, not manifests.

Capability input/output schema is learned from the downstream tool. A schema change with
an unchanged capability version is rejected, including after a DevSpace restart because the prior
catalog is persisted. Bump the manifest mapping's `version` only after reviewing the new contract.

When the downstream MCP advertises `resources` or `prompts` during initialization, DevSpace
automatically adds five provider-scoped dynamic capabilities without changing the fixed outer API:

- `<provider-id>.resources.list`
- `<provider-id>.resources.templates.list`
- `<provider-id>.resources.read`
- `<provider-id>.prompts.list`
- `<provider-id>.prompts.get`

These call the standard MCP methods and return their JSON-compatible protocol results. They are
read-only, open-world capabilities, use the same timeout/cancellation/output-limit/audit path as
tools, and disappear atomically with the Provider. Downstream instructions remain metadata only
and are never executed or treated as trusted instructions.

## Operational behavior

- All MCP, REST, and CLI callers share one supervised provider process/connection.
- Provider crashes use bounded exponential backoff; existing workspace `/mcp` remains available.
- Tool-list change notifications trigger catalog refresh.
- Invocation still passes through schema, queue, timeout, output-limit, cancellation, lease ownership,
  and redacted audit enforcement. Scope/Grant checks are opt-in with
  `DEVSPACE_CAPABILITY_ENFORCE_POLICY=1`; by default approval is delegated to the connected Agent.
- Downstream resources, resource templates, and prompts are projected automatically when the server
  advertises those protocol capabilities. Tools are all exported only when `discoverAllTools=true`;
  otherwise only explicit tool mappings appear. Server instructions are not re-exported as executable
  content or treated as trusted instructions.
- Admin API installation, enable/disable, reload, and recoverable removal update the running
  supervisor and Catalog revision atomically from the caller's perspective; the outer eight MCP tools stay fixed.

The capability feature remains off by default while Chrome and desktop providers complete their
real-machine permission, lock-screen, and soak matrices.

## Real package acceptance

After installing the official `chrome-devtools-mcp` package, exercise the
generic mount path without attaching to a browser:

```bash
npm run test:real-mcp-mount
```

The runner starts an isolated DevSpace, installs the real package dynamically
through the fixed MCP, verifies automatic tool discovery and search, performs
REST disable plus MCP enable/reload/remove, asserts that the outer MCP remains
exactly eight tools, and verifies that Provider-owned processes exit. Results
are written under `.build/real-mcp-mount/`. Set
`DEVSPACE_REAL_MCP_COMMAND=/absolute/path/to/another-compatible-server` to test
another executable that accepts the same diagnostic arguments.
