// Nest Worker: authenticated API, live updates, previews and the MCP endpoint. Durable Objects hold the
// state; Workflows do the long work; containers run agents, composition and previews.

import { ArtifactsClient } from "./artifacts";
import { authenticate, participantToken, type Principal } from "./auth";
import { citeOf, parseContextFile } from "./context";
import { ingestPush } from "./ingest";
import { contextRepo, objectiveStub, OBJECTIVE_ID, projectRepo, projectStub, workspaceRepo } from "./names";
import { buildPack } from "./packs";
import type { ContextItem } from "./project";
import { DEFAULT_POLICY } from "./domain/review";
import { acceptCandidate } from "./accepting";
import { handleMcp } from "./mcp";
import { startTask } from "./tasks";

export { ProjectDO } from "./project";
export { ObjectiveDO } from "./objective";
export { Computer, Outbound } from "./computer";
export { IngestWorkflow } from "./ingest";
export { TaskWorkflow } from "./workflows/task";
export { ReviewWorkflow } from "./workflows/review";
export { ComposeWorkflow } from "./workflows/compose";

export const PEOPLE = [{ id: "you", kind: "person" as const, name: "You", family: "person", model: "-", harness: "human" }];
export const AGENTS = (env: Env) => [
  { id: "wren", kind: "agent" as const, name: "Wren", family: "openai", model: env.AGENT_MODEL_OPENAI, harness: "codex" },
  { id: "kestrel", kind: "agent" as const, name: "Kestrel", family: "anthropic", model: env.AGENT_MODEL_ANTHROPIC, harness: "nest-agent" },
  { id: "heron", kind: "agent" as const, name: "Heron", family: "anthropic", model: env.AGENT_MODEL_ANTHROPIC, harness: "nest-agent" },
  { id: "shrike", kind: "agent" as const, name: "Shrike", family: "openai", model: env.REVIEW_MODEL_OPENAI, harness: "reviewer" },
  { id: "owl", kind: "agent" as const, name: "Owl", family: "anthropic", model: env.REVIEW_MODEL_ANTHROPIC, harness: "reviewer" },
  { id: "plover", kind: "agent" as const, name: "Plover", family: "workers-ai", model: env.REVIEW_MODEL_WORKERS_AI, harness: "reviewer" },
  { id: "triage", kind: "agent" as const, name: "Triage", family: "workers-ai", model: env.REVIEW_MODEL_WORKERS_AI, harness: "triage" },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, code: string, message = code) => json({ error: { code, message } }, status);

async function body<T>(request: Request): Promise<T> {
  try { return (await request.json()) as T; } catch { throw new HttpError(400, "INVALID_JSON"); }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
  }
}

