import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityError } from "../errors.js";
import type { McpProviderManifest } from "../mcp-provider-manifest.js";
import type {
  CapabilityProvider,
  ProviderCapability,
  ProviderContext,
  ProviderInvocation,
  ProviderInvocationContext,
} from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";

export class McpClientProvider implements CapabilityProvider {
  readonly id: string;
  private client?: Client;
  private transport?: Transport;
  protected context?: ProviderContext;
  private tools?: Tool[];
  private startedAt?: string;
  private stopping = false;

  constructor(
    private readonly manifest: McpProviderManifest,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.id = manifest.metadata.id;
  }

  async start(context: ProviderContext): Promise<void> {
    if (this.client) return;
    this.context = context;
    this.stopping = false;
    const client = new Client(
      { name: `devspace-${this.id}`, version: "1.0.0" },
      {
        listChanged: {
          tools: {
            autoRefresh: true,
            debounceMs: 100,
            onChanged: (error, tools) => {
              if (error) {
                context.reportFailure(new CapabilityError(
                  "provider_unavailable",
                  "Downstream MCP tool refresh failed.",
                  { cause: error },
                ));
                return;
              }
              if (tools) this.tools = tools;
              context.reportCatalogChanged();
            },
          },
        },
      },
    );
    const transport = this.createTransport();
    client.onerror = (error) => {
      if (!this.stopping) context.reportFailure(error);
    };
    client.onclose = () => {
      if (!this.stopping) context.reportFailure(new Error("Downstream MCP transport closed."));
    };
    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.startedAt = new Date().toISOString();
      this.tools = (await client.listTools()).tools;
      this.validateAllowlist(this.tools);
    } catch (error) {
      this.stopping = true;
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      this.client = undefined;
      this.transport = undefined;
      throw error;
    }
  }

  async stop(_reason: string): Promise<void> {
    this.stopping = true;
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.tools = undefined;
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }

  async health(_signal: AbortSignal): Promise<ProviderHealth> {
    return {
      state: this.client ? "ready" : "stopped",
      since: this.startedAt ?? new Date().toISOString(),
    };
  }

  async discover(_signal: AbortSignal): Promise<ProviderCapability[]> {
    const client = this.requireClient();
    const tools = this.tools ?? (await client.listTools()).tools;
    this.tools = tools;
    this.validateAllowlist(tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    return this.manifest.spec.tools.map((mapping) => {
      const tool = byName.get(mapping.tool)!;
      return {
        descriptor: {
          id: mapping.capabilityId,
          version: mapping.version,
          providerId: this.id,
          title: mapping.title ?? tool.title ?? tool.name,
          description: mapping.description ?? tool.description ?? `Call downstream MCP tool ${tool.name}.`,
          tags: [...mapping.tags],
          inputSchema: jsonObject(tool.inputSchema, `${tool.name} input schema`),
          ...(tool.outputSchema ? {
            outputSchema: jsonObject(tool.outputSchema, `${tool.name} output schema`),
          } : {}),
          effects: { ...mapping.effects },
          permissions: mapping.permissions.map((permission) => ({ ...permission })),
          availability: { ...mapping.availability },
          execution: {
            modes: ["sync", "async"],
            defaultTimeoutMs: mapping.defaultTimeoutMs,
            maxTimeoutMs: mapping.maxTimeoutMs,
            requiresLease: mapping.requiresLease,
            resourceTypes: [...mapping.resourceTypes],
          },
          metadata: {
            downstreamProtocol: "mcp",
            downstreamTool: tool.name,
            manifestProvider: this.id,
          },
        },
        binding: { tool: mapping.tool },
        aliases: [...mapping.aliases],
      };
    });
  }

  async invoke(
    request: ProviderInvocation,
    context: ProviderInvocationContext,
  ): Promise<JsonValue> {
    const toolName = typeof request.binding.tool === "string" ? request.binding.tool : undefined;
    const mapping = this.manifest.spec.tools.find((candidate) => candidate.tool === toolName);
    if (!toolName || !mapping || mapping.capabilityId !== request.capabilityId) {
      throw new CapabilityError("policy_denied", "The downstream MCP tool is not allowlisted.");
    }
    if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
      throw new CapabilityError("invalid_arguments", "MCP tool arguments must be a JSON object.");
    }
    return this.callDownstreamTool(toolName, request.arguments as Record<string, unknown>, context.signal);
  }

  protected async callDownstreamTool(
    toolName: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const client = this.requireClient();
    if (signal.aborted) throw new CapabilityError("cancelled", "MCP tool call cancelled.");
    const result = await client.callTool(
      { name: toolName, arguments: argumentsValue },
      undefined,
      { signal },
    );
    if (result.isError) {
      throw new CapabilityError("internal_error", "The downstream MCP tool returned an error.");
    }
    return result.structuredContent
      ? jsonValue(result.structuredContent, `${toolName} structured result`)
      : jsonValue({ content: result.content }, `${toolName} result`);
  }

  private createTransport(): Transport {
    const transport = this.manifest.spec.transport;
    if (transport.type === "stdio") {
      const env = { ...getDefaultEnvironment() };
      for (const [name, source] of Object.entries(transport.envFrom)) {
        const value = this.environment[source];
        if (value === undefined) throw new Error(`Required environment variable is missing: ${source}`);
        env[name] = value;
      }
      return new StdioClientTransport({
        command: transport.command,
        args: [...transport.args],
        cwd: transport.cwd,
        env,
        stderr: "pipe",
      });
    }
    const headers: Record<string, string> = {};
    for (const [name, source] of Object.entries(transport.headersFromEnv)) {
      const value = this.environment[source];
      if (value === undefined) throw new Error(`Required environment variable is missing: ${source}`);
      headers[name] = value;
    }
    return new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: { headers },
    });
  }

  private validateAllowlist(tools: Tool[]): void {
    const available = new Set(tools.map(({ name }) => name));
    for (const mapping of this.manifest.spec.tools) {
      if (!available.has(mapping.tool)) {
        throw new CapabilityError(
          "provider_unavailable",
          `Allowlisted downstream MCP tool is missing: ${mapping.tool}`,
        );
      }
    }
  }

  protected requireClient(): Client {
    if (!this.client) throw new CapabilityError("provider_unavailable", "Downstream MCP is not connected.");
    return this.client;
  }
}

function jsonObject(value: unknown, label: string): JsonObject {
  const parsed = jsonValue(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapabilityError("provider_unavailable", `${label} must be a JSON object.`);
  }
  // MCP servers commonly emit a draft-07 `$schema` marker while DevSpace's
  // validator uses the 2020-12 engine. The schema keywords we accept here are
  // compatible; removing only the dialect marker avoids loading remote metaschemas.
  delete parsed.$schema;
  return parsed;
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined");
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new CapabilityError("provider_unavailable", `${label} is not JSON serializable.`, { cause: error });
  }
}
