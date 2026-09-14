import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelSupervisor } from "./tunnel-supervisor.js";

const root = mkdtempSync(join(tmpdir(), "devspace-tunnel-supervisor-"));
try {
  const marker = join(root, "marker.txt");
  const script = join(root, "tunnel.mjs");
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, [process.env.DEVSPACE_LOCAL_MCP_URL, process.env.DEVSPACE_TUNNEL_ID, process.env.DEVSPACE_TUNNEL_API_KEY_FILE, process.argv[2], process.argv[3], process.argv[4]].join('\\n')); setTimeout(() => {}, 10000);`);
  const supervisor = new TunnelSupervisor({
    enabled: true,
    autoStart: true,
    command: process.execPath,
    args: [script, "${publicBaseUrl}", "${tunnelId}", "${apiKeyFile}"],
    tunnelId: "tunnel_test",
    apiKeyFile: "/tmp/devspace-test-key",
    publicBaseUrl: "https://example.test",
    restartOnExit: false,
  }, "http://127.0.0.1:7676/mcp");
  supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(supervisor.status().running, true);
  assert.equal(supervisor.status().configured, true);
  const text = await (await import("node:fs/promises")).readFile(marker, "utf8");
  assert.equal(text, "http://127.0.0.1:7676/mcp\ntunnel_test\n/tmp/devspace-test-key\nhttps://example.test\ntunnel_test\n/tmp/devspace-test-key");
  await supervisor.stop();
  assert.equal(supervisor.status().running, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("tunnel supervisor tests passed");
