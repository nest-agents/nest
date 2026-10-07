// ObjectiveDO: coordination for one objective. Tasks and fenced attempts, contributions, reviews,
// the person's inbox, candidate outcomes and a durable event log, with live WebSocket fan-out.

import { DurableObject } from "cloudflare:workers";
import type { Citation, ParticipantKind, Verdict } from "./protocol";
import { closure, planFrontier, type ContributionNode, type ContributionStatus } from "./domain/graph";
import { route, effectivePolicy, type ReviewFact, type ReviewPolicy, type Routing } from "./domain/review";

type Row = Record<string, string | number | null>;

export type Participant = { id: string; kind: ParticipantKind; name: string; family: string; model: string; harness: string };
export type Task = {
  id: string; title: string; brief: string; alternative: string | null; status: string; epoch: number;
  participant: string | null; repo: string | null; baseVersion: number; createdAt: string; pausedNote: string | null; baseCommit: string | null;
};
export type Contribution = {
  id: string; seq: number; task: string | null; epoch: number; author: string; repo: string; commit: string; parent: string;
  title: string; message: string; alternative: string | null; supersedes: string | null; status: ContributionStatus;
  paths: string[]; special: boolean; requires: string[]; declared: string[]; cites: Citation[]; assumes: string[]; createdAt: string;
  flags: string[]; adds: string[];
};
export type Review = {
  id: string; target: string; reviewer: string; kind: ParticipantKind; family: string; verdict: Verdict; confidence: number;
  summary: string; findings: { path?: string; line?: number; text: string; severity?: string; cite?: string }[]; triage: boolean; createdAt: string;
};
export type Candidate = {
  id: string; name: string; baseVersion: number; baseCommit: string; contextDigest: string; policyDigest: string;
  order: string[]; choice: Record<string, string>; status: string; commit: string | null; checks: { id: string; status: string; detail: string; atHead?: string | null }[];
  previewReady: boolean; note: string | null; conflict: string | null; createdAt: string;
};
export type InboxItem = { id: string; kind: string; target: string; reasons: string[]; status: string; createdAt: string; resolution: string | null };
/** `data` is a JSON string so events cross Workers RPC with exact types; parse it where needed. */
export type NestEvent = { seq: number; at: string; svc: string; kind: string; text: string; data: string | null };

export class ObjectiveError extends Error {
  // Durable Object RPC keeps only the message, so the code leads it.
  constructor(readonly code: string, message = code) {
    super(message === code ? code : `${code}: ${message}`);
  }
}

