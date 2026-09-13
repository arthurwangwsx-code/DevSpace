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
    "desktop_list_windows",
    "desktop_snapshot_app",
    "desktop_screenshot_app",
    "desktop_screenshot_window",
    "desktop_activate_app",
    "desktop_click_point",
    "desktop_click_element",
    "desktop_focus_element",
    "desktop_scroll",
    "desktop_drag",
    "desktop_type_text",
    "desktop_press_key",
  ]);
  const status = await client.callTool({ name: "desktop_status", arguments: {} });
  assert.equal(status.isError, undefined);
  const structured = status.structuredContent as Record<string, unknown>;
  assert.equal(structured.platform, "macOS");
  assert.equal(typeof structured.accessibilityTrusted, "boolean");
  assert.equal(typeof structured.screenCaptureGranted, "boolean");
  const fixturePermissionsReady = structured.accessibilityTrusted === true
    && structured.screenCaptureGranted === true;
  console.log(JSON.stringify({
    passed: true,
    toolCount: tools.tools.length,
    accessibilityTrusted: structured.accessibilityTrusted,
    screenCaptureGranted: structured.screenCaptureGranted,
    ...(fixtureApp
      ? fixturePermissionsReady
        ? await runFixtureCanary(client, fixtureApp)
        : {
            fixtureCanarySkipped: true,
            fixtureCanarySkipReason:
              "temporary helper lacks stable macOS TCC identity; use test:desktop-runtime-fixture for real AX/screenshot acceptance",
          }
      : {}),
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
    let beforeTree: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const before = await client.callTool({
        name: "desktop_snapshot_app",
        arguments: { bundleId: "com.devspace.desktop-fixture", maxDepth: 8, maxNodes: 500 },
      });
      beforeTree = before.structuredContent;
      beforeJson = JSON.stringify(before.structuredContent);
      if (beforeJson.includes("DevSpace Fixture Label")) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.match(beforeJson, /DevSpace Fixture Label/);
    assert.doesNotMatch(beforeJson, /DO_NOT_LEAK_SECURE_VALUE/);
    const button = findAxNode(beforeTree, (node) => node.title === "Increment 0");
    const input = findAxNode(beforeTree, (node) => node.value === "fixture-start");
    assert.ok(button, "fixture button is missing from the AX snapshot");
    assert.ok(input, "fixture input is missing from the AX snapshot");
    assert.equal(typeof button.elementId, "string");
    assert.equal(typeof input.elementId, "string");
    const snapshotId = (beforeTree as { snapshotId?: unknown }).snapshotId;
    assert.equal(typeof snapshotId, "string");
    const windows = await client.callTool({
      name: "desktop_list_windows",
      arguments: { bundleId: "com.devspace.desktop-fixture", processId },
    });
    assert.equal(windows.isError, undefined);
    const visibleWindows = (windows.structuredContent as { windows?: Array<Record<string, unknown>> }).windows ?? [];
    assert.ok(visibleWindows.length > 0, "fixture has no visible desktop windows");
    const windowId = visibleWindows[0]?.windowId;
    assert.equal(typeof windowId, "number");
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
    assert.equal(typeof screenshotValue.sourceFrame, "object");
    assert.equal(typeof screenshotValue.scale, "number");
    assert.deepEqual(Buffer.from(screenshotValue.data as string, "base64").subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const exactScreenshot = await client.callTool({
      name: "desktop_screenshot_window",
      arguments: { bundleId: "com.devspace.desktop-fixture", processId, windowId, maxWidth: 800, maxHeight: 600 },
    });
    assert.equal(exactScreenshot.isError, undefined);
    assert.equal((exactScreenshot.structuredContent as Record<string, unknown>).windowId, windowId);

    await waitForUserYield();
    const clicked = await client.callTool({
      name: "desktop_click_element",
      arguments: {
        bundleId: "com.devspace.desktop-fixture",
        processId,
        snapshotId,
        elementId: button.elementId,
      },
    });
    assert.equal(clicked.isError, undefined);
    assert.equal((clicked.structuredContent as Record<string, unknown>).method, "AXPress");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const afterClick = await client.callTool({
      name: "desktop_snapshot_app",
      arguments: { bundleId: "com.devspace.desktop-fixture", maxDepth: 8, maxNodes: 500 },
    });
    assert.match(JSON.stringify(afterClick.structuredContent), /Clicked 1/);

    await waitForUserYield();
    const outsideClick = await client.callTool({
      name: "desktop_click_point",
      arguments: { bundleId: "com.devspace.desktop-fixture", x: -10_000, y: -10_000 },
    });
    assert.equal(outsideClick.isError, true);

    await waitForUserYield();
    const focused = await client.callTool({
      name: "desktop_focus_element",
      arguments: {
        bundleId: "com.devspace.desktop-fixture",
        processId,
        snapshotId,
        elementId: input.elementId,
      },
    });
    assert.equal(focused.isError, undefined);
    await waitForUserYield();
    const selectAll = await client.callTool({
      name: "desktop_press_key",
      arguments: { bundleId: "com.devspace.desktop-fixture", key: "A", modifiers: ["Command"] },
    });
    assert.equal(selectAll.isError, undefined);
    await waitForUserYield();
    const typed = await client.callTool({
      name: "desktop_type_text",
      arguments: { bundleId: "com.devspace.desktop-fixture", text: "typed-by-devspace-helper" },
    });
    assert.equal(typed.isError, undefined);
    await waitForUserYield();
    const pressed = await client.callTool({
      name: "desktop_press_key",
      arguments: { bundleId: "com.devspace.desktop-fixture", key: "Left" },
    });
    assert.equal(pressed.isError, undefined);
    await waitForUserYield();
    const rejectedKey = await client.callTool({
      name: "desktop_press_key",
      arguments: { bundleId: "com.devspace.desktop-fixture", key: "F20" },
    });
    assert.equal(rejectedKey.isError, true);
    await waitForUserYield();
    const inputCenter = center(input);
    const scrolled = await client.callTool({
      name: "desktop_scroll",
      arguments: { bundleId: "com.devspace.desktop-fixture", ...inputCenter, deltaY: -20 },
    });
    assert.equal(scrolled.isError, undefined);
    await waitForUserYield();
    const dragged = await client.callTool({
      name: "desktop_drag",
      arguments: {
        bundleId: "com.devspace.desktop-fixture",
        fromX: inputCenter.x,
        fromY: inputCenter.y,
        toX: inputCenter.x + 12,
        toY: inputCenter.y,
        durationMs: 80,
      },
    });
    assert.equal(dragged.isError, undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const after = await client.callTool({
      name: "desktop_snapshot_app",
      arguments: { bundleId: "com.devspace.desktop-fixture", maxDepth: 8, maxNodes: 500 },
    });
    assert.match(JSON.stringify(after.structuredContent), /typed-by-devspace-helper/);
    return { fixtureAxScreenshotClickInputAndKeyPassed: true };
  } finally {
    if (processId !== undefined) process.kill(processId, "SIGTERM");
  }
}

type AxNode = {
  elementId?: unknown;
  title?: unknown;
  value?: unknown;
  position?: { x?: unknown; y?: unknown };
  size?: { width?: unknown; height?: unknown };
  children?: unknown;
};

function findAxNode(value: unknown, matches: (node: AxNode) => boolean): AxNode | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findAxNode(child, matches);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const node = value as AxNode;
  if (matches(node)) return node;
  for (const child of Object.values(node)) {
    const found = findAxNode(child, matches);
    if (found) return found;
  }
  return undefined;
}

function center(node: AxNode): { x: number; y: number } {
  const x = node.position?.x;
  const y = node.position?.y;
  const width = node.size?.width;
  const height = node.size?.height;
  assert.equal(typeof x, "number");
  assert.equal(typeof y, "number");
  assert.equal(typeof width, "number");
  assert.equal(typeof height, "number");
  return { x: x + width / 2, y: y + height / 2 };
}

function waitForUserYield(): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
}
