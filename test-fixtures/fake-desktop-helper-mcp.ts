import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "fake-desktop-helper", version: "1.0.0" });
server.registerTool("desktop_status", { inputSchema: z.object({}) }, async () => result({ accessibilityTrusted: true }));
server.registerTool("desktop_list_apps", { inputSchema: z.object({}) }, async () => result({
  apps: [{ bundleId: "com.example.fixture", name: "Fixture", frontmost: true }],
}));
server.registerTool("desktop_snapshot_app", {
  inputSchema: z.object({ bundleId: z.string(), maxDepth: z.number().optional(), maxNodes: z.number().optional() }),
}, async ({ bundleId }) => result({ tool: "snapshot", bundleId }));
server.registerTool("desktop_activate_app", {
  inputSchema: z.object({ bundleId: z.string() }),
}, async ({ bundleId }) => result({ tool: "activate", bundleId }));
server.registerTool("desktop_click_point", {
  inputSchema: z.object({ bundleId: z.string(), x: z.number(), y: z.number() }),
}, async ({ bundleId }) => result({ tool: "click", bundleId }));
server.registerTool("desktop_type_text", {
  inputSchema: z.object({ bundleId: z.string(), text: z.string() }),
}, async ({ bundleId }) => result({ tool: "type", bundleId }));
server.registerTool("desktop_press_key", {
  inputSchema: z.object({ bundleId: z.string(), key: z.string() }),
}, async ({ bundleId }) => result({ tool: "key", bundleId }));
await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}