export class ObjectiveDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
  }

  /** Columns added after first deploy: SQLite needs ALTER TABLE for objects created earlier. */
  private migrate(): void {
    const has = (table: string, col: string) => this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some((r) => r.name === col);
    if (!has("contributions", "flags")) this.sql.exec("ALTER TABLE contributions ADD COLUMN flags TEXT NOT NULL DEFAULT '[]'");
    if (!has("contributions", "adds")) this.sql.exec("ALTER TABLE contributions ADD COLUMN adds TEXT NOT NULL DEFAULT '[]'");
    if (!has("tasks", "base_commit")) this.sql.exec("ALTER TABLE tasks ADD COLUMN base_commit TEXT");
  }

  private schema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, svc TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, family TEXT NOT NULL, model TEXT NOT NULL, harness TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL, alternative TEXT, status TEXT NOT NULL,
        epoch INTEGER NOT NULL, participant TEXT, repo TEXT, base_version INTEGER NOT NULL, created_at TEXT NOT NULL, paused_note TEXT, base_commit TEXT);
      CREATE TABLE IF NOT EXISTS attempts(task TEXT NOT NULL, epoch INTEGER NOT NULL, participant TEXT NOT NULL, repo TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, PRIMARY KEY(task, epoch));
      CREATE UNIQUE INDEX IF NOT EXISTS attempts_repo ON attempts(repo);
      CREATE TABLE IF NOT EXISTS contributions(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, task TEXT, epoch INTEGER NOT NULL, author TEXT NOT NULL,
        repo TEXT NOT NULL, commit_sha TEXT NOT NULL, parent TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, alternative TEXT,
        supersedes TEXT, status TEXT NOT NULL, paths TEXT NOT NULL, special INTEGER NOT NULL, declared TEXT NOT NULL, assumes TEXT NOT NULL, created_at TEXT NOT NULL,
        flags TEXT NOT NULL DEFAULT '[]', adds TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS contributions_commit ON contributions(commit_sha);
      CREATE TABLE IF NOT EXISTS deps(contribution TEXT NOT NULL, requires TEXT NOT NULL, PRIMARY KEY(contribution, requires));
      CREATE TABLE IF NOT EXISTS citations(source TEXT NOT NULL, source_kind TEXT NOT NULL, item TEXT NOT NULL, version INTEGER NOT NULL, lines TEXT,
        PRIMARY KEY(source, item, version));
      CREATE INDEX IF NOT EXISTS citations_item ON citations(item, version);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, target TEXT NOT NULL, reviewer TEXT NOT NULL, kind TEXT NOT NULL, family TEXT NOT NULL,
        verdict TEXT NOT NULL, confidence REAL NOT NULL, summary TEXT NOT NULL, findings TEXT NOT NULL, triage INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reviews_target ON reviews(target);
      CREATE TABLE IF NOT EXISTS materializations(commit_sha TEXT PRIMARY KEY, deps TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, name TEXT NOT NULL, base_version INTEGER NOT NULL, base_commit TEXT NOT NULL,
        context_digest TEXT NOT NULL, policy_digest TEXT NOT NULL, order_json TEXT NOT NULL, choice TEXT NOT NULL, status TEXT NOT NULL,
        commit_sha TEXT, checks TEXT NOT NULL, preview_ready INTEGER NOT NULL, note TEXT, conflict TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, reasons TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, resolution TEXT);
      CREATE TABLE IF NOT EXISTS spend(id TEXT PRIMARY KEY, task TEXT, model TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, state TEXT NOT NULL, at TEXT NOT NULL);
    `);
    this.migrate();
  }

  // ---------- events and live fan-out ----------

  private emit(svc: string, kind: string, text: string, data: unknown = null): NestEvent {
    const at = new Date().toISOString();
    const seq = Number(
      this.sql.exec<{ seq: number }>("INSERT INTO events(at, svc, kind, text, data) VALUES (?, ?, ?, ?, ?) RETURNING seq", at, svc, kind, text, data === null ? null : JSON.stringify(data)).one().seq,
    );
    const event: NestEvent = { seq, at, svc, kind, text, data: data === null ? null : JSON.stringify(data) };
    const message = JSON.stringify({ type: "event", event });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch { /* closed sockets are cleaned up by the runtime */ }
    }
    this.env.METRICS?.writeDataPoint({ blobs: [kind, svc], doubles: [1], indexes: [this.meta("objective") ?? "objective"] });
    return event;
  }

  events(after = 0, limit = 200): NestEvent[] {
    return this.sql
      .exec<Row>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, Math.min(limit, 1000))
      .toArray()
      .map((r) => ({ seq: Number(r.seq), at: String(r.at), svc: String(r.svc), kind: String(r.kind), text: String(r.text), data: r.data === null ? null : String(r.data) }));
  }

  /** Public log entry for work done elsewhere (workflows, sandboxes, gateway). */
  log(svc: string, kind: string, text: string, data: unknown = null): NestEvent {
    return this.emit(svc, kind, text, data);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello", lastSeq: this.lastSeq() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    try {
      const m = JSON.parse(message) as { type?: string; after?: number };
      if (m.type === "replay") ws.send(JSON.stringify({ type: "replay", events: this.events(Number(m.after ?? 0)) }));
    } catch { /* ignore malformed client messages */ }
  }

  private lastSeq(): number {
    return Number(this.sql.exec<{ s: number | null }>("SELECT MAX(seq) s FROM events").one().s ?? 0);
  }

  // ---------- objective and participants ----------

  private meta(k: string): string | null {
    const r = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return r ? r.v : null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** Random per initialization; part of workspace names and tokens so a reset invalidates both. */
  generation(): string {
    const g = this.meta("generation");
    if (!g) throw new ObjectiveError("NOT_INITIALIZED");
    return g;
  }

  /** Swarm objectives measure throughput: no reviews or composition are started for their contributions. */
  isSwarm(): boolean {
    return this.meta("mode") === "swarm";
  }

  init(input: { id: string; title: string; criteria: string[]; project: string; policy?: ReviewPolicy; mode?: "swarm" }): { id: string; title: string } {
    if (input.mode) this.setMeta("mode", input.mode);
    if (!this.meta("generation")) this.setMeta("generation", crypto.randomUUID().replaceAll("-", "").slice(0, 8));
    if (!this.meta("objective")) {
      this.setMeta("objective", input.id);
      this.setMeta("title", input.title);
      this.setMeta("criteria", JSON.stringify(input.criteria));
      this.setMeta("project", input.project);
      this.emit("Durable Objects", "objective", `Objective created: ${input.title}`);
    }
    if (input.policy) this.setMeta("policy", JSON.stringify(input.policy));
    return { id: this.meta("objective")!, title: this.meta("title")! };
  }

  private policy(): ReviewPolicy {
    const p = this.meta("policy");
    return effectivePolicy(p ? JSON.parse(p) : null);
  }

  setPolicy(policy: ReviewPolicy) {
    this.setMeta("policy", JSON.stringify(policy));
    for (const c of this.contributions()) this.reroute(c.id);
  }

  upsertParticipant(p: Participant): Participant {
    const prior = this.participant(p.id);
    if (prior && (prior.kind !== p.kind || prior.family !== p.family))
      throw new ObjectiveError("IDENTITY_IMMUTABLE", `${p.id} is registered as ${prior.kind}/${prior.family}`);
    this.sql.exec(
      "INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, family = excluded.family, model = excluded.model, harness = excluded.harness",
      p.id, p.kind, p.name, p.family, p.model, p.harness,
    );
    return p;
  }

  participants(): Participant[] {
    return this.sql.exec<Row>("SELECT * FROM participants ORDER BY kind DESC, id").toArray().map((r) => ({
      id: String(r.id), kind: String(r.kind) as ParticipantKind, name: String(r.name), family: String(r.family), model: String(r.model), harness: String(r.harness),
    }));
  }

  private participant(id: string): Participant | null {
    return this.participants().find((p) => p.id === id) ?? null;
  }

  // ---------- tasks and fenced attempts ----------

  createTask(input: { id: string; title: string; brief: string; alternative?: string | null; baseVersion: number; baseCommit?: string | null }): Task {
    const existing = this.task(input.id);
    if (existing) return existing;
    if (input.baseCommit && !/^[0-9a-f]{40}$/.test(input.baseCommit)) throw new ObjectiveError("INVALID_BASE");
    if (input.baseCommit && !this.sql.exec<Row>("SELECT 1 FROM materializations WHERE commit_sha = ?", input.baseCommit).toArray()[0])
      throw new ObjectiveError("INVALID_BASE", "a repair must start from a Nest-composed outcome");
    this.sql.exec(
      "INSERT INTO tasks VALUES (?, ?, ?, ?, 'open', 0, NULL, NULL, ?, ?, NULL, ?)",
      input.id, input.title, input.brief, input.alternative ?? null, input.baseVersion, new Date().toISOString(), input.baseCommit ?? null,
    );
    this.emit("Durable Objects", "task", `Task opened: ${input.title}`, { task: input.id });
    return this.task(input.id)!;
  }

  task(id: string): Task | null {
    const r = this.sql.exec<Row>("SELECT * FROM tasks WHERE id = ?", id).toArray()[0];
    return r ? rowToTask(r) : null;
  }

  tasks(): Task[] {
    return this.sql.exec<Row>("SELECT * FROM tasks ORDER BY created_at").toArray().map(rowToTask);
  }

  /** Starts attempt epoch+1 for a participant. The previous attempt is fenced by the epoch change. */
  startAttempt(taskId: string, participantId: string, expectedEpoch: number, repo: string): Task {
    const t = this.task(taskId);
    if (!t) throw new ObjectiveError("NOT_FOUND");
    if (t.epoch !== expectedEpoch) throw new ObjectiveError("STALE_EPOCH", `task is at epoch ${t.epoch}`);
    if (t.status === "running") throw new ObjectiveError("ALREADY_RUNNING");
    const epoch = t.epoch + 1;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE attempts SET ended_at = COALESCE(ended_at, ?), outcome = COALESCE(outcome, 'fenced') WHERE task = ?", now, taskId);
      this.sql.exec("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, NULL, NULL)", taskId, epoch, participantId, repo, now);
      this.sql.exec("UPDATE tasks SET status = 'running', epoch = ?, participant = ?, repo = ?, paused_note = NULL WHERE id = ?", epoch, participantId, repo, taskId);
    });
    const p = this.participant(participantId);
    this.emit("Durable Objects", "attempt", `${p?.name ?? participantId} started attempt ${epoch} of ${t.title}`, { task: taskId, epoch, participant: participantId, repo });
    return this.task(taskId)!;
  }

  /** Fences the running attempt and records a portable note for whoever resumes. */
  pause(taskId: string, expectedEpoch: number, note: string): Task {
    const t = this.task(taskId);
    if (!t) throw new ObjectiveError("NOT_FOUND");
    if (t.epoch !== expectedEpoch || t.status !== "running") throw new ObjectiveError("STALE_EPOCH");
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE attempts SET ended_at = ?, outcome = 'paused' WHERE task = ? AND epoch = ?", now, taskId, expectedEpoch);
      this.sql.exec("UPDATE tasks SET status = 'paused', paused_note = ? WHERE id = ?", note.slice(0, 8000), taskId);
    });
    this.emit("Durable Objects", "pause", `Paused ${t.title} at a tool boundary. Attempt ${expectedEpoch} is fenced`, { task: taskId, epoch: expectedEpoch });
    return this.task(taskId)!;
  }

  /** Contributions registered by one attempt, however they were published. */
  attemptContributions(taskId: string, epoch: number): number {
    return Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM contributions WHERE task = ? AND epoch = ?", taskId, epoch).one().n);
  }

  /** True while any repair task is running, so automatic repairs never stack. */
  repairRunning(): boolean {
    return !!this.sql.exec<Row>("SELECT 1 FROM tasks WHERE id LIKE 't_repair-%' AND status = 'running' LIMIT 1").toArray()[0];
  }

  finishAttempt(taskId: string, epoch: number, outcome: "done" | "failed", detail: string): Task {
    const t = this.task(taskId);
    if (!t) throw new ObjectiveError("NOT_FOUND");
    if (t.epoch !== epoch) return t; // a fenced attempt cannot change the task
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE attempts SET ended_at = ?, outcome = ? WHERE task = ? AND epoch = ?", new Date().toISOString(), outcome, taskId, epoch);
      this.sql.exec("UPDATE tasks SET status = ? WHERE id = ?", outcome, taskId);
    });
    this.emit("Durable Objects", "attempt-end", `${t.title}: attempt ${epoch} ${outcome}. ${detail}`.slice(0, 400), { task: taskId, epoch, outcome });
    return this.task(taskId)!;
  }

  attemptForRepo(repo: string): { task: string; epoch: number; participant: string; current: boolean } | null {
    const r = this.sql.exec<Row>("SELECT a.task, a.epoch, a.participant, t.epoch AS cur, t.status FROM attempts a JOIN tasks t ON t.id = a.task WHERE a.repo = ?", repo).toArray()[0];
    if (!r) return null;
    return { task: String(r.task), epoch: Number(r.epoch), participant: String(r.participant), current: Number(r.cur) === Number(r.epoch) && String(r.status) === "running" };
  }

  /** Registered contributions with their creation times, for throughput measurement. */
  registrations(): { id: string; task: string | null; createdAt: string }[] {
    return this.sql.exec<Row>("SELECT id, task, created_at FROM contributions ORDER BY seq").toArray()
      .map((r) => ({ id: String(r.id), task: r.task ? String(r.task) : null, createdAt: String(r.created_at) }));
  }

  attempts(taskId: string) {
    return this.sql.exec<Row>("SELECT * FROM attempts WHERE task = ? ORDER BY epoch", taskId).toArray();
  }

  // ---------- contributions ----------

  authoringIndex(): { byCommit: { commit: string; id: string; requires: string[] }[]; materializations: { commit: string; deps: string[] }[] } {
    const byCommit = this.contributions().map((c) => ({ commit: c.commit, id: c.id, requires: c.requires }));
    const materializations = this.sql.exec<Row>("SELECT * FROM materializations").toArray().map((r) => ({ commit: String(r.commit_sha), deps: JSON.parse(String(r.deps)) as string[] }));
    return { byCommit, materializations };
  }

  recordMaterialization(commit: string, deps: string[]) {
    this.sql.exec("INSERT OR IGNORE INTO materializations VALUES (?, ?)", commit, JSON.stringify([...deps].sort()));
  }

  registerContribution(c: Omit<Contribution, "seq" | "status" | "createdAt" | "flags">): { contribution: Contribution; created: boolean } {
    const prior = this.contribution(c.id);
    if (prior) return { contribution: prior, created: false };
    // Re-check the attempt here: a pause between the caller's check and this call must still fence.
    const attempt = this.sql.exec<Row>(
      "SELECT a.participant, a.repo, t.epoch AS cur, t.status FROM attempts a JOIN tasks t ON t.id = a.task WHERE a.task = ? AND a.epoch = ?",
      c.task, c.epoch,
    ).toArray()[0];
    if (!attempt) throw new ObjectiveError("NOT_FOUND", `no attempt ${c.task}/e${c.epoch}`);
    if (Number(attempt.cur) !== c.epoch || String(attempt.status) !== "running") throw new ObjectiveError("STALE_EPOCH", `attempt ${c.epoch} is fenced`);
    if (String(attempt.repo) !== c.repo || String(attempt.participant) !== c.author) throw new ObjectiveError("ATTEMPT_MISMATCH");
    for (const d of c.requires) if (!this.contribution(d)) throw new ObjectiveError("MISSING_DEPENDENCY", d);
    if (c.supersedes) {
      // Superseding retires work, so it is only for your own unaccepted work. To replace someone else's
      // work, publish an alternative and let the person choose.
      const old = this.contribution(c.supersedes);
      if (!old) throw new ObjectiveError("MISSING_DEPENDENCY", c.supersedes);
      if (old.author !== c.author) throw new ObjectiveError("NOT_YOUR_CONTRIBUTION", `${c.supersedes} belongs to ${old.author}; publish an alternative instead`);
      if (old.status === "accepted") throw new ObjectiveError("ALREADY_ACCEPTED", c.supersedes);
    }
    const seq = Number(this.sql.exec<{ n: number | null }>("SELECT MAX(seq) n FROM contributions").one().n ?? 0) + 1;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO contributions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, '[]', ?)",
        c.id, seq, c.task, c.epoch, c.author, c.repo, c.commit, c.parent, c.title, c.message, c.alternative, c.supersedes,
        JSON.stringify(c.paths), c.special ? 1 : 0, JSON.stringify(c.declared), JSON.stringify(c.assumes), now, JSON.stringify(c.adds ?? []),
      );
      for (const d of c.requires) this.sql.exec("INSERT OR IGNORE INTO deps VALUES (?, ?)", c.id, d);
      for (const cite of c.cites)
        this.sql.exec("INSERT OR IGNORE INTO citations VALUES (?, 'contribution', ?, ?, ?)", c.id, cite.item, cite.version, cite.lines ? JSON.stringify(cite.lines) : null);
      if (c.supersedes) this.sql.exec("UPDATE contributions SET status = 'superseded' WHERE id = ? AND author = ? AND status != 'accepted'", c.supersedes, c.author);
    });
    const who = this.participant(c.author);
    this.emit("Artifacts", "contribution", `${who?.name ?? c.author} pushed ${c.id.slice(2, 6)} ${c.title}`, { contribution: c.id, repo: c.repo, commit: c.commit });
    return { contribution: this.contribution(c.id)!, created: true };
  }

  /** A deterministic concern that no agent review can clear: only a person settles it. */
  flagContribution(id: string, reason: string): void {
    const c = this.contribution(id);
    if (!c) throw new ObjectiveError("NOT_FOUND");
    const flags = [...new Set([...c.flags, reason])];
    this.sql.exec("UPDATE contributions SET flags = ? WHERE id = ?", JSON.stringify(flags), id);
    this.emit("Nest", "flag", `${c.title}: ${reason}`, { contribution: id });
    this.reroute(id);
  }

  /** Check results for an accepted checkpoint under a context version: what "not broken" means for outcomes on it. */
  baseline(key: string): { id: string; status: string; detail: string }[] | null {
    const v = this.meta(`baseline:${key}`);
    return v ? JSON.parse(v) : null;
  }

  setBaseline(key: string, checks: { id: string; status: string; detail: string }[]): void {
    this.setMeta(`baseline:${key}`, JSON.stringify(checks));
  }

  /** Backfill for contributions registered before Nest recorded which files they create. */
  setAdds(id: string, adds: string[]): void {
    this.sql.exec("UPDATE contributions SET adds = ? WHERE id = ?", JSON.stringify([...adds].sort()), id);
  }

  contribution(id: string): Contribution | null {
    const r = this.sql.exec<Row>("SELECT * FROM contributions WHERE id = ?", id).toArray()[0];
    return r ? this.rowToContribution(r) : null;
  }

  contributions(): Contribution[] {
    return this.sql.exec<Row>("SELECT * FROM contributions ORDER BY seq").toArray().map((r) => this.rowToContribution(r));
  }

  private rowToContribution(r: Row): Contribution {
    const id = String(r.id);
    return {
      id, seq: Number(r.seq), task: r.task ? String(r.task) : null, epoch: Number(r.epoch), author: String(r.author), repo: String(r.repo),
      commit: String(r.commit_sha), parent: String(r.parent), title: String(r.title), message: String(r.message),
      alternative: r.alternative ? String(r.alternative) : null, supersedes: r.supersedes ? String(r.supersedes) : null,
      status: String(r.status) as ContributionStatus, paths: JSON.parse(String(r.paths)), special: Number(r.special) === 1,
      requires: this.sql.exec<{ requires: string }>("SELECT requires FROM deps WHERE contribution = ? ORDER BY requires", id).toArray().map((x) => x.requires),
      declared: JSON.parse(String(r.declared)),
      cites: this.sql.exec<Row>("SELECT * FROM citations WHERE source = ? AND source_kind = 'contribution' ORDER BY item", id).toArray()
        .map((x) => ({ item: String(x.item), version: Number(x.version), ...(x.lines ? { lines: JSON.parse(String(x.lines)) as [number, number] } : {}) })),
      assumes: JSON.parse(String(r.assumes)), createdAt: String(r.created_at), flags: JSON.parse(String(r.flags ?? "[]")), adds: JSON.parse(String(r.adds ?? "[]")),
    };
  }

  // ---------- reviews and routing ----------

  /**
   * The reviewer must be a registered participant. Kind and family come from the registry, never
   * from the caller, so a review cannot claim to be a person's or another model family's.
   */
  addReview(input: Omit<Review, "createdAt" | "kind" | "family">, cites: Citation[] = []): { review: Review; routing: Routing } {
    const target = this.contribution(input.target);
    if (!target) throw new ObjectiveError("NOT_FOUND", `no contribution ${input.target}`);
    const reviewer = this.participant(input.reviewer);
    if (!reviewer) throw new ObjectiveError("UNKNOWN_REVIEWER", input.reviewer);
    if (input.triage && reviewer.harness !== "triage") throw new ObjectiveError("NOT_TRIAGE", input.reviewer);
    if (!["approve", "changes", "block", "comment"].includes(input.verdict)) throw new ObjectiveError("INVALID_VERDICT");
    const r: Omit<Review, "createdAt"> = { ...input, kind: reviewer.kind, family: reviewer.family, confidence: Number.isFinite(input.confidence) ? input.confidence : 0 };
    const existing = this.sql.exec<Row>("SELECT id FROM reviews WHERE id = ?", r.id).toArray()[0];
    if (!existing) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          r.id, r.target, r.reviewer, r.kind, r.family, r.verdict, r.confidence, r.summary.slice(0, 4000), JSON.stringify(r.findings.slice(0, 40)), r.triage ? 1 : 0, new Date().toISOString(),
        );
        for (const cite of cites) this.sql.exec("INSERT OR IGNORE INTO citations VALUES (?, 'review', ?, ?, ?)", r.id, cite.item, cite.version, cite.lines ? JSON.stringify(cite.lines) : null);
      });
      const who = this.participant(r.reviewer);
      const verb = r.triage ? "triaged" : { approve: "approved", changes: "requested changes on", block: "blocked", comment: "commented on" }[r.verdict];
      const direct = (this.env.AI_GATEWAY_MODE as string) !== "gateway";
      const svc = r.kind === "person" ? "Nest" : r.family === "workers-ai" ? "Workers AI" : direct ? (r.family === "openai" ? "OpenAI" : "OpenRouter") : "AI Gateway";
      this.emit(svc, "review", `${who?.name ?? r.reviewer} ${verb} ${r.target.slice(2, 6)}`, { review: r.id, target: r.target, verdict: r.verdict });
    }
    return { review: this.reviews(r.target).find((x) => x.id === r.id)!, routing: this.reroute(r.target) };
  }

  reviews(target?: string): Review[] {
    const rows = target
      ? this.sql.exec<Row>("SELECT * FROM reviews WHERE target = ? ORDER BY created_at", target).toArray()
      : this.sql.exec<Row>("SELECT * FROM reviews ORDER BY created_at").toArray();
    return rows.map((r) => ({
      id: String(r.id), target: String(r.target), reviewer: String(r.reviewer), kind: String(r.kind) as ParticipantKind, family: String(r.family),
      verdict: String(r.verdict) as Verdict, confidence: Number(r.confidence), summary: String(r.summary), findings: JSON.parse(String(r.findings)),
      triage: Number(r.triage) === 1, createdAt: String(r.created_at),
    }));
  }

  routing(contributionId: string): Routing {
    const c = this.contribution(contributionId);
    if (!c) throw new ObjectiveError("NOT_FOUND");
    const author = this.participant(c.author);
    const facts: ReviewFact[] = this.reviews(c.id).map((r) => ({ reviewer: r.reviewer, kind: r.kind, family: r.family, verdict: r.verdict, confidence: r.confidence, triage: r.triage }));
    return route(this.policy(), {
      author: c.author, authorKind: author?.kind ?? "agent", authorFamily: author?.family ?? "unknown",
      paths: c.paths.map((p) => (typeof p === "string" ? p : (p as { path: string }).path)), citedItems: c.cites.map((x) => x.item), specialEntries: c.special,
      flags: c.flags,
    }, facts);
  }

  /** Recomputes a contribution's status from its reviews and keeps the inbox in step. */
  private reroute(contributionId: string): Routing {
    const c = this.contribution(contributionId);
    if (!c) throw new ObjectiveError("NOT_FOUND");
    const routing = this.routing(contributionId);
    if (c.status === "superseded" || c.status === "accepted") return routing;
    const status: ContributionStatus =
      routing.state === "approved" ? "approved" : routing.state === "changes" ? "changes" : routing.state === "blocked" ? "blocked" : "proposed";
    if (status !== c.status) this.sql.exec("UPDATE contributions SET status = ? WHERE id = ?", status, contributionId);
    const inboxId = `review-${contributionId}`;
    if (routing.state === "needs-human") {
      const open = this.sql.exec<Row>("SELECT status FROM inbox WHERE id = ?", inboxId).toArray()[0];
      if (!open) {
        this.sql.exec("INSERT INTO inbox VALUES (?, 'review', ?, ?, 'open', ?, NULL)", inboxId, contributionId, JSON.stringify(routing.reasons), new Date().toISOString());
        this.emit("Durable Objects", "inbox", `${c.title}: ${routing.reasons.join("; ")}. Routed to a person`, { inbox: inboxId, target: contributionId });
      }
    } else if (routing.state === "approved" || routing.state === "changes" || routing.state === "blocked") {
      this.sql.exec("UPDATE inbox SET status = 'resolved', resolution = ? WHERE id = ? AND status = 'open'", routing.state, inboxId);
    }
    return routing;
  }

  openInbox(item: { id: string; kind: string; target: string; reasons: string[] }) {
    this.sql.exec("INSERT OR IGNORE INTO inbox VALUES (?, ?, ?, ?, 'open', ?, NULL)", item.id, item.kind, item.target, JSON.stringify(item.reasons), new Date().toISOString());
    this.emit("Durable Objects", "inbox", item.reasons.join("; "), { inbox: item.id, target: item.target });
  }

  resolveInbox(id: string, resolution: string) {
    this.sql.exec("UPDATE inbox SET status = 'resolved', resolution = ? WHERE id = ?", resolution, id);
  }

  inbox(): InboxItem[] {
    return this.sql.exec<Row>("SELECT * FROM inbox ORDER BY created_at").toArray().map((r) => ({
      id: String(r.id), kind: String(r.kind), target: String(r.target), reasons: JSON.parse(String(r.reasons)), status: String(r.status),
      createdAt: String(r.created_at), resolution: r.resolution ? String(r.resolution) : null,
    }));
  }

  // ---------- citations and blast radius ----------

  citations(): { source: string; kind: string; item: string; version: number }[] {
    return this.sql.exec<Row>("SELECT source, source_kind, item, version FROM citations").toArray()
      .map((r) => ({ source: String(r.source), kind: String(r.source_kind), item: String(r.item), version: Number(r.version) }));
  }

  blastRadius(item: string, newVersion: number) {
    const rows = this.sql.exec<Row>("SELECT DISTINCT source, source_kind FROM citations WHERE item = ? AND version < ?", item, newVersion).toArray();
    const by = (k: string) => rows.filter((r) => r.source_kind === k).map((r) => String(r.source)).sort();
    const contributions = by("contribution");
    const candidates = this.candidates().filter((c) => !["superseded", "accepted"].includes(c.status) && c.order.some((id) => contributions.includes(id))).map((c) => c.id);
    const tasks = this.tasks().filter((t) => t.status === "running").map((t) => t.id);
    return { contributions, reviews: by("review"), candidates, tasks };
  }

  // ---------- candidates ----------

  private graphNodes(): Map<string, ContributionNode> {
    return new Map(this.contributions().map((c) => [c.id, {
      id: c.id, commit: c.commit, requires: c.requires, alternative: c.alternative ?? undefined, supersedes: c.supersedes ?? undefined,
      status: c.status, seq: c.seq, adds: c.adds, task: c.task ?? undefined,
    }]));
  }

  frontier(accepted: string[], limit = 6) {
    const nodes = this.graphNodes();
    return planFrontier(nodes, new Set(accepted), limit);
  }

  closureOf(selected: string[], accepted: string[]): string[] {
    const nodes = this.graphNodes();
    return closure(nodes, selected, new Set(accepted));
  }

  upsertCandidate(c: Omit<Candidate, "createdAt">): Candidate {
    this.sql.exec(
      `INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, commit_sha = excluded.commit_sha, checks = excluded.checks,
         preview_ready = excluded.preview_ready, note = excluded.note, conflict = excluded.conflict`,
      c.id, c.name, c.baseVersion, c.baseCommit, c.contextDigest, c.policyDigest, JSON.stringify(c.order), JSON.stringify(c.choice), c.status,
      c.commit, JSON.stringify(c.checks), c.previewReady ? 1 : 0, c.note, c.conflict, new Date().toISOString(),
    );
    return this.candidate(c.id)!;
  }

  updateCandidate(id: string, patch: Partial<Pick<Candidate, "status" | "commit" | "checks" | "previewReady" | "note" | "conflict">>, log?: { svc: string; text: string }): Candidate {
    const c = this.candidate(id);
    if (!c) throw new ObjectiveError("NOT_FOUND");
    const next = { ...c, ...patch };
    this.upsertCandidate(next);
    if (log) this.emit(log.svc, "candidate", log.text, { candidate: id, status: next.status });
    return this.candidate(id)!;
  }

  candidate(id: string): Candidate | null {
    const r = this.sql.exec<Row>("SELECT * FROM candidates WHERE id = ?", id).toArray()[0];
    return r ? rowToCandidate(r) : null;
  }

  candidates(): Candidate[] {
    return this.sql.exec<Row>("SELECT * FROM candidates ORDER BY created_at DESC").toArray().map(rowToCandidate);
  }

  /** Called only with the checkpoint the ProjectDO compare-and-swap just produced for this candidate. */
  markAccepted(candidateId: string, checkpoint: { candidate: string | null; version: number }) {
    if (checkpoint.candidate !== candidateId) throw new ObjectiveError("NOT_ACCEPTED", "checkpoint does not name this candidate");
    const c = this.candidate(candidateId);
    if (!c) throw new ObjectiveError("NOT_FOUND");
    const contributionIds = c.order;
    this.ctx.storage.transactionSync(() => {
      for (const id of contributionIds) this.sql.exec("UPDATE contributions SET status = 'accepted' WHERE id = ?", id);
      this.sql.exec("UPDATE candidates SET status = 'accepted' WHERE id = ?", candidateId);
      // Every other outcome was built on the old checkpoint, so none of them can be accepted any more.
      const stale = this.sql.exec<Row>("SELECT id FROM candidates WHERE id != ? AND status NOT IN ('accepted', 'superseded')", candidateId).toArray().map((r) => String(r.id));
      this.sql.exec("UPDATE candidates SET status = 'superseded' WHERE id != ? AND status NOT IN ('accepted', 'superseded')", candidateId);
      for (const id of [candidateId, ...stale]) this.sql.exec("UPDATE inbox SET status = 'resolved', resolution = 'accepted' WHERE target = ? AND status = 'open'", id);
    });
    // Work that can never apply is retired with its reason: approaches the person turned down, and work
    // that creates a file the checkpoint now has from someone else. Questions about it leave the inbox.
    const all = this.contributions();
    const owner = new Map<string, string>();
    const chosen = new Map<string, string | null>();
    for (const x of all) if (x.status === "accepted") {
      for (const p of x.adds) owner.set(p, x.id);
      if (x.alternative) chosen.set(x.alternative, x.task);
    }
    const retire = (x: Contribution, reason: string) => {
      this.sql.exec("UPDATE contributions SET status = 'superseded', flags = ? WHERE id = ?", JSON.stringify([...new Set([...x.flags, reason])]), x.id);
      this.sql.exec("UPDATE inbox SET status = 'resolved', resolution = 'retired' WHERE target = ? AND status = 'open'", x.id);
      this.emit("Nest", "retired", `Retired ${x.title} by ${this.participant(x.author)?.name ?? x.author}: ${reason}`, { contribution: x.id });
    };
    for (const x of all) {
      if (["accepted", "superseded", "blocked"].includes(x.status)) continue;
      if (x.alternative && chosen.has(x.alternative) && chosen.get(x.alternative) !== x.task) {
        retire(x, `Its approach in "${x.alternative}" was not chosen at checkpoint ${checkpoint.version}`);
        continue;
      }
      const clash = x.adds.find((p) => owner.has(p));
      if (!clash) continue;
      const by = all.find((y) => y.id === owner.get(clash))!;
      retire(x, `Checkpoint ${checkpoint.version} already has ${clash} from ${this.participant(by.author)?.name ?? by.author}'s ${by.title}`);
    }
    // Ready and conflict questions about outcomes that can no longer be accepted go too.
    this.sql.exec("UPDATE inbox SET status = 'resolved', resolution = 'superseded' WHERE status = 'open' AND kind IN ('accept', 'conflict') AND target IN (SELECT id FROM candidates WHERE status = 'superseded')");
  }

  markCandidatesOutdated(ids: string[]) {
    for (const id of ids) this.sql.exec("UPDATE candidates SET status = 'outdated' WHERE id = ? AND status NOT IN ('accepted', 'superseded')", id);
  }

  // ---------- spend (central counter for every model call) ----------

  reserveSpend(id: string, task: string | null, model: string, microUsd: number, capMicroUsd: number): boolean {
    // An id is honoured once and only while unsettled, so replaying it cannot bypass the cap.
    const existing = this.sql.exec<Row>("SELECT state FROM spend WHERE id = ?", id).toArray()[0];
    if (existing) return existing.state === "reserved";
    if (!Number.isSafeInteger(microUsd) || microUsd <= 0) throw new ObjectiveError("INVALID_RESERVATION");
    const used = Number(this.sql.exec<{ s: number | null }>("SELECT SUM(COALESCE(actual, reserved)) s FROM spend WHERE state != 'refused'").one().s ?? 0);
    const ok = used + microUsd <= capMicroUsd;
    this.sql.exec("INSERT INTO spend VALUES (?, ?, ?, ?, NULL, ?, ?)", id, task, model, microUsd, ok ? "reserved" : "refused", new Date().toISOString());
    if (!ok) this.emit("AI Gateway", "spend", `Refused a ${model} call: the spend cap is reached`, { used, cap: capMicroUsd });
    return ok;
  }

  settleSpend(id: string, actualMicroUsd: number) {
    this.sql.exec("UPDATE spend SET actual = ?, state = 'settled' WHERE id = ? AND state = 'reserved'", Math.max(0, Math.round(actualMicroUsd)), id);
  }

  spend(): { usedMicroUsd: number; calls: number; byModel: Record<string, number> } {
    const rows = this.sql.exec<Row>("SELECT model, SUM(COALESCE(actual, reserved)) s, COUNT(*) n FROM spend WHERE state != 'refused' GROUP BY model").toArray();
    const byModel = Object.fromEntries(rows.map((r) => [String(r.model), Number(r.s)]));
    return { usedMicroUsd: rows.reduce((a, r) => a + Number(r.s), 0), calls: rows.reduce((a, r) => a + Number(r.n), 0), byModel };
  }

  /** Owner-only, for rehearsals: forget all coordination state. Repositories in Artifacts are untouched. */
  /**
   * Owner-only, for rehearsals: forget coordination state. The spend ledger survives, so the cap can
   * never be escaped by resetting. Repositories in Artifacts are untouched.
   */
  async reset(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1012, "objective reset");
    const spend = this.sql.exec<Row>("SELECT * FROM spend").toArray();
    await this.ctx.storage.deleteAll();
    this.schema();
    for (const r of spend) this.sql.exec("INSERT OR IGNORE INTO spend VALUES (?, ?, ?, ?, ?, ?, ?)", r.id, r.task, r.model, r.reserved, r.actual, r.state, r.at);
  }

  // ---------- snapshot ----------

  state() {
    return {
      objective: { id: this.meta("objective"), title: this.meta("title"), criteria: JSON.parse(this.meta("criteria") ?? "[]") as string[], project: this.meta("project") },
      policy: this.policy(),
      participants: this.participants(),
      tasks: this.tasks(),
      contributions: this.contributions(),
      reviews: this.reviews(),
      candidates: this.candidates(),
      inbox: this.inbox(),
      spend: this.spend(),
      lastSeq: this.lastSeq(),
    };
  }
}

function rowToTask(r: Row): Task {
  return {
    id: String(r.id), title: String(r.title), brief: String(r.brief), alternative: r.alternative ? String(r.alternative) : null, status: String(r.status),
    epoch: Number(r.epoch), participant: r.participant ? String(r.participant) : null, repo: r.repo ? String(r.repo) : null,
    baseVersion: Number(r.base_version), createdAt: String(r.created_at), pausedNote: r.paused_note ? String(r.paused_note) : null,
    baseCommit: r.base_commit ? String(r.base_commit) : null,
  };
}

function rowToCandidate(r: Row): Candidate {
  return {
    id: String(r.id), name: String(r.name), baseVersion: Number(r.base_version), baseCommit: String(r.base_commit), contextDigest: String(r.context_digest),
    policyDigest: String(r.policy_digest), order: JSON.parse(String(r.order_json)), choice: JSON.parse(String(r.choice)), status: String(r.status),
    commit: r.commit_sha ? String(r.commit_sha) : null, checks: JSON.parse(String(r.checks)), previewReady: Number(r.preview_ready) === 1,
    note: r.note ? String(r.note) : null, conflict: r.conflict ? String(r.conflict) : null, createdAt: String(r.created_at),
  };
}
