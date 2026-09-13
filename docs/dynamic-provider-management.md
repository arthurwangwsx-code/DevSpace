# Dynamic MCP Provider management

DevSpace can install, load, disable, reload, and remove downstream MCP Providers
without restarting the DevSpace process. The public capability MCP still exposes
exactly eight fixed meta-tools. Provider administration appears as ordinary
dynamic capabilities in the catalog, so adding another downstream MCP changes
catalog data and its revision, not the outer MCP tool contract.

Dynamic administration is enabled whenever `DEVSPACE_CAPABILITIES=1`. Set
`DEVSPACE_CAPABILITY_ADMIN_API=0` to disable it independently. In OAuth mode the
caller only needs to be authenticated; trusted-local mode trusts the loopback
caller. There is no per-capability Grant or additional per-executable, origin,
environment-variable, secure-field, or per-operation approval layer: the
upstream Agent is responsible for its own approval workflow. An operator that
needs the earlier fail-closed policy can explicitly set
`DEVSPACE_CAPABILITY_ENFORCE_POLICY=1`; only that opt-in mode requires the
corresponding invoke/admin scopes and Grants.

## Fixed REST control plane

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/capabilities/v1/admin/providers` | List configured manifests and live health. |
| `POST` | `/api/capabilities/v1/admin/providers` | Validate, persist, start, discover, and register one Provider. |
| `POST` | `/api/capabilities/v1/admin/providers/:id/actions` | Run `enable`, `disable`, or `reload` immediately. |
| `DELETE` | `/api/capabilities/v1/admin/providers/:id` | Stop, unregister, retire its catalog entries, and archive its manifest. |

Install a stdio MCP that already has a local launcher:

```bash
curl -X POST http://127.0.0.1:7676/api/capabilities/v1/admin/providers \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $DEVSPACE_CAPABILITY_BEARER_TOKEN" \
  --data '{
    "manifest": {
      "apiVersion": "devspace.capabilities/v1",
      "kind": "McpProvider",
      "metadata": { "id": "example.dynamic.mcp", "title": "Example MCP" },
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
  }'
```

The same manifest can point to an absolute `npx` or other package launcher if
the upstream administrator wants package download/start behavior. DevSpace uses
direct process spawning rather than an implicit shell, but the configured
executable and arguments have that user's authority. Provider processes receive
the MCP SDK's safe base environment plus only the environment names declared in
`envFrom`; HTTP headers use `headersFromEnv`.

The response is returned only after the Provider has entered its initial health
state and discovery has updated the catalog. A successful ready Provider can be
found immediately through `GET /capabilities`, `capability_list`, or
`capability_search`. Clients should use the returned `catalogRevision` to
invalidate cached catalog data.

## Management through the fixed MCP

The built-in `devspace.providers.admin` Provider publishes these catalog entries:

- `devspace.providers.list`
- `devspace.providers.install`
- `devspace.providers.control`
- `devspace.providers.remove`

An MCP client discovers them with `capability_search` and executes them with the
existing `capability_invoke` meta-tool. In the default delegated-approval mode
they require no DevSpace Grant or admin scope beyond an authenticated capability
connection. Enforced-policy mode requires `capabilities:admin`.

Conceptually:

```json
{
  "name": "capability_invoke",
  "arguments": {
    "capabilityId": "devspace.providers.control",
    "arguments": {
      "providerId": "example.dynamic.mcp",
      "action": "reload"
    }
  }
}
```

`reload` constructs a new downstream client from the persisted manifest, stops
the old child/connection, swaps the registration, rediscovers its tools, and
increments the catalog revision. With `discoverAllTools=true`, downstream tool-list
notifications also refresh generated descriptors without changing the fixed eight
meta-tools.

If the downstream server advertises MCP `resources` or `prompts`, the same Provider
also registers provider-scoped list/read/templates/get capabilities automatically.
They are discovered and invoked through the existing fixed meta-tools; no new outer
REST route or MCP tool is introduced. Server instructions are retained only as
untrusted connection metadata and never become executable Agent instructions.

## Persistence and removal

Provider manifests are stored as current-user-owned regular files with mode
`0600`; symlink manifests and group/world-readable manifests fail closed.
Lifecycle updates use an atomic file replacement. `remove` is recoverable: the
manifest moves into `DEVSPACE_CAPABILITY_CONFIG_DIR/.removed/`; if runtime
removal fails it is restored, otherwise the Provider is stopped and its live
catalog entries are retired.

Because the upper Agent owns approval, the management identity is powerful: a
stdio manifest can execute the specified local program, an `npx` launcher can
download packages, and an HTTP Provider can communicate with the configured
remote origin. Keep the capability endpoint authenticated and connect only an
approval-aware Agent. If enforced-policy mode is enabled, issue
`capabilities:admin` only to that Agent.