function require(p: Principal, ...kinds: Principal["kind"][]): void {
  if (!kinds.includes(p.kind)) throw new HttpError(p.kind === "viewer" ? 401 : 403, "FORBIDDEN", "This action needs the owner token");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/mcp") return await handleMcp(request, env, ctx);
      if (url.pathname.startsWith("/preview/")) return await preview(request, env, url);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      const principal = await authenticate(env, request);
      if (!principal) return fail(401, "BAD_TOKEN");
      return await api(request, env, url, principal);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.code, e.message);
      const code = (e as { code?: string })?.code;
      if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return fail(409, code, (e as Error).message);
      console.error("nest error", e);
      return fail(500, "INTERNAL", e instanceof Error ? e.message : String(e));
    }
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, url: URL, p: Principal): Promise<Response> {
  const objective = objectiveStub(env);
  const project = projectStub(env);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /api/state") {
    const head = await project.head();
    const checkpoints = await project.checkpoints();
    const context = await project.context();
    const notes = await project.notes();
    const state = await objective.state();
    return json({ head, checkpoints, context, notes, ...state, me: p.kind });
  }
  if (route === "GET /api/live") {
    if (request.headers.get("upgrade") !== "websocket") throw new HttpError(426, "WEBSOCKET_REQUIRED");
    return objective.fetch(request);
  }
  if (route === "GET /api/events") return json(await objective.events(Number(url.searchParams.get("after") ?? 0)));
  if (route === "POST /api/session") {
    require(p, "owner");
    return new Response(null, { status: 204, headers: { "set-cookie": `nest_owner=${encodeURIComponent(env.NEST_OWNER_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` } });
  }

  if (route === "POST /api/admin/reset") {
    require(p, "owner");
    await objective.reset();
    await project.reset();
    return json({ reset: true });
  }

  if (route === "POST /api/admin/bootstrap") {
    require(p, "owner");
    return json(await bootstrap(env));
  }

  if (route === "POST /api/tasks") {
    require(p, "owner");
    const b = await body<{ id: string; title: string; brief: string; alternative?: string | null }>(request);
    if (!/^t_[a-z0-9-]{1,48}$/.test(b.id ?? "")) throw new HttpError(400, "INVALID_TASK_ID");
    const head = await project.head();
    if (!head) throw new HttpError(409, "NOT_BOOTSTRAPPED");
    return json(await objective.createTask({ id: b.id, title: String(b.title).slice(0, 200), brief: String(b.brief).slice(0, 8000), alternative: b.alternative ?? null, baseVersion: head.version }));
  }

  const start = /^\/api\/tasks\/(t_[a-z0-9-]{1,48})\/start$/.exec(url.pathname);
  if (start && request.method === "POST") {
    require(p, "owner");
    const b = await body<{ participant: string; mode?: "agent" | "manual" }>(request);
    return json(await startTask(env, start[1]!, b.participant, b.mode ?? "agent"));
  }

  const pause = /^\/api\/tasks\/(t_[a-z0-9-]{1,48})\/pause$/.exec(url.pathname);
  if (pause && request.method === "POST") {
    require(p, "owner");
    const t = await objective.task(pause[1]!);
    if (!t || t.status !== "running") throw new HttpError(409, "NOT_RUNNING");
    // The running workflow notices the epoch change at its next tool boundary and saves a portable note.
    const instance = await env.TASKS.get(`task-${t.id}-e${t.epoch}`).catch(() => null);
    await instance?.sendEvent({ type: "pause", payload: { epoch: t.epoch } }).catch(() => undefined);
    return json({ requested: true, epoch: t.epoch });
  }

  const stop = /^\/api\/tasks\/(t_[a-z0-9-]{1,48})\/stop$/.exec(url.pathname);
  if (stop && request.method === "POST") {
    require(p, "owner");
    const { stopTask } = await import("./tasks");
    return json(await stopTask(env, stop[1]!));
  }

  if (route === "POST /api/publish") {
    require(p, "owner", "task");
    const b = await body<{ repo: string; commit: string }>(request);
    if (p.kind === "task" && b.repo !== workspaceRepo(p.objective, p.task, p.epoch)) throw new HttpError(403, "NOT_YOUR_WORKSPACE");
    return json(await ingestPush(env, b.repo, b.commit));
  }

  if (route === "GET /api/pack") {
    require(p, "owner", "task");
    const taskId = p.kind === "task" ? p.task : String(url.searchParams.get("task") ?? "");
    return new Response((await buildPack(env, taskId, Number(url.searchParams.get("budget") ?? 200_000))).text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  if (route === "GET /api/search") {
    require(p, "owner", "task");
    const { searchContext } = await import("./packs");
    return json(await searchContext(env, String(url.searchParams.get("q") ?? "").slice(0, 400)));
  }

  if (route === "GET /api/contributions") {
    require(p, "owner", "task");
    const state = await objective.state();
    const names = new Map(state.participants.map((x) => [x.id, x.name]));
    return json(state.contributions.map((c) => ({ id: c.id, title: c.title, author: names.get(c.author) ?? c.author, status: c.status, alternative: c.alternative, paths: c.paths, requires: c.requires })));
  }

  const show = /^\/api\/contributions\/(c_[0-9a-f]{12})$/.exec(url.pathname);
  if (show && request.method === "GET") {
    require(p, "owner", "task");
    const c = await objective.contribution(show[1]!);
    if (!c) throw new HttpError(404, "NOT_FOUND");
    const artifacts = new ArtifactsClient(env.ARTIFACTS);
    const files = [];
    for (const path of c.paths.slice(0, 20)) files.push({ path, content: (await artifacts.readText(c.repo, c.commit, path).catch(() => null)) ?? "(deleted)" });
    return json({ id: c.id, title: c.title, author: c.author, message: c.message, files });
  }

  if (route === "POST /api/note") {
    require(p, "task");
    if (p.kind !== "task") throw new HttpError(403, "FORBIDDEN");
    const t = await objective.task(p.task);
    if (!t || t.epoch !== p.epoch || t.status !== "running") throw new HttpError(409, "STALE_ATTEMPT");
    const b = await body<{ text: string }>(request);
    const who = (await objective.participants()).find((x) => x.id === t.participant)?.name ?? "Agent";
    return json(await objective.log("Agents", "note", `${who}: ${String(b.text ?? "").slice(0, 600)}`, { task: p.task, epoch: p.epoch }));
  }

  if (route === "POST /api/reviews") {
    require(p, "owner");
    const b = await body<{ target: string; verdict: "approve" | "changes" | "block" | "comment"; summary: string }>(request);
    const id = `rv-you-${crypto.randomUUID().slice(0, 8)}`;
    return json(await objective.addReview({ id, target: b.target, reviewer: "you", verdict: b.verdict, confidence: 1, summary: String(b.summary ?? "").slice(0, 4000), findings: [], triage: false }));
  }

  if (route === "POST /api/context") {
    require(p, "owner");
    const b = await body<{ id: string; body: string; title?: string }>(request);
    const { changeContext } = await import("./accepting");
    return json(await changeContext(env, b.id, String(b.body), b.title));
  }

  if (route === "POST /api/participants") {
    require(p, "owner");
    const b = await body<{ id: string; name: string; family: string; model: string; role: "worker" | "reviewer" }>(request);
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(b.id ?? "")) throw new HttpError(400, "INVALID_PARTICIPANT_ID");
    const participant = await objective.upsertParticipant({ id: b.id, kind: "agent", name: String(b.name).slice(0, 40), family: String(b.family).slice(0, 32), model: String(b.model).slice(0, 80), harness: b.role === "reviewer" ? "reviewer" : "external" });
    return json({ participant, token: await participantToken(env, b.id), mcp: `${url.origin}/mcp` });
  }

  if (route === "POST /api/compose") {
    require(p, "owner");
    const id = `compose-${Date.now()}`;
    await env.COMPOSE.create({ id, params: { objective: OBJECTIVE_ID } });
    return json({ workflow: id });
  }

  const accept = /^\/api\/candidates\/([a-z0-9-]{4,64})\/accept$/.exec(url.pathname);
  if (accept && request.method === "POST") {
    require(p, "owner");
    const b = await body<{ expectedVersion: number; contextReview?: string }>(request);
    return json(await acceptCandidate(env, accept[1]!, b.expectedVersion, b.contextReview ?? null));
  }

  throw new HttpError(404, "NOT_FOUND");
}

