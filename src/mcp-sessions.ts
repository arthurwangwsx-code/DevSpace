export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
  inFlight: number;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
  maxIdleSessions?: number;
  closeConcurrency?: number;
}

export interface McpSessionRegistryStats {
  total: number;
  active: number;
  idle: number;
  reserved: number;
  maxSessions: number;
  maxIdleSessions: number;
}

export interface McpSessionLease<TTransport> {
  transport: TTransport;
  release(): Promise<McpSessionCloseResult[]>;
}

export interface McpSessionReservation<TTransport> {
  commit(sessionId: string, transport: TTransport): McpSessionLease<TTransport>;
  cancel(): void;
}

export interface McpSessionReserveResult<TTransport> {
  reservation?: McpSessionReservation<TTransport>;
  closeResults: McpSessionCloseResult[];
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxIdleSessions: number;
  private readonly closeConcurrency: number;
  private reserved = 0;
  private closed = false;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 256;
    this.maxIdleSessions = options.maxIdleSessions ?? 128;
    this.closeConcurrency = options.closeConcurrency ?? 16;

    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new Error("maxSessions must be a positive integer.");
    }
    if (
      !Number.isInteger(this.maxIdleSessions)
      || this.maxIdleSessions < 1
      || this.maxIdleSessions > this.maxSessions
    ) {
      throw new Error("maxIdleSessions must be a positive integer no greater than maxSessions.");
    }
    if (!Number.isInteger(this.closeConcurrency) || this.closeConcurrency < 1) {
      throw new Error("closeConcurrency must be a positive integer.");
    }
  }

  get stats(): McpSessionRegistryStats {
    let active = 0;
    for (const entry of this.sessions.values()) {
      if (entry.inFlight > 0) active += 1;
    }
    return {
      total: this.sessions.size,
      active,
      idle: this.sessions.size - active,
      reserved: this.reserved,
      maxSessions: this.maxSessions,
      maxIdleSessions: this.maxIdleSessions,
    };
  }

  async reserve(): Promise<McpSessionReserveResult<TTransport>> {
    if (this.closed) return { closeResults: [] };
    const evicted: Array<{ sessionId: string; transport: TTransport }> = [];
    while (this.sessions.size + this.reserved >= this.maxSessions) {
      const oldest = this.takeOldestIdle();
      if (!oldest) break;
      evicted.push(oldest);
    }

    if (this.sessions.size + this.reserved >= this.maxSessions) {
      return {
        closeResults: await closeSessions(evicted, this.closeConcurrency),
      };
    }

    // Reserve synchronously before awaiting transport cleanup so concurrent
    // initialize requests cannot all observe the same free slot.
    this.reserved += 1;
    const closeResults = await closeSessions(evicted, this.closeConcurrency);
    let settled = false;

    return {
      closeResults,
      reservation: {
        commit: (sessionId, transport) => {
          if (settled) throw new Error("MCP session reservation is already settled.");
          if (this.closed) {
            settled = true;
            this.reserved -= 1;
            throw new Error("MCP session registry is closed.");
          }
          if (this.sessions.has(sessionId)) throw new Error(`MCP session already exists: ${sessionId}`);
          settled = true;
          this.reserved -= 1;
          const entry: McpSessionEntry<TTransport> = {
            transport,
            lastActivityAt: this.now(),
            inFlight: 1,
          };
          this.sessions.set(sessionId, entry);
          return this.createLease(sessionId, entry);
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          this.reserved -= 1;
        },
      },
    };
  }

  acquire(sessionId: string): McpSessionLease<TTransport> | undefined {
    if (this.closed) return undefined;
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.inFlight += 1;
    entry.lastActivityAt = this.now();
    return this.createLease(sessionId, entry);
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight > 0 || entry.lastActivityAt > cutoff) continue;
      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions, this.closeConcurrency);
  }

  async closeOldestIdle(maxIdleSessions: number): Promise<McpSessionCloseResult[]> {
    if (!Number.isInteger(maxIdleSessions) || maxIdleSessions < 0) {
      throw new Error("maxIdleSessions must be a non-negative integer.");
    }

    const idle = this.idleEntries();
    const closeCount = Math.max(0, idle.length - maxIdleSessions);
    const closing = idle.slice(0, closeCount);
    for (const { sessionId } of closing) this.sessions.delete(sessionId);
    return closeSessions(closing, this.closeConcurrency);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    this.closed = true;
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    return closeSessions(sessions, this.closeConcurrency);
  }

  private createLease(
    sessionId: string,
    entry: McpSessionEntry<TTransport>,
  ): McpSessionLease<TTransport> {
    let released = false;
    return {
      transport: entry.transport,
      release: async () => {
        if (released) return [];
        released = true;
        const current = this.sessions.get(sessionId);
        if (current !== entry) return [];
        current.inFlight = Math.max(0, current.inFlight - 1);
        current.lastActivityAt = this.now();
        return this.closeOldestIdle(this.maxIdleSessions);
      },
    };
  }

  private takeOldestIdle(): { sessionId: string; transport: TTransport } | undefined {
    const oldest = this.idleEntries()[0];
    if (!oldest) return undefined;
    this.sessions.delete(oldest.sessionId);
    return oldest;
  }

  private idleEntries(): Array<{
    sessionId: string;
    transport: TTransport;
    lastActivityAt: number;
  }> {
    const idle: Array<{
      sessionId: string;
      transport: TTransport;
      lastActivityAt: number;
    }> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight === 0) {
        idle.push({
          sessionId,
          transport: entry.transport,
          lastActivityAt: entry.lastActivityAt,
        });
      }
    }
    idle.sort((left, right) => left.lastActivityAt - right.lastActivityAt);
    return idle;
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
  concurrency: number,
): Promise<McpSessionCloseResult[]> {
  if (sessions.length === 0) return [];
  const results = new Array<McpSessionCloseResult>(sessions.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, sessions.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        const session = sessions[index];
        if (!session) return;
        try {
          await session.transport.close();
          results[index] = { sessionId: session.sessionId };
        } catch (error) {
          results[index] = { sessionId: session.sessionId, error };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
