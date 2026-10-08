// Nest Worker: authenticated API, live updates and the MCP endpoint. Durable Objects hold the state;
// Workflows do the long work; containers run agents and each outcome's checks.

import { ArtifactsClient } from "./artifacts";
import { authenticate, participantToken, type Principal } from "./auth";
import { acceptCandidate, changeContext } from "./accepting";
import { ensureReviews, ingestPush } from "./ingest";
import { handleMcp } from "./mcp";
import { objectiveStub, projectStub, registryStub, taskWorkflowId, workspaceRepo } from "./names";
import { buildPack, searchContext } from "./packs";
import { ConfigError } from "./projectconfig";
import { bootstrapProject, createObjective, createProject, readProjectConfig } from "./projects";
import { OBJECTIVE_ID, PROJECT_ID } from "./registry";
import { reconcileConflict, requestCompose, startTask, stopTask } from "./tasks";

export { RegistryDO } from "./registry";
export { ProjectDO } from "./project";
export { ObjectiveDO } from "./objective";
export { Computer, Outbound } from "./computer";
export { IngestWorkflow } from "./ingest";
export { TaskWorkflow } from "./workflows/task";
export { ReviewWorkflow } from "./workflows/review";
export { ComposeWorkflow } from "./workflows/compose";

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
      const shotPath = /^\/shots\/([bk][0-9a-f]{10})\.png$/.exec(url.pathname);
      if (shotPath) {
        // What a real browser saw when it opened the outcome's preview deployment. Public, like the preview.
        const shot = await env.OBJECTS.get(`shots/${shotPath[1]}.png`);
        if (!shot) return new Response("Not found", { status: 404 });
        return new Response(shot.body, { headers: { "content-type": "image/png", "x-content-type-options": "nosniff", "cache-control": "public, max-age=60" } });
      }
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      const principal = await authenticate(env, request);
      if (!principal) return fail(401, "BAD_TOKEN");
      return await api(request, env, url, principal);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.code, e.message);
      if (e instanceof ConfigError) return fail(422, "INVALID_PROJECT_CONFIG", e.message);
      const code = (e as { code?: string })?.code ?? /^([A-Z][A-Z_]{2,})(?::|$)/.exec(e instanceof Error ? e.message : "")?.[1];
      if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return fail(409, code, (e as Error).message);
      console.error("nest error", e);
      return fail(500, "INTERNAL", e instanceof Error ? e.message : String(e));
    }
  },
} satisfies ExportedHandler<Env>;

/** Agents in containers call these without a prefix; their task token names the objective. */
const TASK_ROUTES = /^\/api\/(pack|search|publish|contributions(\/[a-z0-9_]+)?|note)$/;

