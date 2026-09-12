import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { and, desc, eq } from "drizzle-orm";
import { databasePath, openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  findLatestSession(root: string, mode: WorkspaceMode): WorkspaceSession | undefined;
  supersedeActiveCheckoutSessions(root: string): number;
  touchSession(id: string): void;
  flushTouches?(): Promise<void>;
  close?(): Promise<void>;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;
  private readonly touchWriter: AsyncWorkspaceTouchWriter;

  constructor(stateDir: string, touchFlushIntervalMs = 1_000) {
    this.database = openDatabase(stateDir);
    this.touchWriter = new AsyncWorkspaceTouchWriter(databasePath(stateDir), touchFlushIntervalMs);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  findLatestSession(root: string, mode: WorkspaceMode): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.root, root),
        eq(workspaceSessions.mode, mode),
        eq(workspaceSessions.status, "active"),
      ))
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  supersedeActiveCheckoutSessions(root: string): number {
    return this.database.db
      .update(workspaceSessions)
      .set({ status: "superseded" })
      .where(and(
        eq(workspaceSessions.root, root),
        eq(workspaceSessions.mode, "checkout"),
        eq(workspaceSessions.status, "active"),
      ))
      .run().changes;
  }

  touchSession(id: string): void {
    this.touchWriter.touch(id, new Date().toISOString());
  }

  async flushTouches(): Promise<void> {
    await this.touchWriter.flush();
  }

  async close(): Promise<void> {
    await this.touchWriter.close();
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

interface TouchBatch {
  sequence: number;
  touches: Array<{ id: string; lastUsedAt: string }>;
}

interface TouchBatchResult {
  sequence: number;
  error?: string;
}

class AsyncWorkspaceTouchWriter {
  private readonly worker: Worker;
  private readonly pending = new Map<string, string>();
  private readonly acknowledgements = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;
  private sequence = 0;
  private failure?: Error;
  private closed = false;

  constructor(path: string, private readonly flushIntervalMs: number) {
    if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 0) {
      throw new Error("Workspace touch flush interval must be a non-negative integer.");
    }

    const require = createRequire(import.meta.url);
    const betterSqlitePath = require.resolve("better-sqlite3");
    this.worker = new Worker(WORKSPACE_TOUCH_WORKER_SOURCE, {
      eval: true,
      workerData: { path, betterSqlitePath },
    });
    this.worker.unref();
    this.worker.on("message", (result: TouchBatchResult) => {
      const acknowledgement = this.acknowledgements.get(result.sequence);
      if (!acknowledgement) return;
      this.acknowledgements.delete(result.sequence);
      if (result.error) acknowledgement.reject(new Error(result.error));
      else acknowledgement.resolve();
    });
    this.worker.on("error", (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.fail(new Error(`Workspace touch worker exited with code ${code}.`));
      }
    });
  }

  touch(id: string, lastUsedAt: string): void {
    if (this.closed || this.failure) return;
    this.pending.set(id, lastUsedAt);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.drainPromise || this.closed || this.failure) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.drain();
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    await this.worker.terminate();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      while (this.pending.size > 0) {
        if (this.failure) throw this.failure;
        const touches = Array.from(this.pending, ([id, lastUsedAt]) => ({ id, lastUsedAt }));
        this.pending.clear();
        await this.postBatch(touches);
      }
    })().finally(() => {
      this.drainPromise = undefined;
      if (this.pending.size > 0) this.scheduleFlush();
    });
    return this.drainPromise;
  }

  private postBatch(touches: TouchBatch["touches"]): Promise<void> {
    const sequence = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      this.acknowledgements.set(sequence, { resolve, reject });
      this.worker.postMessage({ sequence, touches } satisfies TouchBatch);
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const acknowledgement of this.acknowledgements.values()) {
      acknowledgement.reject(this.failure);
    }
    this.acknowledgements.clear();
  }
}

const WORKSPACE_TOUCH_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const Database = require(workerData.betterSqlitePath);
  const database = new Database(workerData.path);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  const touch = database.prepare("update workspace_sessions set last_used_at = ? where id = ?");
  const applyTouches = database.transaction((touches) => {
    for (const entry of touches) touch.run(entry.lastUsedAt, entry.id);
  });

  parentPort.on("message", (batch) => {
    try {
      applyTouches(batch.touches);
      parentPort.postMessage({ sequence: batch.sequence });
    } catch (error) {
      parentPort.postMessage({
        sequence: batch.sequence,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
`;
