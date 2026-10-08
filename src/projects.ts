// Projects and objectives: creating them, the default roster, and a project's configuration as of an
// accepted checkpoint.

import { ArtifactsClient } from "./artifacts";
import { parseContextFile } from "./context";
import { effectivePolicy, DEFAULT_POLICY, type ReviewPolicy } from "./domain/review";
import { artifactsRemote, contextRepo, objectiveStub, projectRepo, projectStub, registryStub } from "./names";
import type { ContextItem } from "./project";
import { CONFIG_PATH, parseProjectConfig, type ProjectConfig } from "./projectconfig";
import { OBJECTIVE_ID, PROJECT_ID, RegistryError, type Participant } from "./registry";

/** A commit's file never changes, so a parsed config is cached by repository and commit. */
const configs = new Map<string, ProjectConfig>();

/**
 * The project's `.nest/project.json` at a commit. A missing file is an empty configuration; a malformed
 * one throws ConfigError; a failed read throws, so a caller never mistakes an outage for "no checks".
 */
export async function readProjectConfig(env: Env, project: string, commit: string): Promise<ProjectConfig> {
  const key = `${project}@${commit}`;
  const hit = configs.get(key);
  if (hit) return hit;
  const raw = await new ArtifactsClient(env.ARTIFACTS).readText(projectRepo(project), commit, CONFIG_PATH, 64_000);
  const config = parseProjectConfig(raw);
  if (configs.size > 200) configs.clear();
  configs.set(key, config);
  return config;
}

/** The participants every deployment starts with: one human and a mixed roster of agent families. */
export function defaultRoster(env: Env): Participant[] {
  return [
    { id: "you", kind: "person", name: "You", family: "human", model: "-", harness: "human" },
    { id: "wren", kind: "agent", name: "Wren", family: "openai", model: env.AGENT_MODEL_OPENAI, harness: "codex" },
    { id: "kestrel", kind: "agent", name: "Kestrel", family: "anthropic", model: env.AGENT_MODEL_ANTHROPIC, harness: "nest-agent" },
    { id: "heron", kind: "agent", name: "Heron", family: "anthropic", model: env.AGENT_MODEL_ANTHROPIC, harness: "nest-agent" },
    { id: "finch", kind: "agent", name: "Finch", family: "openai", model: env.AGENT_MODEL_OPENAI, harness: "codex" },
    { id: "shrike", kind: "agent", name: "Shrike", family: "openai", model: env.REVIEW_MODEL_OPENAI, harness: "reviewer" },
    { id: "owl", kind: "agent", name: "Owl", family: "anthropic", model: env.REVIEW_MODEL_ANTHROPIC, harness: "reviewer" },
    // Plover ran gpt-oss, an OpenAI model, so it was not independent of OpenAI authors. It keeps its
    // identity and past reviews, and no longer reviews.
    { id: "plover", kind: "agent", name: "Plover", family: "workers-ai", model: env.REVIEW_MODEL_WORKERS_AI, harness: "retired" },
    { id: "kite", kind: "agent", name: "Kite", family: "deepseek", model: env.REVIEW_MODEL_DEEPSEEK, harness: "reviewer" },
    { id: "tern", kind: "agent", name: "Tern", family: "zhipu", model: env.REVIEW_MODEL_ZHIPU, harness: "reviewer" },
    { id: "triage", kind: "agent", name: "Triage", family: "workers-ai", model: env.REVIEW_MODEL_WORKERS_AI, harness: "triage" },
  ];
}

/** Registers the default roster (models follow the deployment's configuration) and returns everyone. */
export async function ensureRoster(env: Env): Promise<Participant[]> {
  const registry = registryStub(env);
  for (const p of defaultRoster(env)) await registry.upsertParticipant(p);
  return registry.participants();
}

