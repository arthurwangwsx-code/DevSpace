import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "fake-downstream", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo a message through the fake downstream MCP.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
}, async ({ message }) => message === "__simulate_user_active__" ? ({
  isError: true,
  content: [{ type: "text", text: "User input is active; desktop automation is yielding." }],
}) : ({
  content: [{ type: "text", text: message }],
  structuredContent: { echoed: message },
}));
server.registerTool("not_allowlisted", {
  description: "This tool must never appear in the DevSpace catalog.",
  inputSchema: z.object({}),
}, async () => ({ content: [{ type: "text", text: "hidden" }] }));

await server.connect(new StdioServerTransport());
