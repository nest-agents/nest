// ProjectDO: the authority for the accepted head and the current context. Small and relational:
// every change is a compare-and-swap inside one storage transaction, with no network in between.

import { DurableObject } from "cloudflare:workers";
import { digestOf } from "./protocol";
import type { Head } from "./domain/accept";

/** Machine-readable block from a context item. Concrete so it crosses Workers RPC with exact types. */
export type PolicyBlock = { columns?: string[]; agentReviewers?: number; minConfidence?: number; protectedPaths?: string[] };

export type ContextItem = {
  id: string;
  version: number;
  kind: string;
  title: string;
  owner: string;
  body: string;
  policy: PolicyBlock | null;
  commit: string;
  path: string;
};

export type Checkpoint = Head & { candidate: string | null; reason: string; createdAt: string };

export class ProjectError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

export class ProjectDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints(version INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, commit_sha TEXT NOT NULL,
        context_digest TEXT NOT NULL, policy_digest TEXT NOT NULL, candidate TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_items(id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        owner TEXT NOT NULL, body TEXT NOT NULL, policy TEXT, commit_sha TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }

  private current(): ContextItem[] {
    return this.sql
      .exec<Record<string, string | number | null>>(
        `SELECT c.* FROM context_items c JOIN (SELECT id, MAX(version) v FROM context_items GROUP BY id) m ON c.id = m.id AND c.version = m.v ORDER BY c.id`,
      )
      .toArray()
      .map(rowToItem);
  }

  private async digests(items: ContextItem[]) {
    const contextDigest = await digestOf(items.map((i) => [i.id, i.version]));
    const routing = items.find((i) => i.id === "policy/review-routing");
    const columns = items.find((i) => i.id === "req/export-columns");
    const policyDigest = await digestOf({ harness: "harbor-checks/1", routing: routing?.version ?? 0, columns: columns?.version ?? 0 });
    return { contextDigest, policyDigest };
  }

  head(): Checkpoint | null {
    const r = this.sql.exec<Record<string, string | number | null>>("SELECT * FROM checkpoints ORDER BY version DESC LIMIT 1").toArray()[0];
    return r ? rowToCheckpoint(r) : null;
  }

  checkpoints(): Checkpoint[] {
    return this.sql.exec<Record<string, string | number | null>>("SELECT * FROM checkpoints ORDER BY version").toArray().map(rowToCheckpoint);
  }

  context(): ContextItem[] {
    return this.current();
  }

  contextVersion(id: string, version: number): ContextItem | null {
    const r = this.sql.exec<Record<string, string | number | null>>("SELECT * FROM context_items WHERE id = ? AND version = ?", id, version).toArray()[0];
    return r ? rowToItem(r) : null;
  }

  contextHistory(id: string): ContextItem[] {
    return this.sql.exec<Record<string, string | number | null>>("SELECT * FROM context_items WHERE id = ? ORDER BY version", id).toArray().map(rowToItem);
  }

  /**
   * Notes compound context without changing the accepted requirement set: rejected approaches with the
   * reason they lost, and review findings that held up. Every later pack carries them.
   */
  addNote(note: { id: string; kind: "rejected" | "finding"; title: string; body: string; source: string }): void {
    this.sql.exec("INSERT OR IGNORE INTO notes VALUES (?, ?, ?, ?, ?, ?)", note.id, note.kind, note.title.slice(0, 200), note.body.slice(0, 8000), note.source, new Date().toISOString());
  }

  notes(): { id: string; kind: string; title: string; body: string; source: string; createdAt: string }[] {
    return this.sql.exec<Record<string, string>>("SELECT * FROM notes ORDER BY created_at").toArray().map((r) => ({
      id: String(r.id), kind: String(r.kind), title: String(r.title), body: String(r.body), source: String(r.source), createdAt: String(r.created_at),
    }));
  }

  /** First checkpoint: the seed commit plus the seed context. Idempotent. */
  async bootstrap(commit: string, items: ContextItem[]): Promise<Checkpoint> {
    const existing = this.head();
    if (existing) return existing;
    const now = new Date().toISOString();
    const { contextDigest, policyDigest } = await this.digests(items);
    this.ctx.storage.transactionSync(() => {
      for (const i of items) insertItem(this.sql, i, now);
      this.sql.exec(
        "INSERT INTO checkpoints VALUES (1, ?, ?, ?, ?, NULL, ?, ?)",
        "cp-1", commit, contextDigest, policyDigest, "Seed checkpoint", now,
      );
    });
    return this.head()!;
  }

  /**
   * A person accepts a new version of a context item. This creates a context-only checkpoint on the
   * same code commit. Existing work keeps its original citations; staleness is computed, not rewritten.
   */
  async acceptContext(expectedVersion: number, item: ContextItem): Promise<{ checkpoint: Checkpoint; previous: ContextItem | null }> {
    const head = this.head();
    if (!head) throw new ProjectError("NOT_BOOTSTRAPPED");
    if (head.version !== expectedVersion) throw new ProjectError("BASELINE_MOVED");
    const previous = this.current().find((i) => i.id === item.id) ?? null;
    if (previous && item.version !== previous.version + 1) throw new ProjectError("VERSION_GAP", `expected version ${previous.version + 1}`);
    const next = [...this.current().filter((i) => i.id !== item.id), item];
    const { contextDigest, policyDigest } = await this.digests(next);
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const again = this.head()!;
      if (again.version !== expectedVersion) throw new ProjectError("BASELINE_MOVED");
      insertItem(this.sql, item, now);
      this.sql.exec(
        "INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
        again.version + 1, `cp-${again.version + 1}`, again.commit, contextDigest, policyDigest,
        `Accepted ${item.id} version ${item.version}`, now,
      );
    });
    return { checkpoint: this.head()!, previous };
  }

  /** Advance the head to an accepted candidate's commit. The caller has already verified readiness. */
  advance(expected: { version: number; contextDigest: string; policyDigest: string }, commit: string, candidate: string, reason: string): Checkpoint {
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const head = this.head();
      if (!head) throw new ProjectError("NOT_BOOTSTRAPPED");
      if (head.version !== expected.version) throw new ProjectError("BASELINE_MOVED");
      if (head.contextDigest !== expected.contextDigest || head.policyDigest !== expected.policyDigest) throw new ProjectError("CONTEXT_MOVED");
      this.sql.exec(
        "INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        head.version + 1, `cp-${head.version + 1}`, commit, head.contextDigest, head.policyDigest, candidate, reason, now,
      );
    });
    return this.head()!;
  }
}

function insertItem(sql: SqlStorage, i: ContextItem, now: string) {
  sql.exec(
    "INSERT OR IGNORE INTO context_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    i.id, i.version, i.kind, i.title, i.owner, i.body, i.policy ? JSON.stringify(i.policy) : null, i.commit, i.path, now,
  );
}

function rowToItem(r: Record<string, string | number | null>): ContextItem {
  return {
    id: String(r.id), version: Number(r.version), kind: String(r.kind), title: String(r.title), owner: String(r.owner),
    body: String(r.body), policy: r.policy ? JSON.parse(String(r.policy)) : null, commit: String(r.commit_sha), path: String(r.path),
  };
}

function rowToCheckpoint(r: Record<string, string | number | null>): Checkpoint {
  return {
    version: Number(r.version), checkpointId: String(r.id), commit: String(r.commit_sha), contextDigest: String(r.context_digest),
    policyDigest: String(r.policy_digest), candidate: r.candidate ? String(r.candidate) : null, reason: String(r.reason), createdAt: String(r.created_at),
  };
}
