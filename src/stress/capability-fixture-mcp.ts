#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const stateDirectory = resolve(argument("--state-dir") ?? process.cwd());
mkdirSync(stateDirectory, { recursive: true });
const crashMarker = join(stateDirectory, "crash-once.completed");

const server = new McpServer({ name: "devspace-capability-stress-fixture", version: "1.0.0" });

server.registerTool("echo", {
  description: "Echo a string through a deterministic downstream MCP fixture.",
  inputSchema: z.object({ value: z.string(), password: z.string().optional() }),
  outputSchema: z.object({ echoed: z.string() }),
}, async ({ value }) => ({
  content: [{ type: "text", text: value }],
  structuredContent: { echoed: value },
}));

server.registerTool("delay", {
  description: "Return after a bounded delay and honor MCP cancellation.",
  inputSchema: z.object({ value: z.string(), delayMs: z.number().int().min(1).max(10_000) }),
  outputSchema: z.object({ value: z.string(), delayMs: z.number() }),
}, async ({ value, delayMs }, extra) => {
  await abortableDelay(delayMs, extra.signal);
  return {
    content: [{ type: "text", text: value }],
    structuredContent: { value, delayMs },
  };
});

server.registerTool("large_output", {
  description: "Return a deterministic payload for output-limit tests.",
  inputSchema: z.object({ bytes: z.number().int().min(1).max(2 * 1024 * 1024) }),
  outputSchema: z.object({ payload: z.string() }),
}, async ({ bytes }) => ({
  content: [{ type: "text", text: `generated ${bytes} bytes` }],
  structuredContent: { payload: "x".repeat(bytes) },
}));

server.registerTool("crash_once", {
  description: "Crash this fixture once so supervisor recovery can be measured.",
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.object({ crashScheduled: z.boolean(), token: z.string() }),
}, async ({ token }) => {
  let alreadyCrashed = false;
  try {
    alreadyCrashed = readFileSync(crashMarker, "utf8") === "completed\n";
  } catch {}
  if (!alreadyCrashed) {
    writeFileSync(crashMarker, "completed\n", { mode: 0o600 });
    setTimeout(() => process.exit(73), 50).unref();
  }
  return {
    content: [{ type: "text", text: alreadyCrashed ? "already crashed" : "crash scheduled" }],
    structuredContent: { crashScheduled: !alreadyCrashed, token },
  };
});

await server.connect(new StdioServerTransport());

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolvePromise, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}
