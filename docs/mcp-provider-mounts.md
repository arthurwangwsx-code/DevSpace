# Mount external MCP servers as DevSpace capabilities

For the built-in current-profile Chrome preset, see
[`chrome-current-profile-provider.md`](./chrome-current-profile-provider.md).

DevSpace can keep one downstream MCP client per configured provider, discover its allowlisted tools,
register them in the shared capability catalog, and expose them through both:

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

The command does not overwrite an existing provider and reports `restartRequired: true`. Provider
manifests default to `~/.devspace/capabilities`; override with
`DEVSPACE_CAPABILITY_CONFIG_DIR`. After installation, restart the shared DevSpace process and check:

```bash
devspace providers list --json
devspace capabilities list --provider example.remote.mcp --json
```

In OAuth mode, the CLI accepts an audience-bound token through
`DEVSPACE_CAPABILITY_BEARER_TOKEN`. In `trusted-local` mode it connects directly to the loopback API.

## Manifest contract

Every downstream tool is denied unless explicitly mapped. Effects and availability are declared by
the local manifest; untrusted downstream tool annotations cannot reduce them.

```json
{
  "apiVersion": "devspace.capabilities/v1",
  "kind": "McpProvider",
  "metadata": { "id": "example.remote.mcp", "title": "Example MCP" },
  "spec": {
    "enabled": true,
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

Capability input/output schema is learned from the allowlisted downstream tool. A schema change with
an unchanged capability version is rejected, including after a DevSpace restart because the prior
catalog is persisted. Bump the manifest mapping's `version` only after reviewing the new contract.

## Operational behavior

- All MCP, REST, and CLI callers share one supervised provider process/connection.
- Provider crashes use bounded exponential backoff; existing workspace `/mcp` remains available.
- Tool-list change notifications trigger catalog refresh.
- Invocation still passes through DevSpace scope, grant, schema, queue, timeout, output-limit,
  cancellation, lease, and redacted audit enforcement.
- A downstream MCP's prompts, resources, instructions, and non-allowlisted tools are not re-exported.

The capability feature remains off by default while Chrome and desktop providers complete their
real-machine permission, lock-screen, and soak matrices.
