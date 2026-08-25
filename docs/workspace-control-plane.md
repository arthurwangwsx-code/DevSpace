# Workspace Control-Plane Routing

DevSpace can route an attempted checkout open of a large multi-project parent directory
into an explicit `_workspace` control plane. This avoids recursively discovering every
project, instruction file, and Skill before the AI has selected a target repository.

## Opt-in marker

The parent is routed only when this file exists:

```text
<parent>/_workspace/.devspace/control-plane.json
```

with exactly the supported contract:

```json
{
  "schema_version": 1,
  "route_parent": true
}
```

Malformed JSON, an unsupported schema, `route_parent: false`, a missing marker, or a
control-plane symlink that resolves outside the requested parent all disable routing.

## Behavior

Given:

```text
/projects
├── _workspace/
│   ├── .devspace/control-plane.json
│   ├── AGENTS.md
│   └── .agents/skills/...
├── app-a/
└── app-b/
```

calling `open_workspace("/projects")` opens `/projects/_workspace` as the actual
checkout workspace. The normal DevSpace instruction and Skill loading then runs only
inside that control plane. The control plane is responsible for selecting the target
project, after which the MCP client opens that project as its own workspace.

Directly opening `/projects/app-a` is unchanged. Worktree mode is unchanged and never
applies parent control-plane routing.

## Security boundary

Routing is a convenience inside an already allowed root, not a new filesystem grant.
DevSpace resolves the parent, candidate control plane, and marker through the real
filesystem and refuses the route if the candidate or marker escapes the requested
parent through symlinks.