async function api(request: Request, env: Env, url: URL, p: Principal): Promise<Response> {
  const objectiveRoute = /^\/api\/o\/([a-z][a-z0-9-]{1,46}[a-z0-9])(\/.*)?$/.exec(url.pathname);
  if (objectiveRoute) {
    if (p.kind === "task" && p.objective !== objectiveRoute[1]) throw new HttpError(403, "FORBIDDEN", "a task token works only in its own objective");
    return objectiveApi(request, env, url, p, objectiveRoute[1]!, objectiveRoute[2] ?? "");
  }
  if (p.kind === "task") {
    if (!TASK_ROUTES.test(url.pathname)) throw new HttpError(403, "FORBIDDEN", `${url.pathname} is not available to agents`);
    return objectiveApi(request, env, url, p, p.objective, url.pathname.slice(4));
  }
  const projectRoute = /^\/api\/p\/([a-z][a-z0-9-]{1,30}[a-z0-9])(\/.*)?$/.exec(url.pathname);
  if (projectRoute) return projectApi(request, env, p, projectRoute[1]!, projectRoute[2] ?? "");

  const registry = registryStub(env);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /api/projects") {
    const [projects, objectives, spend] = await Promise.all([registry.projects(), registry.objectives(), registry.spend()]);
    const heads = await Promise.all(projects.map((x) => projectStub(env, x.id).head()));
    return json({
      me: p.kind, spend,
      projects: projects.map((x, i) => ({ ...x, head: heads[i] ?? null, objectives: objectives.filter((o) => o.project === x.id) })),
    });
  }
  if (route === "POST /api/session") {
    require(p, "owner");
    return new Response(null, { status: 204, headers: { "set-cookie": `nest_owner=${encodeURIComponent(env.NEST_OWNER_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` } });
  }
  if (route === "POST /api/projects") {
    require(p, "owner");
    const b = await body<{ id: string; name: string; description?: string; source?: { url: string; branch?: string } | null }>(request);
    if (!PROJECT_ID.test(String(b.id ?? ""))) throw new HttpError(400, "INVALID_PROJECT_ID", "lowercase letters, digits and hyphens, 3 to 32 characters");
    return json(await createProject(env, b));
  }
  if (route === "GET /api/participants") return json(await registry.participants());
  if (route === "POST /api/participants") {
    require(p, "owner");
    const b = await body<{ id: string; name: string; kind?: "agent" | "human"; family?: string; model?: string; role?: "worker" | "reviewer" }>(request);
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(b.id ?? "")) throw new HttpError(400, "INVALID_PARTICIPANT_ID");
    const name = String(b.name ?? b.id).slice(0, 40);
    // An invited human acts as a human: their reviews decide over agents'. External agents bring their own model.
    const participant = await registry.upsertParticipant(b.kind === "human"
      ? { id: b.id, kind: "person", name, family: "human", model: "-", harness: "human" }
      : { id: b.id, kind: "agent", name, family: String(b.family ?? "external").slice(0, 32), model: String(b.model ?? "unknown").slice(0, 80), harness: b.role === "reviewer" ? "reviewer" : "external" });
    for (const o of await registry.objectives()) await objectiveStub(env, o.id).upsertParticipant(participant);
    const rev = (await registry.participant(b.id))!.rev;
    return json({ participant, token: await participantToken(env, b.id, rev), mcp: `${url.origin}/mcp` });
  }
  const rotate = /^\/api\/participants\/([a-z][a-z0-9-]{1,31})\/rotate$/.exec(url.pathname);
  if (rotate && request.method === "POST") {
    require(p, "owner");
    if (!(await registry.participant(rotate[1]!))) throw new HttpError(404, "NOT_FOUND");
    const rev = await registry.rotateParticipant(rotate[1]!);
    return json({ id: rotate[1], token: await participantToken(env, rotate[1]!, rev) });
  }
  if (route === "GET /api/spend") return json(await registry.spend());

  if (route === "POST /api/admin/spend/carry") {
    require(p, "owner");
    const b = await body<{ id: string; microUsd: number; note: string }>(request);
    return json({ carried: await registry.carrySpend(String(b.id), Number(b.microUsd), String(b.note ?? "carried over")), spend: await registry.spend() });
  }

  if (route === "POST /api/admin/repos/prune") {
    require(p, "owner");
    const b = await body<{ prefix: string; dryRun?: boolean }>(request);
    // Only an objective's workspace repositories, never a project or context repository.
    if (!/^[a-z][a-z0-9-]{1,46}[a-z0-9]\.([0-9a-f]{8}--)?/.test(b.prefix ?? "") || !String(b.prefix).includes(".")) throw new HttpError(400, "BAD_PREFIX", "prefix must name an objective's workspaces, as <objective>.<generation>");
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await env.ARTIFACTS.list({ limit: 100, cursor });
      for (const repo of r.repos) if (repo.name.startsWith(b.prefix)) names.push(repo.name);
      cursor = r.cursor;
      if (!cursor) break;
    }
    if (b.dryRun) return json({ matched: names.length, sample: names.slice(0, 5) });
    let deleted = 0;
    for (let i = 0; i < names.length; i += 20) deleted += (await Promise.all(names.slice(i, i + 20).map((n) => env.ARTIFACTS.delete(n).catch(() => false)))).filter(Boolean).length;
    return json({ matched: names.length, deleted });
  }

  if (route === "POST /api/admin/gateway/probe") {
    // A tiny Workers AI request through the configured gateway, to confirm it logs and authenticates.
    require(p, "owner");
    try {
      const out = await env.AI.run("@cf/meta/llama-3.2-1b-instruct" as keyof AiModels, { prompt: "Reply with ok", max_tokens: 5 } as never, { gateway: { id: env.AI_GATEWAY_ID } } as never);
      return json({ ok: true, gateway: env.AI_GATEWAY_ID, logId: (env.AI as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null, out });
    } catch (e) {
      return json({ ok: false, gateway: env.AI_GATEWAY_ID, error: String(e).slice(0, 400) });
    }
  }

  if (route === "POST /api/admin/computers/destroy") {
    require(p, "owner");
    const b = await body<{ names: string[] }>(request);
    const names = (b.names ?? []).filter((n) => /^[a-z0-9_.-]{3,120}$/.test(n)).slice(0, 100);
    const done = await Promise.all(names.map(async (n) => {
      const c = env.COMPUTERS.getByName(n);
      await c.stopAgent().catch(() => undefined);
      await c.destroy("destroyed by the owner").catch(() => undefined);
      return n;
    }));
    return json({ destroyed: done });
  }

  throw new HttpError(404, "NOT_FOUND");
}

