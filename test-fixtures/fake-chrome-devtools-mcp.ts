import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

let selectedPage = 0;
const server = new McpServer({ name: "fake-chrome-devtools", version: "1.0.0" });
server.registerTool("list_pages", { inputSchema: z.object({}) }, async () => result({ pages: [0, 1] }));
server.registerTool("select_page", {
  inputSchema: z.object({ pageId: z.number().int().min(0).max(1), bringToFront: z.boolean().optional() }),
}, async ({ pageId }) => { selectedPage = pageId; return result({ selectedPage }); });
for (const tool of ["take_snapshot", "take_screenshot", "list_console_messages", "list_network_requests"]) {
  server.registerTool(tool, { inputSchema: z.object({}) }, async () => result({ tool, selectedPage }));
}
await server.connect(new StdioServerTransport());

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}
