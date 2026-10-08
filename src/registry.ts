// Registry: the one place that knows every project, every objective in it, every participant (humans and
// agents) and the spend ledger. One instance for the whole deployment, so the spend cap covers all work.

import { DurableObject } from "cloudflare:workers";

type Row = Record<string, SqlStorageValue>;

export type ParticipantKind = "person" | "agent";
export type Participant = { id: string; kind: ParticipantKind; name: string; family: string; model: string; harness: string };

export type ProjectRecord = {
  id: string;
  name: string;
  description: string;
  repo: string;
  contextRepo: string;
  createdAt: string;
};

export type ObjectiveRecord = { id: string; project: string; title: string; createdAt: string };

export class RegistryError extends Error {
  // Durable Object RPC keeps only the message, so the code leads it.
  constructor(readonly code: string, message = code) {
    super(message === code ? code : `${code}: ${message}`);
  }
}

export const PROJECT_ID = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const OBJECTIVE_ID = /^[a-z][a-z0-9-]{1,46}[a-z0-9]$/;

export class RegistryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, repo TEXT NOT NULL, context_repo TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objectives(id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, family TEXT NOT NULL, model TEXT NOT NULL, harness TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS spend(id TEXT PRIMARY KEY, objective TEXT, task TEXT, model TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, state TEXT NOT NULL, at TEXT NOT NULL);
    `);
  }

  // ---------- projects and objectives ----------

  projects(): ProjectRecord[] {
    return this.sql.exec<Row>("SELECT * FROM projects ORDER BY created_at").toArray().map(toProject);
  }

  project(id: string): ProjectRecord | null {
    const r = this.sql.exec<Row>("SELECT * FROM projects WHERE id = ?", id).toArray()[0];
    return r ? toProject(r) : null;
  }

  addProject(p: Omit<ProjectRecord, "createdAt">): ProjectRecord {
    if (!PROJECT_ID.test(p.id)) throw new RegistryError("INVALID_PROJECT_ID", "lowercase letters, digits and hyphens, 3 to 32 characters");
    if (this.project(p.id)) throw new RegistryError("PROJECT_EXISTS", p.id);
    this.sql.exec("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)", p.id, p.name.slice(0, 80), p.description.slice(0, 600), p.repo, p.contextRepo, new Date().toISOString());
    return this.project(p.id)!;
  }

  objectives(project?: string): ObjectiveRecord[] {
    const rows = project
      ? this.sql.exec<Row>("SELECT * FROM objectives WHERE project = ? ORDER BY created_at DESC", project).toArray()
      : this.sql.exec<Row>("SELECT * FROM objectives ORDER BY created_at DESC").toArray();
    return rows.map(toObjective);
  }

  objective(id: string): ObjectiveRecord | null {
    const r = this.sql.exec<Row>("SELECT * FROM objectives WHERE id = ?", id).toArray()[0];
    return r ? toObjective(r) : null;
  }

  addObjective(o: Omit<ObjectiveRecord, "createdAt">): ObjectiveRecord {
    if (!OBJECTIVE_ID.test(o.id)) throw new RegistryError("INVALID_OBJECTIVE_ID", "lowercase letters, digits and hyphens, 3 to 48 characters");
    if (!this.project(o.project)) throw new RegistryError("NO_SUCH_PROJECT", o.project);
    if (this.objective(o.id)) throw new RegistryError("OBJECTIVE_EXISTS", o.id);
    this.sql.exec("INSERT INTO objectives VALUES (?, ?, ?, ?)", o.id, o.project, o.title.slice(0, 200), new Date().toISOString());
    return this.objective(o.id)!;
  }

  // ---------- participants ----------

  participants(): Participant[] {
    return this.sql.exec<Row>("SELECT * FROM participants ORDER BY kind DESC, id").toArray().map(toParticipant);
  }

  participant(id: string): (Participant & { rev: number }) | null {
    const r = this.sql.exec<Row>("SELECT * FROM participants WHERE id = ?", id).toArray()[0];
    return r ? { ...toParticipant(r), rev: Number(r.rev) } : null;
  }

  /** Identity (kind and model family) is immutable once registered, so reviews can rely on it. */
  upsertParticipant(p: Participant): Participant {
    const prior = this.participant(p.id);
    if (prior && (prior.kind !== p.kind || prior.family !== p.family))
      throw new RegistryError("IDENTITY_IMMUTABLE", `${p.id} is registered as ${prior.kind}/${prior.family}`);
    this.sql.exec(
      "INSERT INTO participants (id, kind, name, family, model, harness) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, model = excluded.model, harness = excluded.harness",
      p.id, p.kind, p.name, p.family, p.model, p.harness,
    );
    return toParticipant(this.sql.exec<Row>("SELECT * FROM participants WHERE id = ?", p.id).one());
  }

  /** Invalidates every token issued to this participant so far. */
  rotateParticipant(id: string): number {
    this.sql.exec("UPDATE participants SET rev = rev + 1 WHERE id = ?", id);
    return this.participant(id)?.rev ?? 0;
  }

  // ---------- spend: one ledger and one cap for the whole deployment ----------

  reserveSpend(id: string, objective: string | null, task: string | null, model: string, microUsd: number, capMicroUsd: number): boolean {
    // An id is honoured once and only while unsettled, so replaying it cannot bypass the cap.
    const existing = this.sql.exec<Row>("SELECT state FROM spend WHERE id = ?", id).toArray()[0];
    if (existing) return existing.state === "reserved";
    if (!Number.isSafeInteger(microUsd) || microUsd <= 0) throw new RegistryError("INVALID_RESERVATION");
    const used = Number(this.sql.exec<{ s: number | null }>("SELECT SUM(COALESCE(actual, reserved)) s FROM spend WHERE state != 'refused'").one().s ?? 0);
    const ok = used + microUsd <= capMicroUsd;
    this.sql.exec("INSERT INTO spend VALUES (?, ?, ?, ?, ?, NULL, ?, ?)", id, objective, task, model, microUsd, ok ? "reserved" : "refused", new Date().toISOString());
    return ok;
  }

  /**
   * Spend recorded somewhere this ledger cannot see (an earlier deployment's own ledger), entered once so
   * the cap still covers it. Idempotent by id.
   */
  carrySpend(id: string, microUsd: number, note: string): boolean {
    if (!/^carry-[a-z0-9-]{1,40}$/.test(id) || !Number.isSafeInteger(microUsd) || microUsd <= 0) throw new RegistryError("INVALID_CARRY");
    if (this.sql.exec<Row>("SELECT 1 FROM spend WHERE id = ?", id).toArray()[0]) return false;
    this.sql.exec("INSERT INTO spend VALUES (?, NULL, NULL, ?, ?, ?, 'settled', ?)", id, note.slice(0, 80), microUsd, microUsd, new Date().toISOString());
    return true;
  }

  settleSpend(id: string, actualMicroUsd: number): void {
    this.sql.exec("UPDATE spend SET actual = ?, state = 'settled' WHERE id = ? AND state = 'reserved'", Math.max(0, Math.round(actualMicroUsd)), id);
  }
  /**
   * The price table was wrong for a model, so every entry of it was too high by the same factor. The
   * entries stay as written; one visible negative entry per objective brings each total to what the
   * right price gives. Once per model, objective and factor.
   */
  correctSpend(model: string, factor: number): { objectives: number; microUsd: number } {
    if (!/^[\w@./-]{2,80}$/.test(model) || !(factor > 0 && factor < 1)) throw new RegistryError("INVALID_CORRECTION", "a model id and a factor strictly between 0 and 1");
    const rows = this.sql.exec<Row>("SELECT objective, SUM(COALESCE(actual, reserved)) s FROM spend WHERE model = ? AND state != 'refused' GROUP BY objective", model).toArray();
    let objectives = 0;
    let microUsd = 0;
    for (const r of rows) {
      const amount = Math.round(Number(r.s) * (1 - factor));
      const id = `correction-${model}-${r.objective ?? "global"}-x${Math.round(factor * 1_000_000)}`;
      if (amount <= 0 || this.sql.exec<Row>("SELECT 1 FROM spend WHERE id = ?", id).toArray()[0]) continue;
      this.sql.exec("INSERT INTO spend VALUES (?, ?, NULL, ?, ?, ?, 'settled', ?)", id, r.objective, `correction:${model}`, -amount, -amount, new Date().toISOString());
      objectives += 1;
      microUsd += amount;
    }
    return { objectives, microUsd };
  }

  spend(objective?: string): { usedMicroUsd: number; capMicroUsd: number; calls: number; byModel: Record<string, number>; objectiveMicroUsd: number } {
    const rows = this.sql.exec<Row>("SELECT model, SUM(COALESCE(actual, reserved)) s, COUNT(*) n FROM spend WHERE state != 'refused' GROUP BY model").toArray();
    const mine = objective
      ? Number(this.sql.exec<{ s: number | null }>("SELECT SUM(COALESCE(actual, reserved)) s FROM spend WHERE state != 'refused' AND objective = ?", objective).one().s ?? 0)
      : 0;
    return {
      usedMicroUsd: rows.reduce((a, r) => a + Number(r.s), 0),
      capMicroUsd: Number(this.env.SPEND_CAP_MICRO_USD),
      calls: rows.reduce((a, r) => a + Number(r.n), 0),
      byModel: Object.fromEntries(rows.map((r) => [String(r.model), Number(r.s)])),
      objectiveMicroUsd: mine,
    };
  }
}

const toProject = (r: Row): ProjectRecord => ({ id: String(r.id), name: String(r.name), description: String(r.description), repo: String(r.repo), contextRepo: String(r.context_repo), createdAt: String(r.created_at) });
const toObjective = (r: Row): ObjectiveRecord => ({ id: String(r.id), project: String(r.project), title: String(r.title), createdAt: String(r.created_at) });
const toParticipant = (r: Row): Participant => ({ id: String(r.id), kind: String(r.kind) as ParticipantKind, name: String(r.name), family: String(r.family), model: String(r.model), harness: String(r.harness) });