async function projectApi(request: Request, env: Env, p: Principal, projectId: string, rest: string): Promise<Response> {
  const registry = registryStub(env);
  const record = await registry.project(projectId);
  if (!record) throw new HttpError(404, "NOT_FOUND", `no project ${projectId}`);
  const project = projectStub(env, projectId);
  const route = `${request.method} ${rest || "/"}`;

  if (route === "GET /") {
    const [head, checkpoints, context, notes, objectives] = await Promise.all([project.head(), project.checkpoints(), project.context(), project.notes(), registry.objectives(projectId)]);
    const { config, configError } = await configAt(env, projectId, head?.commit ?? null);
    return json({ me: p.kind, project: record, head, checkpoints, context, notes, objectives, config, configError });
  }
  if (route === "POST /bootstrap") {
    require(p, "owner");
    try {
      return json(await bootstrapProject(env, projectId, 10));
    } catch (e) {
      if (!/^NO_CODE_YET/.test(String((e as Error)?.message))) throw e;
      // Still empty: a fresh token to push the first commit with.
      const token = await new ArtifactsClient(env.ARTIFACTS).token(record.repo, "write", 3600);
      using r = await env.ARTIFACTS.get(record.repo);
      return json({ head: null, push: { remote: (await r.info()).remote, token: token.secret, expiresAt: token.expiresAt } });
    }
  }
  if (route === "POST /context") {
    require(p, "owner");
    const b = await body<{ id: string; body: string; title?: string; kind?: string }>(request);
    return json(await changeContext(env, projectId, { id: String(b.id ?? ""), body: String(b.body ?? ""), title: b.title, kind: b.kind }));
  }
  if (route === "POST /objectives") {
    require(p, "owner");
    const b = await body<{ id: string; title: string; criteria?: string[] }>(request);
    if (!OBJECTIVE_ID.test(String(b.id ?? ""))) throw new HttpError(400, "INVALID_OBJECTIVE_ID", "lowercase letters, digits and hyphens, 3 to 48 characters");
    return json(await createObjective(env, projectId, b));
  }
  throw new HttpError(404, "NOT_FOUND");
}

async function configAt(env: Env, projectId: string, commit: string | null) {
  if (!commit) return { config: null, configError: null };
  try {
    return { config: await readProjectConfig(env, projectId, commit), configError: null };
  } catch (e) {
    if (e instanceof ConfigError) return { config: null, configError: e.message };
    throw e;
  }
}

