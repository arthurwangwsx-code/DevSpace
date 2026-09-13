import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelSupervisor } from "./tunnel-supervisor.js";

const root = mkdtempSync(join(tmpdir(), "devspace-tunnel-supervisor-"));
try {
  const marker = join(root, "marker.txt");
  const script = join(root, "tunnel.mjs");
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, process.env.DEVSPACE_LOCAL_MCP_URL + '\\n' + process.argv[2]); setTimeout(() => {}, 10000);`);
  const supervisor = new TunnelSupervisor({
    enabled: true,
    autoStart: true,
    command: process.execPath,
    args: [script, "${publicBaseUrl}"],
    publicBaseUrl: "https://example.test",
    restartOnExit: false,
  }, "http://127.0.0.1:7676/mcp");
  supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(supervisor.status().running, true);
  assert.equal(supervisor.status().configured, true);
  const text = await (await import("node:fs/promises")).readFile(marker, "utf8");
  assert.equal(text, "http://127.0.0.1:7676/mcp\nhttps://example.test");
  await supervisor.stop();
  assert.equal(supervisor.status().running, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("tunnel supervisor tests passed");
