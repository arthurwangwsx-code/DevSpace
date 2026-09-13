import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { CapabilityError, capabilityErrorEnvelope, normalizeCapabilityError } from "./errors.js";
import type { CapabilityEvent } from "./events.js";
import type { CapabilityRuntime } from "./runtime.js";
import type { CapabilityPrincipal, JsonObject, JsonValue } from "./types.js";

const SSE_QUEUE_LIMIT = 64;

export interface CapabilityHttpRouterOptions {
  runtime: CapabilityRuntime;
  discoverAuth: RequestHandler;
  invokeAuth: RequestHandler;
  adminAuth: RequestHandler;
  principal(req: Request): CapabilityPrincipal;
}

export function createCapabilityHttpRouter(options: CapabilityHttpRouterOptions): express.Router {
  const router = express.Router();
  const discover = [options.discoverAuth, principalMiddleware(options.principal)];
  const invoke = [options.invokeAuth, principalMiddleware(options.principal)];
  const admin = [options.adminAuth, principalMiddleware(options.principal)];

  router.get("/providers", ...discover, handle(options.runtime, (req) => ({
    items: options.runtime.supervisor.list(),
  })));
  router.get("/providers/:providerId", ...discover, handle(options.runtime, (req) => {
    const providerId = pathParam(req.params.providerId, "providerId");
    const provider = options.runtime.supervisor.list().find(({ id }) => id === providerId);
    if (!provider) throw new CapabilityError("capability_not_found", "Unknown provider.");
    return provider;
  }));
  router.get("/capabilities", ...discover, handle(options.runtime, (req) =>
    options.runtime.registry.list({
      providerId: stringQuery(req.query.providerId),
      tag: stringQuery(req.query.tag),
      availableOnly: booleanQuery(req.query.availableOnly),
      cursor: stringQuery(req.query.cursor),
      limit: integerQuery(req.query.limit),
    }, (descriptor) => options.runtime.policy.canDiscover(principal(req), descriptor))));
  router.post("/capabilities/search", ...discover, handle(options.runtime, (req) => {
    const body = objectBody(req.body);
    const filters = optionalObject(body.filters);
    const query = requiredString(body.query, "query");
    return options.runtime.registry.search({
      query,
      providerIds: optionalStringArray(filters?.providerIds, "filters.providerIds"),
      tags: optionalStringArray(filters?.tags, "filters.tags"),
      availableOnly: optionalBoolean(filters?.availableOnly, "filters.availableOnly"),
      limit: optionalInteger(body.limit, "limit"),
    }, (descriptor) => options.runtime.policy.canDiscover(principal(req), descriptor));
  }));
  router.get("/capabilities/:capabilityId", ...discover, handle(options.runtime, (req) => {
    const descriptor = options.runtime.registry.getDescriptor(pathParam(req.params.capabilityId, "capabilityId"));
    if (!descriptor || !options.runtime.policy.canDiscover(principal(req), descriptor)) {
      throw new CapabilityError("capability_not_found", "Unknown capability.");
    }
    return descriptor;
  }));
  router.post("/leases", ...invoke, handle(options.runtime, async (req) => {
    const body = objectBody(req.body);
    return options.runtime.router.openLease({
      requestId: requestId(req),
      principal: principal(req),
      providerId: requiredString(body.providerId, "providerId"),
      resourceType: requiredString(body.resourceType, "resourceType"),
      selector: optionalObject(body.selector) ?? {},
      ...(body.ttlSeconds === undefined ? {} : {
        ttlMs: optionalInteger(body.ttlSeconds, "ttlSeconds")! * 1_000,
      }),
    });
  }));
  router.delete("/leases/:leaseId", ...invoke, handle(options.runtime, async (req) => {
    await options.runtime.router.closeLease({
      requestId: requestId(req),
      principal: principal(req),
      leaseId: pathParam(req.params.leaseId, "leaseId"),
    });
    return { closed: true, leaseId: pathParam(req.params.leaseId, "leaseId") };
  }));
  router.post("/invocations", ...invoke, handle(options.runtime, async (req, res) => {
    const body = objectBody(req.body);
    const mode = optionalEnum(body.mode, ["sync", "async"] as const, "mode");
    const invocation = await options.runtime.router.invoke({
      requestId: requestId(req),
      principal: principal(req),
      capabilityId: requiredString(body.capabilityId, "capabilityId"),
      arguments: jsonValue(body.arguments ?? {}),
      leaseId: optionalString(body.leaseId, "leaseId"),
      mode,
      timeoutMs: optionalInteger(body.timeoutMs, "timeoutMs"),
      idempotencyKey: optionalString(body.idempotencyKey, "idempotencyKey"),
    });
    if (mode === "async" && !isTerminal(invocation.status)) res.status(202);
    return invocation;
  }));
  router.get("/invocations/:invocationId", ...invoke, handle(options.runtime, (req) =>
    options.runtime.router.getInvocation(pathParam(req.params.invocationId, "invocationId"), principal(req))));
  router.post("/invocations/:invocationId/cancel", ...invoke, handle(options.runtime, (req) =>
    options.runtime.router.cancelInvocation({
      requestId: requestId(req),
      invocationId: pathParam(req.params.invocationId, "invocationId"),
      principal: principal(req),
    })));
  router.get("/permissions", ...discover, handle(options.runtime, () => ({
    providers: options.runtime.supervisor.list().map((provider) => ({
      providerId: provider.id,
      state: provider.health.state,
      reasonCode: provider.health.reasonCode,
      userAction: provider.health.userAction,
    })),
  })));
  router.get("/grants", ...admin, handle(options.runtime, (req) =>
    ({ items: options.runtime.listGrants(principal(req)) })));
  router.post("/grants", ...admin, handle(options.runtime, (req) => {
    const body = objectBody(req.body);
    const constraints = optionalObject(body.targetConstraints);
    return options.runtime.createGrant(principal(req), {
      ...(body.id === undefined ? {} : { id: requiredString(body.id, "id") }),
      principalId: requiredString(body.principalId, "principalId"),
      capabilityPattern: requiredString(body.capabilityPattern, "capabilityPattern"),
      providerPattern: requiredString(body.providerPattern, "providerPattern"),
      ...(body.resourceType === undefined ? {} : { resourceType: requiredString(body.resourceType, "resourceType") }),
      allowedEffects: requiredEffects(body.allowedEffects),
      ...(constraints ? { targetConstraints: {
        ...(constraints.origins ? { origins: requiredStringArray(constraints.origins, "targetConstraints.origins") } : {}),
        ...(constraints.bundleIds ? { bundleIds: requiredStringArray(constraints.bundleIds, "targetConstraints.bundleIds") } : {}),
      } } : {}),
      ...(body.expiresAt === undefined ? {} : { expiresAt: requiredString(body.expiresAt, "expiresAt") }),
    });
  }));
  router.delete("/grants/:grantId", ...admin, handle(options.runtime, (req) => {
    const grantId = pathParam(req.params.grantId, "grantId");
    options.runtime.revokeGrant(principal(req), grantId);
    return { revoked: true, grantId };
  }));
  router.get("/events", ...discover, (req, res) => streamEvents(options.runtime, req, res));
  return router;
}

