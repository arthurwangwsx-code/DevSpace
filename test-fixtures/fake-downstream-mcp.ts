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
  description: "Visible only when the Provider enables discover-all mode.",
  inputSchema: z.object({}),
}, async () => ({ content: [{ type: "text", text: "hidden" }] }));
for (const name of ["collision.tool", "collision_tool"]) {
  server.registerTool(name, {
    description: "Exercises stable dynamic capability ID collision handling.",
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: "text", text: name }] }));
}

await server.connect(new StdioServerTransport());
