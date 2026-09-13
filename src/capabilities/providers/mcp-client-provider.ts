import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityError } from "../errors.js";
import type { McpProviderManifest, McpToolMapping } from "../mcp-provider-manifest.js";
import type {
  CapabilityProvider,
  ProviderCapability,
  ProviderContext,
  ProviderInvocation,
  ProviderInvocationContext,
} from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";

type ProtocolMethod = "resources/list" | "resources/templates/list" | "resources/read"
  | "prompts/list" | "prompts/get";

export class McpClientProvider implements CapabilityProvider {
  readonly id: string;
  private client?: Client;
  private transport?: Transport;
  protected context?: ProviderContext;
  private tools?: Tool[];
  private readonly bindings = new Map<string, string>();
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
    this.bindings.clear();
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
    const mappings = this.resolveMappings(tools);
    this.bindings.clear();
    for (const mapping of mappings) this.bindings.set(toolBindingKey(mapping.tool), mapping.capabilityId);
    const toolCapabilities: ProviderCapability[] = mappings.map((mapping) => {
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
    const protocolCapabilities = this.protocolCapabilities(client);
    for (const capability of protocolCapabilities) {
      this.bindings.set(protocolBindingKey(capability.binding.mcpMethod as ProtocolMethod), capability.descriptor.id);
    }
    return [...toolCapabilities, ...protocolCapabilities];
  }

  async invoke(
    request: ProviderInvocation,
    context: ProviderInvocationContext,
  ): Promise<JsonValue> {
    const toolName = typeof request.binding.tool === "string" ? request.binding.tool : undefined;
    const protocolMethod = isProtocolMethod(request.binding.mcpMethod)
      ? request.binding.mcpMethod
      : undefined;
    const bindingKey = toolName
      ? toolBindingKey(toolName)
      : protocolMethod ? protocolBindingKey(protocolMethod) : undefined;
    if (!bindingKey || this.bindings.get(bindingKey) !== request.capabilityId) {
      throw new CapabilityError("policy_denied", "The downstream MCP operation is not registered in the catalog.");
    }
    if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
      throw new CapabilityError("invalid_arguments", "MCP tool arguments must be a JSON object.");
    }
    if (toolName) {
      return this.callDownstreamTool(toolName, request.arguments as Record<string, unknown>, context.signal);
    }
    return this.callDownstreamProtocol(
      protocolMethod!,
      request.arguments as Record<string, unknown>,
      context.signal,
    );
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
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((item): item is { type: "text"; text: string } => Boolean(
          item && typeof item === "object" && item.type === "text" && typeof item.text === "string",
        ))
        .map((item) => item.text)
        .join(" ");
      if (/accessibility permission is required|screen(?: |-)capture permission is required/i.test(text)) {
        throw new CapabilityError("permission_required", "The downstream provider requires local user approval.", {
          details: { action: "Grant the requested permission to the stable provider executable, then restart it." },
        });
      }
      if (/user input is active; desktop automation is yielding/i.test(text)) {
        throw new CapabilityError("temporarily_unavailable", "Desktop automation yielded to recent user input.", {
          details: { action: "Retry after the local user has been idle." },
        });
      }
      if (/leased application process is no longer running/i.test(text)) {
        throw new CapabilityError("lease_expired", "The leased application process is no longer running.");
      }
      throw new CapabilityError("internal_error", "The downstream MCP tool returned an error.");
    }
    return result.structuredContent
      ? jsonValue(result.structuredContent, `${toolName} structured result`)
      : jsonValue({ content: result.content }, `${toolName} result`);
  }

  private async callDownstreamProtocol(
    method: ProtocolMethod,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const client = this.requireClient();
    if (signal.aborted) throw new CapabilityError("cancelled", "MCP protocol call cancelled.");
    const options = { signal };
    if (method === "resources/list") {
      return jsonValue(await client.listResources(optionalCursor(argumentsValue), options), method);
    }
    if (method === "resources/templates/list") {
      return jsonValue(await client.listResourceTemplates(optionalCursor(argumentsValue), options), method);
    }
    if (method === "resources/read") {
      return jsonValue(await client.readResource({ uri: requiredString(argumentsValue.uri, "uri") }, options), method);
    }
    if (method === "prompts/list") {
      return jsonValue(await client.listPrompts(optionalCursor(argumentsValue), options), method);
    }
    const promptArguments = argumentsValue.arguments;
    if (promptArguments !== undefined && (!promptArguments || typeof promptArguments !== "object" || Array.isArray(promptArguments))) {
      throw new CapabilityError("invalid_arguments", "arguments must be an object of string values.");
    }
    return jsonValue(await client.getPrompt({
      name: requiredString(argumentsValue.name, "name"),
      ...(promptArguments === undefined ? {} : {
        arguments: Object.fromEntries(Object.entries(promptArguments).map(([name, value]) => [
          name,
          requiredString(value, `arguments.${name}`),
        ])),
      }),
    }, options), method);
  }

  private protocolCapabilities(client: Client): ProviderCapability[] {
    const server = client.getServerCapabilities();
    const capabilities: ProviderCapability[] = [];
    if (server?.resources) {
      capabilities.push(
        protocolCapability(this.id, "resources/list", "resources.list", "列出 MCP Resources", cursorSchema()),
        protocolCapability(
          this.id,
          "resources/templates/list",
          "resources.templates.list",
          "列出 MCP Resource Templates",
          cursorSchema(),
        ),
        protocolCapability(this.id, "resources/read", "resources.read", "读取 MCP Resource", {
          type: "object",
          properties: { uri: { type: "string", minLength: 1 } },
          required: ["uri"],
          additionalProperties: false,
        }),
      );
    }
    if (server?.prompts) {
      capabilities.push(
        protocolCapability(this.id, "prompts/list", "prompts.list", "列出 MCP Prompts", cursorSchema()),
        protocolCapability(this.id, "prompts/get", "prompts.get", "获取 MCP Prompt", {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            arguments: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["name"],
          additionalProperties: false,
        }),
      );
    }
    return capabilities;
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

  private resolveMappings(tools: Tool[]): McpToolMapping[] {
    const explicit = this.manifest.spec.tools.map((mapping) => structuredClone(mapping));
    if (!this.manifest.spec.discoverAllTools) return explicit;
    const explicitTools = new Set(explicit.map(({ tool }) => tool));
    const dynamicTools = tools
      .filter(({ name }) => !explicitTools.has(name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const slugs = new Map<string, string[]>();
    for (const tool of dynamicTools) {
      const slug = toolSlug(tool.name);
      slugs.set(slug, [...(slugs.get(slug) ?? []), tool.name]);
    }
    const usedCapabilityIds = new Set(explicit.map(({ capabilityId }) => capabilityId));
    const dynamic = dynamicTools.map((tool): McpToolMapping => {
      const slug = toolSlug(tool.name);
      const collides = (slugs.get(slug)?.length ?? 0) > 1;
      const base = `${this.id}.${slug}`;
      const hash = createHash("sha256").update(tool.name).digest("hex");
      let capabilityId = collides || usedCapabilityIds.has(base)
        ? `${base}_${hash.slice(0, 8)}`
        : base;
      let collisionIndex = 1;
      while (usedCapabilityIds.has(capabilityId)) {
        capabilityId = `${base}_${hash.slice(0, 8)}_${collisionIndex}`;
        collisionIndex += 1;
      }
      usedCapabilityIds.add(capabilityId);
      return {
        tool: tool.name,
        capabilityId,
        version: this.manifest.spec.discoveredToolVersion,
        tags: ["mcp", "dynamic"],
        aliases: [],
        effects: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
        availability: {
          requiresAwake: false,
          requiresLoggedInSession: false,
          requiresUnlocked: false,
          requiresForegroundApp: false,
        },
        permissions: [],
        requiresLease: false,
        resourceTypes: [],
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 120_000,
      };
    });
    return [...explicit, ...dynamic];
  }

  protected requireClient(): Client {
    if (!this.client) throw new CapabilityError("provider_unavailable", "Downstream MCP is not connected.");
    return this.client;
  }
}

function protocolCapability(
  providerId: string,
  method: ProtocolMethod,
  suffix: string,
  title: string,
  inputSchema: JsonObject,
): ProviderCapability {
  const capabilityId = `${providerId}.${suffix}`;
  return {
    descriptor: {
      id: capabilityId,
      version: "1.0.0",
      providerId,
      title,
      description: `Call downstream MCP method ${method}.`,
      tags: ["mcp", "dynamic", method.startsWith("resources/") ? "resource" : "prompt"],
      inputSchema,
      effects: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
      permissions: [],
      availability: {
        requiresAwake: false,
        requiresLoggedInSession: false,
        requiresUnlocked: false,
        requiresForegroundApp: false,
      },
      execution: {
        modes: ["sync", "async"],
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 120_000,
        requiresLease: false,
        resourceTypes: [],
      },
      metadata: {
        downstreamProtocol: "mcp",
        downstreamMethod: method,
        manifestProvider: providerId,
      },
    },
    binding: { mcpMethod: method },
    aliases: [],
  };
}

function cursorSchema(): JsonObject {
  return {
    type: "object",
    properties: { cursor: { type: "string", minLength: 1 } },
    required: [],
    additionalProperties: false,
  };
}

function optionalCursor(argumentsValue: Record<string, unknown>): { cursor?: string } {
  return argumentsValue.cursor === undefined
    ? {}
    : { cursor: requiredString(argumentsValue.cursor, "cursor") };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilityError("invalid_arguments", `${name} must be a non-empty string.`);
  }
  return value;
}

function isProtocolMethod(value: unknown): value is ProtocolMethod {
  return value === "resources/list"
    || value === "resources/templates/list"
    || value === "resources/read"
    || value === "prompts/list"
    || value === "prompts/get";
}

function protocolBindingKey(method: ProtocolMethod): string {
  return `@mcp:${method}`;
}

function toolBindingKey(tool: string): string {
  return `@tool:${tool}`;
}

function toolSlug(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (slug) return slug;
  return `tool_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
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