function handle(
  runtime: CapabilityRuntime,
  handler: (req: Request, res: Response) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res) => {
    Promise.resolve().then(() => handler(req, res)).then((data) => {
      if (!res.headersSent) res.json(success(data, requestId(req), runtime.registry.revision));
    }).catch((error) => {
      if (res.headersSent) return res.end();
      const normalized = normalizeCapabilityError(error);
      res.status(normalized.httpStatus).json(capabilityErrorEnvelope(normalized, requestId(req)));
    });
  };
}

function principalMiddleware(resolve: (req: Request) => CapabilityPrincipal): RequestHandler {
  return (req, res, next: NextFunction) => {
    try {
      res.locals.capabilityPrincipal = resolve(req);
      next();
    } catch (error) {
      const normalized = normalizeCapabilityError(error);
      res.status(normalized.httpStatus).json(capabilityErrorEnvelope(normalized, requestId(req)));
    }
  };
}

function streamEvents(runtime: CapabilityRuntime, req: Request, res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  let waitingDrain = false;
  let closed = false;
  const queue: CapabilityEvent[] = [];
  const write = (event: CapabilityEvent) => {
    if (closed) return;
    const accepted = res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    waitingDrain = !accepted;
  };
  const flush = () => {
    waitingDrain = false;
    while (!waitingDrain && queue.length > 0) write(queue.shift()!);
  };
  const publish = (event: CapabilityEvent) => {
    if (!waitingDrain && queue.length === 0) {
      write(event);
      return;
    }
    queue.push(event);
    if (queue.length > SSE_QUEUE_LIMIT) {
      res.write(`event: resync\ndata: ${JSON.stringify({ reason: "slow_consumer" })}\n\n`);
      res.end();
    }
  };
  const unsubscribe = runtime.events.subscribe(publish);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  res.on("drain", flush);
  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
  if (req.header("last-event-id")) {
    res.write(`event: resync\ndata: ${JSON.stringify({ reason: "history_not_retained" })}\n\n`);
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify({
    catalogRevision: runtime.registry.revision,
    providers: runtime.supervisor.list(),
  })}\n\n`);
}

function success(data: unknown, requestIdValue: string, catalogRevision: number) {
  return { data, meta: { requestId: requestIdValue, catalogRevision } };
}

function requestId(req: Request): string {
  return String(req.res?.locals.requestId ?? "unknown");
}

function principal(req: Request): CapabilityPrincipal {
  const value = req.res?.locals.capabilityPrincipal as CapabilityPrincipal | undefined;
  if (!value) throw new CapabilityError("policy_denied", "Capability principal is unavailable.");
  return value;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("invalid_arguments", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("invalid_arguments", "Expected a JSON object.");
  }
  return jsonValue(value) as JsonObject;
}

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    throw new CapabilityError("invalid_arguments", "Value must be JSON serializable.");
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilityError("invalid_arguments", `${field} must be a non-empty string.`);
  }
  return value;
}

function pathParam(value: string | string[], field: string): string {
  return requiredString(Array.isArray(value) ? value[0] : value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CapabilityError("invalid_arguments", `${field} must be an array of strings.`);
  }
  return value;
}

function requiredStringArray(value: unknown, field: string): string[] {
  const parsed = optionalStringArray(value, field);
  if (!parsed || parsed.length === 0) {
    throw new CapabilityError("invalid_arguments", `${field} must be a non-empty array of strings.`);
  }
  return parsed;
}

function requiredEffects(value: unknown): Array<"readOnly" | "mutation" | "destructive" | "openWorld"> {
  const effects = requiredStringArray(value, "allowedEffects");
  const allowed = new Set(["readOnly", "mutation", "destructive", "openWorld"]);
  if (effects.some((effect) => !allowed.has(effect))) {
    throw new CapabilityError("invalid_arguments", "allowedEffects contains an unsupported effect.");
  }
  return effects as Array<"readOnly" | "mutation" | "destructive" | "openWorld">;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new CapabilityError("invalid_arguments", `${field} must be an integer.`);
  return value as number;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CapabilityError("invalid_arguments", `${field} must be a boolean.`);
  return value;
}

function optionalEnum<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new CapabilityError("invalid_arguments", `${field} has an unsupported value.`);
  }
  return value as T[number];
}

function stringQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : String(value);
}

function integerQuery(value: unknown): number | undefined {
  const text = stringQuery(value);
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new CapabilityError("invalid_arguments", "limit must be an integer.");
  return Number(text);
}

function booleanQuery(value: unknown): boolean | undefined {
  const text = stringQuery(value);
  if (text === undefined) return undefined;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new CapabilityError("invalid_arguments", "availableOnly must be boolean.");
}

function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
}