/** Brings every objective's copy of the participants up to date with the registry. */
export async function syncRoster(env: Env): Promise<{ participants: number; objectives: number }> {
  const participants = await ensureRoster(env);
  const objectives = await registryStub(env).objectives();
  for (const o of objectives) for (const p of participants) await objectiveStub(env, o.id).upsertParticipant(p);
  return { participants: participants.length, objectives: objectives.length };
}

/**
 * The review policy an objective routes by: the project's review-routing context item, plus the
 * protected paths its configuration names, on top of floors no policy can lower.
 */
export async function objectivePolicy(env: Env, project: string): Promise<ReviewPolicy> {
  const p = projectStub(env, project);
  const head = await p.head();
  const routing = (await p.context()).find((i) => i.id === "policy/review-routing")?.policy ?? null;
  const config = head ? await readProjectConfig(env, project, head.commit).catch(() => null) : null;
  return effectivePolicy({
    ...DEFAULT_POLICY,
    ...(routing ?? {}),
    protectedPaths: [...(routing?.protectedPaths ?? []), ...(config?.protected ?? [])],
  });
}

/** Every objective of a project routes by the same policy; call after anything it depends on changes. */
export async function refreshPolicies(env: Env, project: string): Promise<void> {
  const policy = await objectivePolicy(env, project);
  for (const o of await registryStub(env).objectives(project)) await objectiveStub(env, o.id).setPolicy(policy);
}