async function objectiveApi(request: Request, env: Env, url: URL, p: Principal, objectiveId: string, rest: string): Promise<Response> {
  const registry = registryStub(env);
  const record = await registry.objective(objectiveId);
  if (!record) throw new HttpError(404, "NOT_FOUND", `no objective ${objectiveId}`);
  const objective = objectiveStub(env, objectiveId);
  const projectId = record.project;
  const project = projectStub(env, projectId);
  const route = `${request.method} ${rest || "/"}`;

  if (route === "GET /") {
    const [head, checkpoints, context, notes, state, spend, info] = await Promise.all([
      project.head(), project.checkpoints(), project.context(), project.notes(), objective.state(), registry.spend(objectiveId), registry.project(projectId),
    ]);
    const { config, configError } = await configAt(env, projectId, head?.commit ?? null);
    return json({ head, checkpoints, context, notes, ...state, project: info, config, configError, spend, me: p.kind });
  }
  if (route === "GET /live") {
    if (request.headers.get("upgrade") !== "websocket") throw new HttpError(426, "WEBSOCKET_REQUIRED");
    return objective.fetch(request);
  }
  if (route === "GET /events") {
    const tail = url.searchParams.get("tail");
    return json(tail ? await objective.recentEvents(Number(tail) || 200) : await objective.events(Number(url.searchParams.get("after") ?? 0)));
  }

  if (route === "POST /tasks") {
    require(p, "owner");
    const b = await body<{ id: string; title: string; brief: string; alternative?: string | null }>(request);
    if (!/^t_[a-z0-9-]{1,48}$/.test(b.id ?? "")) throw new HttpError(400, "INVALID_TASK_ID");
    if (b.alternative && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(b.alternative)) throw new HttpError(400, "INVALID_GROUP", "a competing group is lowercase letters, digits and hyphens");
    const head = await project.head();
    if (!head) throw new HttpError(409, "NOT_BOOTSTRAPPED");
    return json(await objective.createTask({ id: b.id, title: String(b.title).slice(0, 200), brief: String(b.brief).slice(0, 8000), alternative: b.alternative || null, baseVersion: head.version }));
  }

  const taskAction = /^\/tasks\/(t_[a-z0-9-]{1,48})\/(start|pause|stop)$/.exec(rest);
  if (taskAction && request.method === "POST") {
    require(p, "owner");
    const [, taskId, action] = taskAction as unknown as [string, string, string];
    if (action === "start") {
      const b = await body<{ participant: string; mode?: "agent" | "manual" }>(request);
      return json(await startTask(env, objectiveId, taskId, b.participant, b.mode ?? "agent"));
    }
    if (action === "stop") return json(await stopTask(env, objectiveId, taskId));
    const t = await objective.task(taskId);
    if (!t || t.status !== "running") throw new HttpError(409, "NOT_RUNNING");
    // The running workflow notices the epoch change at its next tool boundary and saves a portable note.
    const instance = await env.TASKS.get(taskWorkflowId(await objective.generation(), t.id, t.epoch)).catch(() => null);
    await instance?.sendEvent({ type: "pause", payload: { epoch: t.epoch } }).catch(() => undefined);
    return json({ requested: true, epoch: t.epoch });
  }

  if (route === "POST /publish") {
    require(p, "owner", "task");
    const b = await body<{ repo: string; commit: string }>(request);
    if (p.kind === "task" && b.repo !== workspaceRepo(p.objective, p.generation, p.task, p.epoch)) throw new HttpError(403, "NOT_YOUR_WORKSPACE");
    if (!String(b.repo ?? "").startsWith(`${objectiveId}.`)) throw new HttpError(400, "NOT_THIS_OBJECTIVE");
    return json(await ingestPush(env, b.repo, b.commit));
  }

  if (route === "GET /pack") {
    require(p, "owner", "task");
    const taskId = p.kind === "task" ? p.task : String(url.searchParams.get("task") ?? "");
    return new Response((await buildPack(env, objectiveId, taskId, Number(url.searchParams.get("budget") ?? 200_000))).text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  if (route === "GET /search") {
    require(p, "owner", "task");
    return json(await searchContext(env, projectId, String(url.searchParams.get("q") ?? "").slice(0, 400)));
  }

  if (route === "GET /contributions") {
    require(p, "owner", "task");
    const state = await objective.state();
    const names = new Map(state.participants.map((x) => [x.id, x.name]));
    return json(state.contributions.map((c) => ({ id: c.id, title: c.title, author: names.get(c.author) ?? c.author, status: c.status, alternative: c.alternative, paths: c.paths, requires: c.requires })));
  }

  const show = /^\/contributions\/(c_[0-9a-f]{12})$/.exec(rest);
  if (show && request.method === "GET") {
    require(p, "owner", "task");
    const c = await objective.contribution(show[1]!);
    if (!c) throw new HttpError(404, "NOT_FOUND");
    const artifacts = new ArtifactsClient(env.ARTIFACTS);
    const files = [];
    for (const path of c.paths.slice(0, 20)) files.push({ path, content: (await artifacts.readText(c.repo, c.commit, path).catch(() => null)) ?? "(deleted)" });
    return json({ id: c.id, title: c.title, author: c.author, message: c.message, files });
  }

  if (route === "POST /note") {
    if (p.kind !== "task") throw new HttpError(403, "FORBIDDEN");
    const t = await objective.task(p.task);
    if (!t || t.epoch !== p.epoch || t.status !== "running") throw new HttpError(409, "STALE_ATTEMPT");
    const b = await body<{ text: string }>(request);
    const who = (await objective.participants()).find((x) => x.id === t.participant)?.name ?? "Agent";
    return json(await objective.log("Agents", "note", `${who}: ${String(b.text ?? "").slice(0, 600)}`, { task: p.task, epoch: p.epoch }));
  }

  const reviewAgain = /^\/contributions\/(c_[0-9a-f]{12})\/review-again$/.exec(rest);
  if (reviewAgain && request.method === "POST") {
    // When agent reviewers could not reach a verdict, a human can ask them once more.
    require(p, "owner");
    const c = await objective.contribution(reviewAgain[1]!);
    if (!c) throw new HttpError(404, "NOT_FOUND");
    if (!["proposed", "changes"].includes(c.status)) throw new HttpError(409, "ALREADY_DECIDED", `this contribution is ${c.status}`);
    const id = `review-${c.id}-${Date.now().toString(36)}`;
    await env.REVIEWS.create({ id, params: { objective: objectiveId, contribution: c.id } });
    await objective.log("Workflows", "review", `A human asked agents to review ${c.title} again`, { contribution: c.id });
    return json({ workflow: id });
  }

  if (route === "POST /reviews") {
    require(p, "owner");
    const b = await body<{ target: string; verdict: "approve" | "changes" | "block" | "comment"; summary: string }>(request);
    const id = `rv-you-${crypto.randomUUID().slice(0, 8)}`;
    const out = await objective.addReview({ id, target: b.target, reviewer: "you", verdict: b.verdict, confidence: 1, summary: String(b.summary ?? "").slice(0, 4000), findings: [], triage: false });
    // A human's verdict can complete an outcome's approvals, which releases its preview build.
    await requestCompose(env, objectiveId, "a human reviewed");
    return json(out);
  }

  const resolve = /^\/inbox\/([a-z0-9_-]{3,80})\/resolve$/.exec(rest);
  if (resolve && request.method === "POST") {
    require(p, "owner");
    const b = await body<{ resolution?: string }>(request);
    await objective.resolveInbox(resolve[1]!, String(b.resolution ?? "resolved by the owner").slice(0, 200));
    return json({ resolved: resolve[1] });
  }

  if (route === "POST /compose") {
    require(p, "owner");
    const id = `compose-${objectiveId}-${Date.now()}`;
    await env.COMPOSE.create({ id, params: { objective: objectiveId, reason: "owner asked to compose" } });
    return json({ workflow: id });
  }

  if (route === "POST /recompose") {
    require(p, "owner");
    const b = await body<{ ids: string[] }>(request);
    const ids = (b.ids ?? []).filter((x) => /^k[0-9a-f]{10}$/.test(x));
    await objective.markCandidatesOutdated(ids);
    const id = `compose-${objectiveId}-${Date.now()}`;
    await env.COMPOSE.create({ id, params: { objective: objectiveId, reason: "owner asked to recompose", only: ids } });
    return json({ workflow: id });
  }

  if (route === "POST /resync") {
    // Recovery: readiness recomputed from reviews, and a review started for any contribution without one.
    require(p, "owner");
    await objective.promoteOutcomes();
    return json({ reviews: await ensureReviews(env, objectiveId) });
  }

  const reconcile = /^\/candidates\/(k[0-9a-f]{10})\/reconcile$/.exec(rest);
  if (reconcile && request.method === "POST") {
    require(p, "owner");
    const b = await body<{ participant?: string }>(request);
    return json(await reconcileConflict(env, objectiveId, reconcile[1]!, b.participant ?? env.AUTO_REPAIR_AGENT));
  }

  const repair = /^\/candidates\/(k[0-9a-f]{10})\/repair$/.exec(rest);
  if (repair && request.method === "POST") {
    require(p, "owner");
    const b = await body<{ participant?: string }>(request);
    const { repairOutcome } = await import("./tasks");
    return json(await repairOutcome(env, objectiveId, repair[1]!, b.participant ?? env.AUTO_REPAIR_AGENT));
  }

  const accept = /^\/candidates\/(k[0-9a-f]{10})\/accept$/.exec(rest);
  if (accept && request.method === "POST") {
    require(p, "owner");
    const b = await body<{ expectedVersion: number; contextReview?: string; reason?: string }>(request);
    return json(await acceptCandidate(env, objectiveId, accept[1]!, b.expectedVersion, b.contextReview ?? null, b.reason ? String(b.reason).slice(0, 2000) : null));
  }

  throw new HttpError(404, "NOT_FOUND");
}
