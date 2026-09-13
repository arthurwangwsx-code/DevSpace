import express from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { ServerConfig } from "./config.js";

export function createHttpApp(config: ServerConfig) {
  const app = express();
  if (!config.allowedHosts.includes("*")) {
    app.use(hostHeaderValidation([...new Set([config.host, ...config.allowedHosts])]));
  }
  const maxBytes = config.resources.mcpMaxRequestBytes;
  // Admission precedes JSON decoding and is retained until the response ends.
  // Known Content-Length requests reserve their declared size, while
  // chunked/unknown bodies reserve the full per-request limit. This lets small
  // MCP calls use the configured execution + queue capacity without allowing
  // large or unbounded bodies to exceed the aggregate 128 MiB budget.
  const maxBodyBytes = 128 * 1024 * 1024;
  const maxBodies = config.resources.mcpMaxConcurrentRequests
    + config.resources.mcpMaxQueuedRequests;
  let activeBodies = 0;
  let activeBodyBytes = 0;
  app.use(["/mcp", "/capabilities/mcp"], (req, res, next) => {
    if (req.method !== "POST") return next();
    const declaredLength = requestContentLength(req.header("content-length"));
    const reservedBytes = declaredLength === undefined
      ? maxBytes
      : Math.min(Math.max(1, declaredLength), maxBytes);
    if (activeBodies >= maxBodies || activeBodyBytes + reservedBytes > maxBodyBytes) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({ jsonrpc: "2.0", id: null, error: {
        code: -32000, message: "Request body budget busy; retry after 2 seconds.",
      } });
      return;
    }
    activeBodies++;
    activeBodyBytes += reservedBytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeBodies--;
      activeBodyBytes -= reservedBytes;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  }, express.json({ limit: maxBytes, inflate: false }));
  // OAuth and non-MCP routes retain a narrow input budget.
  app.use(express.json({ limit: "100kb" }));
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error.status ?? 400;
    res.status(status).json({ jsonrpc: "2.0", id: null, error: {
      code: -32600,
      message: status === 413 ? `Request exceeds ${maxBytes} bytes; split the write/edit into smaller calls.` : "Invalid JSON request body.",
    } });
  });
  return app;
}

function requestContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
