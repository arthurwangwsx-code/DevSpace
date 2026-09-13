import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

let selectedPage = 0;
const server = new McpServer({ name: "fake-chrome-devtools", version: "1.0.0" });
server.registerTool("list_pages", { inputSchema: z.object({}) }, async () => result({ pages: [
  { pageId: 0, url: "https://zero.fixture.test/path?secret=redacted" },
  { pageId: 1, url: "https://one.fixture.test/path" },
] }));
server.registerTool("select_page", {
  inputSchema: z.object({ pageId: z.number().int().min(0).max(1), bringToFront: z.boolean().optional() }),
}, async ({ pageId }) => { selectedPage = pageId; return result({ selectedPage }); });
for (const tool of ["take_snapshot", "take_screenshot", "list_console_messages", "list_network_requests"]) {
  server.registerTool(tool, { inputSchema: z.object({}) }, async () => result({ tool, selectedPage }));
}
server.registerTool("evaluate_script", { inputSchema: z.object({ function: z.string() }) }, async () =>
  result({ devspaceSecureField: false, devspaceInspected: true }));
server.registerTool("navigate_page", { inputSchema: z.object({ type: z.string().optional(), url: z.string().optional() }) }, async () =>
  result({ tool: "navigate_page", selectedPage }));
server.registerTool("click", { inputSchema: z.object({ uid: z.string() }) }, async () =>
  result({ tool: "click", selectedPage }));
server.registerTool("type_text", { inputSchema: z.object({ text: z.string() }) }, async () =>
  result({ tool: "type_text", selectedPage }));
server.registerTool("press_key", { inputSchema: z.object({ key: z.string() }) }, async () =>
  result({ tool: "press_key", selectedPage }));
await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}