/** Seeds the project: first checkpoint from the project repo, context items from the context repo. */
async function bootstrap(env: Env) {
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const project = projectStub(env);
  const objective = objectiveStub(env);
  const commit = await artifacts.head(projectRepo(env));
  const ctxCommit = await artifacts.head(contextRepo(env));
  if (!commit || !ctxCommit) throw new HttpError(409, "SEED_REPOS_MISSING", "Push the project and context repositories first");
  const items: ContextItem[] = [];
  for (const f of await artifacts.listFiles(contextRepo(env), ctxCommit)) {
    if (!f.path.endsWith(".md")) continue;
    const text = await artifacts.readText(contextRepo(env), ctxCommit, f.path);
    const item = text ? parseContextFile(f.path, text, ctxCommit) : null;
    if (item) items.push(item);
  }
  const head = await project.bootstrap(commit, items);
  for (const person of PEOPLE) await objective.upsertParticipant(person);
  for (const agent of AGENTS(env)) await objective.upsertParticipant(agent);
  const routing = items.find((i) => i.id === "policy/review-routing")?.policy as Partial<typeof DEFAULT_POLICY> | undefined;
  await objective.init({
    id: OBJECTIVE_ID,
    title: "Viewer-safe CSV export for Harbor",
    criteria: items.filter((i) => i.kind === "requirement").map((i) => `${i.title} (${citeOf(i)})`),
    project: env.PROJECT,
    policy: { ...DEFAULT_POLICY, ...(routing ?? {}) },
  });
  return { head, context: items.map((i) => ({ id: i.id, version: i.version })) };
}

const PREVIEW_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
  "access-control-allow-headers": "content-type, x-harbor-viewer",
};

/**
 * Live preview of a candidate. Candidate code is untrusted, so every response carries a CSP sandbox:
 * the page gets an opaque origin, cannot send Nest's cookies, and cannot read Nest's API. A small shim
 * keeps the candidate's absolute paths inside its own preview.
 */
async function preview(request: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/preview\/([a-z0-9-]{4,64})(\/.*)?$/.exec(url.pathname);
  if (!m) return new Response("Not found", { status: 404 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREVIEW_CORS });
  const computer = env.COMPUTERS.getByName(`runner-${m[1]}`);
  const inner = new URL(m[2] ?? "/", "http://candidate");
  inner.search = url.search;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  const res = await computer.serve(new Request(inner, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() }));
  const out = new Headers(res.headers);
  out.delete("set-cookie");
  for (const [k, v] of Object.entries(PREVIEW_CORS)) out.set(k, v);
  out.set("content-security-policy", "sandbox allow-scripts allow-forms allow-downloads allow-popups");
  out.set("x-content-type-options", "nosniff");
  out.set("cache-control", "no-store");
  if ((out.get("content-type") ?? "").startsWith("text/html")) {
    const base = `/preview/${m[1]}`;
    const shim = `<script>(()=>{const B=${JSON.stringify(base)};const f=window.fetch;window.fetch=(i,o)=>{if(typeof i==="string"&&i.startsWith("/")&&!i.startsWith(B))i=B+i;return f(i,o)};})();</script>`;
    const html = (await res.text()).replace(/<head[^>]*>/i, (h) => `${h}${shim}`);
    out.delete("content-length");
    return new Response(html, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
}
