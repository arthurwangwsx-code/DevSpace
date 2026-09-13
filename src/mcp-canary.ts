import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpCanaryOptions {
  url: string;
  workspacePath: string;
  readPath: string;
  timeoutMs?: number;
}

export interface McpCanaryResult {
  ok: true;
  url: string;
  workspacePath: string;
  readPath: string;
  workspaceId: string;
  resumed: boolean;
  toolCount: number;
  toolNames: string[];
  timingsMs: {
    initialize: number;
    toolsList: number;
    openWorkspace: number;
    read: number;
    execCommand: number;
    total: number;
  };
}

interface ToolResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
}

export async function runMcpCanary(options: McpCanaryOptions): Promise<McpCanaryResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, "timeoutMs must be a positive integer");

  const client = new Client({ name: "devspace-canary", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url));
  const totalStartedAt = performance.now();
  const timings = {
    initialize: 0,
    toolsList: 0,
    openWorkspace: 0,
    read: 0,
    execCommand: 0,
  };

  const measure = async <T>(key: keyof typeof timings, operation: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      timings[key] = roundMilliseconds(performance.now() - startedAt);
    }
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs },
    ) as ToolResult;
    assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result.content).slice(0, 500)}`);
    return result;
  };

  try {
    await measure("initialize", () => client.connect(transport));
    const tools = await measure("toolsList", () => client.listTools(undefined, { timeout: timeoutMs }));
    const toolNames = tools.tools.map(({ name }) => name).sort();
    assert.deepEqual(toolNames, [
      "apply_patch",
      "exec_command",
      "open_workspace",
      "read",
      "release_workspace",
      "write_stdin",
    ], "production MCP must expose the exact codex tool contract");
    const open = await measure("openWorkspace", () => call("open_workspace", {
      path: options.workspacePath,
    }));
    const workspaceId = open.structuredContent?.workspaceId;
    if (typeof workspaceId !== "string") {
      throw new Error("open_workspace returned no workspaceId");
    }

    await measure("read", () => call("read", {
      workspaceId,
      path: options.readPath,
      limit: 5,
    }));
    const command = await measure("execCommand", () => call("exec_command", {
      workspaceId,
      cmd: "pwd",
      yieldTimeMs: 1_000,
    }));
    assert.equal(command.structuredContent?.exitCode, 0, "exec_command pwd did not exit successfully");

    return {
      ok: true,
      url: options.url,
      workspacePath: options.workspacePath,
      readPath: options.readPath,
      workspaceId,
      resumed: open.structuredContent?.resumed === true,
      toolCount: tools.tools.length,
      toolNames,
      timingsMs: {
        ...timings,
        total: roundMilliseconds(performance.now() - totalStartedAt),
      },
    };
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
