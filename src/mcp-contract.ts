import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, type ToolMode } from "./config.js";
import { createServer } from "./server.js";

export interface McpToolContract {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
}

export type McpApiContract = Record<ToolMode, McpToolContract[]>;

export async function captureMcpApiContract(): Promise<McpApiContract> {
  const entries = await Promise.all(
    (["minimal", "codex", "full"] satisfies ToolMode[]).map(async (mode) => [
      mode,
      await captureToolMode(mode),
    ] as const),
  );
  return Object.fromEntries(entries) as McpApiContract;
}

async function captureToolMode(toolMode: ToolMode): Promise<McpToolContract[]> {
  const testRoot = mkdtempSync(join(tmpdir(), `devspace-mcp-contract-${toolMode}-`));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
    DEVSPACE_STATE_DIR: join(testRoot, "state"),
    DEVSPACE_ALLOWED_ROOTS: testRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "mcp-contract-owner-token-long-enough",
    DEVSPACE_AUTH_MODE: "trusted-local",
    DEVSPACE_TOOL_MODE: toolMode,
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  const client = new Client({ name: "devspace-contract-capture", version: "1" });
  let transport: StreamableHTTPClientTransport | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    const address = httpServer.address() as AddressInfo;
    transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    await client.connect(transport);
    const response = await client.listTools();
    return response.tools
      .map((tool) => sortJson({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      }) as unknown as McpToolContract)
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await transport?.terminateSession().catch(() => {});
    await client.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
