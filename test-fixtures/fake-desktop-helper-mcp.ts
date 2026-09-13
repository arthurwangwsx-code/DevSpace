import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const permissionsDenied = process.argv.includes("--permissions-denied");
const server = new McpServer({ name: "fake-desktop-helper", version: "1.0.0" });
server.registerTool("desktop_status", { inputSchema: z.object({}) }, async () => result({
  accessibilityTrusted: !permissionsDenied,
  screenCaptureGranted: !permissionsDenied,
}));
server.registerTool("desktop_list_apps", { inputSchema: z.object({}) }, async () => result({
  apps: [{ bundleId: "com.example.fixture", name: "Fixture", processId: 4242, frontmost: true }],
}));
server.registerTool("desktop_list_windows", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional() }),
}, async ({ bundleId, processId }) => result({
  bundleId, processId, windows: [{ windowId: 77, frame: { x: 10, y: 20, width: 400, height: 300 } }],
}));
server.registerTool("desktop_snapshot_app", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), maxDepth: z.number().optional(), maxNodes: z.number().optional() }),
}, async ({ bundleId, processId }) => result({ tool: "snapshot", bundleId, processId, snapshotId: "fixture-snapshot" }));
server.registerTool("desktop_screenshot_app", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), maxWidth: z.number().optional(), maxHeight: z.number().optional() }),
}, async ({ bundleId, processId }) => result({ tool: "screenshot", bundleId, processId, mimeType: "image/png", data: "fixture" }));
server.registerTool("desktop_screenshot_window", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), windowId: z.number().int(), maxWidth: z.number().optional(), maxHeight: z.number().optional() }),
}, async ({ bundleId, processId, windowId }) => result({
  tool: "screenshot-window", bundleId, processId, windowId, mimeType: "image/png", data: "fixture",
}));
server.registerTool("desktop_activate_app", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional() }),
}, async ({ bundleId, processId }) => result({ tool: "activate", bundleId, processId }));
server.registerTool("desktop_click_point", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), x: z.number(), y: z.number(), button: z.string().optional(), clickCount: z.number().int().optional() }),
}, async ({ bundleId, processId }) => result({ tool: "click", bundleId, processId }));
server.registerTool("desktop_click_element", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), snapshotId: z.string(), elementId: z.string() }),
}, async ({ bundleId, processId, snapshotId, elementId }) => result({
  tool: "click-element", bundleId, processId, snapshotId, elementId,
}));
server.registerTool("desktop_focus_element", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), snapshotId: z.string(), elementId: z.string() }),
}, async ({ bundleId, processId, snapshotId, elementId }) => result({
  tool: "focus-element", bundleId, processId, snapshotId, elementId,
}));
server.registerTool("desktop_scroll", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), x: z.number(), y: z.number(), deltaX: z.number().optional(), deltaY: z.number() }),
}, async ({ bundleId, processId }) => result({ tool: "scroll", bundleId, processId }));
server.registerTool("desktop_drag", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), durationMs: z.number().int().optional() }),
}, async ({ bundleId, processId }) => result({ tool: "drag", bundleId, processId }));
server.registerTool("desktop_type_text", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), text: z.string() }),
}, async ({ bundleId, processId }) => result({ tool: "type", bundleId, processId }));
server.registerTool("desktop_press_key", {
  inputSchema: z.object({ bundleId: z.string(), processId: z.number().int().optional(), key: z.string(), modifiers: z.array(z.string()).optional() }),
}, async ({ bundleId, processId }) => result({ tool: "key", bundleId, processId }));
await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}