async function waitForHead(env: Env, repo: string, seconds: number): Promise<string | null> {
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const head = await artifacts.head(repo).catch(() => null);
    if (head || Date.now() > until) return head;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Nest works on `main`. An imported repository may keep its history on another branch (`master`, say):
 * the project's mirror computer, which never runs project code, creates `main` from the default branch.
 */
async function ensureMain(env: Env, project: string): Promise<boolean> {
  const name = `mirror.${project}`;
  const mirror = env.COMPUTERS.getByName(name);
  await mirror.configure({ computer: name, role: "mirror", project, objective: "-" });
  const remote = artifactsRemote(env, projectRepo(project));
  const r = await mirror.exec(["bash", "-lc", `rm -rf /workspace/main && git clone --quiet ${remote} /workspace/main && cd /workspace/main && git push --quiet origin HEAD:refs/heads/main`], "/workspace", {}, 180).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  if (r.exitCode !== 0) console.warn(`could not create main for ${project}: ${r.stderr.slice(0, 300)}`);
  return r.exitCode === 0;
}

/** Context items already in a project's context repository, so a project keeps its history. */
async function readContext(env: Env, project: string): Promise<ContextItem[]> {
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const commit = await artifacts.head(contextRepo(project)).catch(() => null);
  if (!commit) return [];
  const items: ContextItem[] = [];
  for (const f of await artifacts.listFiles(contextRepo(project), commit, 2000)) {
    if (!f.path.endsWith(".md") || f.path.toLowerCase() === "readme.md") continue;
    const text = await artifacts.readText(contextRepo(project), commit, f.path, 200_000);
    const item = text ? parseContextFile(f.path, text, commit) : null;
    if (item) items.push(item);
  }
  return items;
}

export type ProjectInput = { id: string; name: string; description?: string; source?: { url: string; branch?: string } | null };

/**
 * Creates a project. With a source URL, Artifacts imports that public git repository and the project
 * starts at its head. Without one, the code repository is created empty and the owner gets a short-lived
 * token to push the first commit, after which `bootstrapProject` takes it from there.
 */
export async function createProject(env: Env, input: ProjectInput) {
  const id = String(input.id ?? "");
  if (!PROJECT_ID.test(id) || /-context$/.test(id)) throw new RegistryError("INVALID_PROJECT_ID", "lowercase letters, digits and hyphens, 3 to 32 characters, not ending in -context");
  const name = String(input.name ?? "").trim().slice(0, 80) || id;
  const description = String(input.description ?? "").trim().slice(0, 600);
  const registry = registryStub(env);
  if (await registry.project(id)) throw new RegistryError("PROJECT_EXISTS", id);
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const repo = projectRepo(id);

  if (input.source?.url) {
    let url: URL;
    try { url = new URL(input.source.url); } catch { throw new RegistryError("INVALID_SOURCE", "source.url is not a URL"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new RegistryError("INVALID_SOURCE", "source.url must be a public https git URL without credentials");
    const branch = input.source.branch && /^[A-Za-z0-9._\/-]{1,100}$/.test(input.source.branch) ? input.source.branch : undefined;
    await env.ARTIFACTS.import({ source: { url: url.toString(), ...(branch ? { branch } : {}) }, target: { name: repo, opts: { description: name } } });
  } else {
    await artifacts.ensureRepo(repo, name);
  }
  await artifacts.ensureRepo(contextRepo(id), `Context for ${name}`);
  const record = await registry.addProject({ id, name, description, repo, contextRepo: contextRepo(id) });
  await ensureRoster(env);

  if (input.source?.url) {
    // Artifacts imports in the background. A small repository is ready in seconds; a large one is not, and
    // the project page offers "Check for code" until it is.
    try {
      return { project: record, ...(await bootstrapProject(env, id, 20)), importing: false };
    } catch (e) {
      if (!/^NO_CODE_YET/.test(String((e as Error)?.message))) throw e;
      return { project: record, head: null, importing: true };
    }
  }
  const token = await artifacts.token(repo, "write", 3600);
  using r = await env.ARTIFACTS.get(repo);
  const info = await r.info();
  return { project: record, head: null, push: { remote: info.remote, token: token.secret, expiresAt: token.expiresAt } };
}

/** The first checkpoint: the code repository's main branch and whatever context already exists. Idempotent. */
export async function bootstrapProject(env: Env, id: string, waitSeconds = 5) {
  const project = projectStub(env, id);
  const existing = await project.head();
  if (existing) return { head: existing, config: await readProjectConfig(env, id, existing.commit) };
  let commit = await waitForHead(env, projectRepo(id), waitSeconds);
  if (!commit) {
    // The binding cannot list branches, but an import source or a push means history exists somewhere.
    const artifacts = new ArtifactsClient(env.ARTIFACTS);
    using repo = await env.ARTIFACTS.get(projectRepo(id));
    const info = await repo.info();
    if ((info.source || info.lastPushAt) && (await ensureMain(env, id))) commit = await artifacts.head(projectRepo(id)).catch(() => null);
  }
  if (!commit) throw new RegistryError("NO_CODE_YET", `no commit on the main branch of ${projectRepo(id)} yet: push one, or wait for the import to finish`);
  // Validate before the first checkpoint exists: a malformed configuration is the owner's to fix now.
  const config = await readProjectConfig(env, id, commit);
  const head = await project.bootstrap(commit, await readContext(env, id));
  return { head, config };
}

export type ObjectiveInput = { id: string; title: string; criteria?: string[] };

/** An objective is a goal inside a project, with its own tasks, contributions, reviews and outcomes. */
export async function createObjective(env: Env, project: string, input: ObjectiveInput) {
  const id = String(input.id ?? "");
  if (!OBJECTIVE_ID.test(id)) throw new RegistryError("INVALID_OBJECTIVE_ID", "lowercase letters, digits and hyphens, 3 to 48 characters");
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new RegistryError("INVALID_OBJECTIVE", "an objective needs a title");
  const registry = registryStub(env);
  if (!(await registry.project(project))) throw new RegistryError("NO_SUCH_PROJECT", project);
  if (!(await projectStub(env, project).head())) throw new RegistryError("NOT_BOOTSTRAPPED", "push the project's code first");
  const criteria = (Array.isArray(input.criteria) ? input.criteria : []).map((c) => String(c).trim().slice(0, 300)).filter(Boolean).slice(0, 20);
  const record = await registry.addObjective({ id, project, title });
  const objective = objectiveStub(env, id);
  for (const p of await ensureRoster(env)) await objective.upsertParticipant(p);
  await objective.init({ id, title, criteria, project, policy: await objectivePolicy(env, project) });
  return record;
}
