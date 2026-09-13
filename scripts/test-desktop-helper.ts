import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = resolve(process.argv[2] ?? ".build/devspace-desktop-helper");
const fixtureApp = process.argv[3] ? resolve(process.argv[3]) : undefined;
const execFileAsync = promisify(execFile);
const client = new Client({ name: "devspace-desktop-helper-canary", version: "1.0.0" });
const transport = new StdioClientTransport({ command, args: [], stderr: "pipe" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), [
    "desktop_status",
    "desktop_list_apps",
    "desktop_snapshot_app",
    "desktop_screenshot_app",
    "desktop_activate_app",
    "desktop_click_point",
    "desktop_type_text",
    "desktop_press_key",
  ]);
  const status = await client.callTool({ name: "desktop_status", arguments: {} });
  assert.equal(status.isError, undefined);
  const structured = status.structuredContent as Record<string, unknown>;
  assert.equal(structured.platform, "macOS");
  assert.equal(typeof structured.accessibilityTrusted, "boolean");
  assert.equal(typeof structured.screenCaptureGranted, "boolean");
  console.log(JSON.stringify({
    passed: true,
    toolCount: tools.tools.length,
    accessibilityTrusted: structured.accessibilityTrusted,
    screenCaptureGranted: structured.screenCaptureGranted,
    ...(fixtureApp ? await runFixtureCanary(client, fixtureApp) : {}),
  }));
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function runFixtureCanary(client: Client, appPath: string): Promise<Record<string, unknown>> {
  await execFileAsync("/usr/bin/open", ["-n", appPath]);
  let processId: number | undefined;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = await client.callTool({ name: "desktop_list_apps", arguments: {} });
      const apps = (listed.structuredContent as { apps?: Array<Record<string, unknown>> }).apps ?? [];
      const fixture = apps.find((app) => app.bundleId === "com.devspace.desktop-fixture");
      if (typeof fixture?.processId === "number") {
        processId = fixture.processId;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.equal(typeof processId, "number", "fixture app did not start");
    const activated = await client.callTool({
      name: "desktop_activate_app",
      arguments: { bundleId: "com.devspace.desktop-fixture" },
    });
    assert.equal(activated.isError, undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    let beforeJson = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const before = await client.callTool({
        name: "desktop_snapshot_app",
        arguments: { bundleId: "com.devspace.desktop-fixture", maxDepth: 8, maxNodes: 500 },
      });
      beforeJson = JSON.stringify(before.structuredContent);
      if (beforeJson.includes("DevSpace Fixture Label")) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.match(beforeJson, /DevSpace Fixture Label/);
    assert.doesNotMatch(beforeJson, /DO_NOT_LEAK_SECURE_VALUE/);
    const screenshot = await client.callTool({
      name: "desktop_screenshot_app",
      arguments: { bundleId: "com.devspace.desktop-fixture", maxWidth: 800, maxHeight: 600 },
    });
    assert.equal(screenshot.isError, undefined);
    const screenshotValue = screenshot.structuredContent as Record<string, unknown>;
    assert.equal(screenshotValue.mimeType, "image/png");
    assert.equal(typeof screenshotValue.width, "number");
    assert.equal(typeof screenshotValue.height, "number");
    assert.equal(typeof screenshotValue.data, "string");
    assert.deepEqual(Buffer.from(screenshotValue.data as string, "base64").subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
    const typed = await client.callTool({
      name: "desktop_type_text",
      arguments: { bundleId: "com.devspace.desktop-fixture", text: "typed-by-devspace-helper" },
    });
    assert.equal(typed.isError, undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const after = await client.callTool({
      name: "desktop_snapshot_app",
      arguments: { bundleId: "com.devspace.desktop-fixture", maxDepth: 8, maxNodes: 500 },
    });
    assert.match(JSON.stringify(after.structuredContent), /typed-by-devspace-helper/);
    return { fixtureAxInputAndScreenshotPassed: true };
  } finally {
    if (processId !== undefined) process.kill(processId, "SIGTERM");
  }
}
