import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod/v4";
import { CapabilityError } from "../errors.js";
import { parseMcpProviderManifest, type McpProviderManifest } from "../mcp-provider-manifest.js";
import type { ProviderContext } from "../provider.js";
import { McpClientProvider } from "./mcp-client-provider.js";

const fixturePath = fileURLToPath(new URL("../../../test-fixtures/fake-downstream-mcp.ts", import.meta.url));
const stdioManifest = manifest({
  type: "stdio",
  command: process.execPath,
  args: ["--import", "tsx", fixturePath],
});
const stdio = new McpClientProvider(stdioManifest);
await stdio.start(context());
try {
  const capabilities = await stdio.discover(new AbortController().signal);
  assert.deepEqual(capabilities.map(({ descriptor }) => descriptor.id), ["test.external.echo"]);
  assert.equal(capabilities[0]!.descriptor.inputSchema.type, "object");
  const value = await stdio.invoke({
    capabilityId: "test.external.echo",
    descriptor: capabilities[0]!.descriptor,
    binding: capabilities[0]!.binding,
    arguments: { message: "stdio" },
  }, { signal: new AbortController().signal });
  assert.deepEqual(value, { echoed: "stdio" });
  await assert.rejects(stdio.invoke({
    capabilityId: "test.external.echo",
    descriptor: capabilities[0]!.descriptor,
    binding: capabilities[0]!.binding,
    arguments: { message: "__simulate_user_active__" },
  }, { signal: new AbortController().signal }), (error) =>
    error instanceof CapabilityError && error.code === "temporarily_unavailable");
  await assert.rejects(stdio.invoke({
    capabilityId: "test.external.hidden",
    descriptor: capabilities[0]!.descriptor,
    binding: { tool: "not_allowlisted" },
    arguments: {},
  }, { signal: new AbortController().signal }), /not allowlisted/);
} finally {
  await stdio.stop("test_complete");
}

const app = express();
app.use(express.json());
app.post("/mcp", async (req, res) => {
  if (req.header("x-test-token") !== "expected") return res.sendStatus(401);
  const server = fakeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.once("close", () => { void server.close(); void transport.close(); });
});
app.get("/mcp", (_req, res) => res.sendStatus(405));
const httpServer = app.listen(0, "127.0.0.1");
try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const port = (httpServer.address() as AddressInfo).port;
  const http = new McpClientProvider(manifest({
    type: "streamable-http",
    url: `http://127.0.0.1:${port}/mcp`,
    headersFromEnv: { "x-test-token": "DOWNSTREAM_TEST_TOKEN" },
  }), { DOWNSTREAM_TEST_TOKEN: "expected" });
  await http.start(context());
  try {
    const capabilities = await http.discover(new AbortController().signal);
    const value = await http.invoke({
      capabilityId: "test.external.echo",
      descriptor: capabilities[0]!.descriptor,
      binding: capabilities[0]!.binding,
      arguments: { message: "http" },
    }, { signal: new AbortController().signal });
    assert.deepEqual(value, { echoed: "http" });
  } finally {
    await http.stop("test_complete");
  }
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}

const missing = new McpClientProvider(parseMcpProviderManifest({
  ...stdioManifest,
  metadata: { id: "test.external.missing" },
  spec: {
    ...stdioManifest.spec,
    tools: [{
      ...stdioManifest.spec.tools[0],
      tool: "missing_tool",
      capabilityId: "test.external.missing",
    }],
  },
}));
await assert.rejects(missing.start(context()), /Allowlisted downstream MCP tool is missing/);
await missing.stop("test_complete");

console.log("MCP client provider tests passed: stdio, HTTP, env headers, allowlist, schema fail-closed, user-active yield");

function manifest(transport: Record<string, unknown>): McpProviderManifest {
  return parseMcpProviderManifest({
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: "test.external.mcp" },
    spec: {
      transport,
      tools: [{
        tool: "echo",
        capabilityId: "test.external.echo",
        effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      }],
    },
  });
}

function context(): ProviderContext {
  return {
    signal: new AbortController().signal,
    reportFailure: (error) => { throw error; },
    reportCatalogChanged: () => {},
    log: () => {},
  };
}

function fakeServer(): McpServer {
  const server = new McpServer({ name: "fake-http-downstream", version: "1.0.0" });
  server.registerTool("echo", {
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
  }, async ({ message }) => ({
    content: [{ type: "text", text: message }],
    structuredContent: { echoed: message },
  }));
  server.registerTool("not_allowlisted", { inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "hidden" }],
  }));
  return server;
}
