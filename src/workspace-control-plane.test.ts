import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceControlPlaneRoot } from "./workspace-control-plane.js";

const root = await mkdtemp(join(tmpdir(), "devspace-control-plane-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-control-plane-outside-test-"));

try {
  const portfolioRoot = join(root, "portfolio");
  const controlPlaneRoot = join(portfolioRoot, "_workspace");
  await mkdir(join(controlPlaneRoot, ".devspace"), { recursive: true });
  await mkdir(join(portfolioRoot, "project-a"), { recursive: true });
  await writeFile(join(controlPlaneRoot, "AGENTS.md"), "control plane instructions\n");
  await writeFile(join(portfolioRoot, "project-a", "AGENTS.md"), "project instructions\n");
  await writeFile(
    join(controlPlaneRoot, ".devspace", "control-plane.json"),
    JSON.stringify({ schema_version: 1, route_parent: true }),
  );

  assert.equal(await resolveWorkspaceControlPlaneRoot(portfolioRoot), controlPlaneRoot);

  await writeFile(
    join(controlPlaneRoot, ".devspace", "control-plane.json"),
    JSON.stringify({ schema_version: 1, route_parent: false }),
  );
  assert.equal(await resolveWorkspaceControlPlaneRoot(portfolioRoot), portfolioRoot);

  await writeFile(
    join(controlPlaneRoot, ".devspace", "control-plane.json"),
    JSON.stringify({ schema_version: 2, route_parent: true }),
  );
  assert.equal(await resolveWorkspaceControlPlaneRoot(portfolioRoot), portfolioRoot);

  await writeFile(join(controlPlaneRoot, ".devspace", "control-plane.json"), "not-json");
  assert.equal(await resolveWorkspaceControlPlaneRoot(portfolioRoot), portfolioRoot);

  if (platform() !== "win32") {
    const escapedPortfolio = join(root, "escaped-portfolio");
    await mkdir(escapedPortfolio, { recursive: true });
    await mkdir(join(outsideRoot, ".devspace"), { recursive: true });
    await writeFile(
      join(outsideRoot, ".devspace", "control-plane.json"),
      JSON.stringify({ schema_version: 1, route_parent: true }),
    );
    await symlink(outsideRoot, join(escapedPortfolio, "_workspace"), "dir");
    assert.equal(await resolveWorkspaceControlPlaneRoot(escapedPortfolio), escapedPortfolio);
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}
