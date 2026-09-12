import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StressMetrics } from "./metrics.js";

export interface ToolResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
}

export class McpStressClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(
    private readonly url: string,
    private readonly metrics: StressMetrics,
    private readonly timeoutMs = 30_000,
    name = "devspace-stress",
  ) {
    this.client = new Client({ name, version: "1" });
    this.transport = new StreamableHTTPClientTransport(new URL(url));
  }

  async connect(): Promise<void> {
    await this.metrics.measure("initialize", () => this.client.connect(this.transport));
    this.connected = true;
  }

  async listTools(): Promise<number> {
    const response = await this.metrics.measure(
      "tools_list",
      () => this.client.listTools(undefined, { timeout: this.timeoutMs }),
    );
    return response.tools.length;
  }

  async openWorkspace(path: string): Promise<string> {
    const result = await this.call("open_workspace", { path }, "open_workspace");
    const workspaceId = result.structuredContent?.workspaceId;
    if (typeof workspaceId !== "string") throw new Error("open_workspace returned no workspaceId");
    return workspaceId;
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    metricName = tool,
    metrics = this.metrics,
  ): Promise<ToolResult> {
    return metrics.measure(metricName, async () => {
      const result = await this.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { timeout: this.timeoutMs },
      ) as ToolResult;
      if (result.isError) {
        throw new Error(`${tool} failed: ${JSON.stringify(result.content).slice(0, 500)}`);
      }
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.connected) await this.transport.terminateSession().catch(() => {});
    await this.client.close().catch(() => {});
    this.connected = false;
  }

  get endpoint(): string {
    return this.url;
  }
}

export function requiredNumber(result: ToolResult, key: string): number {
  const value = result.structuredContent?.[key];
  if (typeof value !== "number") throw new Error(`tool result has no numeric ${key}`);
  return value;
}

export function requiredBoolean(result: ToolResult, key: string): boolean {
  const value = result.structuredContent?.[key];
  if (typeof value !== "boolean") throw new Error(`tool result has no boolean ${key}`);
  return value;
}

export function optionalString(result: ToolResult, key: string): string {
  const value = result.structuredContent?.[key];
  return typeof value === "string" ? value : "";
}
