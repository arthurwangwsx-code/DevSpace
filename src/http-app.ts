import express from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { ServerConfig } from "./config.js";

export function createHttpApp(config: ServerConfig) {
  const app = express();
  if (!config.allowedHosts.includes("*")) {
    app.use(hostHeaderValidation([...new Set([config.host, ...config.allowedHosts])]));
  }
  const maxBytes = config.resources.mcpMaxRequestBytes;
  // Admission precedes JSON decoding; hold the slot until the response ends.
  // This bounds bodies retained by active/queued tool requests, not just parsing.
  const maxBodies = Math.min(config.resources.mcpMaxConcurrentRequests,
    Math.max(1, Math.floor(128 * 1024 * 1024 / maxBytes)));
  let activeBodies = 0;
  app.use("/mcp", (req, res, next) => {
    if (req.method !== "POST") return next();
    if (activeBodies >= maxBodies) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({ jsonrpc: "2.0", id: null, error: {
        code: -32000, message: "Request memory budget busy; retry after 2 seconds.",
      } });
      return;
    }
    activeBodies++;
    let released = false;
    const release = () => { if (!released) { released = true; activeBodies--; } };
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
