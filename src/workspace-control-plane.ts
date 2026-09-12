import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPathInsideRoot } from "./roots.js";

export async function resolveWorkspaceControlPlaneRoot(root: string): Promise<string> {
  const candidate = join(root, "_workspace");
  const marker = join(candidate, ".devspace", "control-plane.json");

  try {
    const [resolvedRoot, resolvedCandidate, resolvedMarker] = await Promise.all([
      realpath(root),
      realpath(candidate),
      realpath(marker),
    ]);
    if (!isPathInsideRoot(resolvedCandidate, resolvedRoot)) return root;
    if (!isPathInsideRoot(resolvedMarker, resolvedCandidate)) return root;

    const [candidateStats, markerStats] = await Promise.all([stat(resolvedCandidate), stat(resolvedMarker)]);
    if (!candidateStats.isDirectory() || !markerStats.isFile()) return root;

    const parsed = JSON.parse(await readFile(resolvedMarker, "utf8")) as {
      schema_version?: unknown;
      route_parent?: unknown;
    };
    if (parsed.schema_version !== 1 || parsed.route_parent !== true) return root;

    return candidate;
  } catch {
    return root;
  }
}
