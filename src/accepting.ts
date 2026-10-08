// Acceptance and context change: the two ways a human moves a project forward.

import { acceptError, type CandidateFacts } from "./domain/accept";
import { parseContextFile, renderContextFile } from "./context";
import { artifactsRemote, candidateRef, contextRepo, objectiveStub, projectRepo, projectStub, registryStub, short } from "./names";
import { requiredChecks } from "./projectconfig";
import { readProjectConfig, refreshPolicies } from "./projects";

export class AcceptError extends Error {
  // Durable Object RPC keeps only the message, so the code leads it.
  constructor(readonly code: string, message = code) {
    super(message === code ? code : `${code}: ${message}`);
  }
}

export async function acceptCandidate(env: Env, objectiveId: string, candidateId: string, expectedVersion: number, contextReview: string | null, reason: string | null = null) {
  const objective = objectiveStub(env, objectiveId);
  const state = await objective.state();
  const projectId = state.objective.project;
  if (!projectId) throw new AcceptError("NOT_INITIALIZED");
  const project = projectStub(env, projectId);
  const head = await project.head();
  const context = await project.context();
  if (!head) throw new AcceptError("NOT_BOOTSTRAPPED");
  const c = state.candidates.find((x) => x.id === candidateId);
  if (!c || !c.commit) throw new AcceptError("NOT_READY", "This outcome has not been composed and checked");
  const config = await readProjectConfig(env, projectId, head.commit);
  const members = c.order.map((id) => state.contributions.find((x) => x.id === id));
  const current = new Map(context.map((i) => [i.id, i.version]));
  const stale = members.flatMap((m) => m?.cites ?? []).filter((x) => (current.get(x.item) ?? 0) > x.version);
  const facts: CandidateFacts = {
    baseVersion: c.baseVersion, contextDigest: c.contextDigest, policyDigest: c.policyDigest,
    checks: c.checks, requiredChecks: requiredChecks(config),
    membersApproved: members.every((m) => m?.status === "approved"),
    openConflicts: c.conflict ? 1 : 0,
    staleCitations: stale.length,
    contextReviewRecorded: !!contextReview && contextReview.trim().length >= 12,
    commit: c.commit,
    parentOk: c.baseCommit === head.commit,
  };
  const error = acceptError(head, { candidateId, expectedVersion, expectedContextDigest: head.contextDigest, expectedPolicyDigest: head.policyDigest }, facts);
  if (error) throw new AcceptError(error);

  const checkpoint = await project.advance(
    { version: expectedVersion, contextDigest: head.contextDigest, policyDigest: head.policyDigest },
    c.commit, candidateId, reason?.trim() || contextReview?.trim() || `Accepted ${c.name}`,
  );
  await objective.markAccepted(candidateId, checkpoint);
  // The accepted tree may change the project's configuration, including its protected paths.
  await refreshPolicies(env, projectId).catch((e) => objective.log("Nest", "policy", `Could not refresh review policy: ${String(e).slice(0, 200)}`));
  await objective.log("Durable Objects", "accept", `Compare-and-swap moved the project head from checkpoint ${head.version} to ${checkpoint.version}`, { candidate: candidateId, checkpoint: checkpoint.version });

  // Every approach that lost becomes one note with the human's reason and the reviews against it, so
  // later agents start informed. An approach is everything one task contributed to the group.
  const taskTitle = (id: string | null) => state.tasks.find((t) => t.id === id)?.title ?? id ?? "untasked work";
  for (const [group, chosenId] of Object.entries(c.choice)) {
    if (/^(overlap|replace):/.test(group)) continue; // implicit choices, not approaches
    const winner = state.contributions.find((x) => x.id === chosenId);
    const losers = new Map<string, typeof state.contributions>();
    for (const x of state.contributions.filter((x) => x.alternative === group && x.task !== winner?.task))
      losers.set(x.task ?? x.id, [...(losers.get(x.task ?? x.id) ?? []), x]);
    for (const [task, ms] of losers) {
      const ids = new Set(ms.map((m) => m.id));
      const against = state.reviews.filter((r) => ids.has(r.target) && !r.triage && r.verdict !== "approve").map((r) => `${r.reviewer}: ${r.summary}`).filter(Boolean);
      const id = `rej/${group}-${task}`;
      await project.addNote({
        id, kind: "rejected", title: taskTitle(task), source: ms[0]!.id,
        body: `In "${group}", ${taskTitle(task)} (${ms.map((m) => `${short(m.id)} ${m.title}`).join("; ")}) was not chosen at checkpoint ${checkpoint.version}; ${taskTitle(winner?.task ?? null)} was. `
          + `The human's reason: ${reason?.trim().replace(/[.\s]+$/, "") || "none given"}. `
          + (against.length ? `Reviews against it: ${against.join(" ")}` : "Its reviews did not object."),
      });
      await objective.log("Artifacts", "note", `Recorded why ${taskTitle(task)} was not chosen`, { note: id });
    }
  }

  // The project's main branch follows the accepted head, which is what its deploy pipeline (for example
  // Workers Builds) ships to production. Only the project's mirror computer, which never runs candidate
  // code, may move main.
  const name = `mirror.${projectId}`;
  const mirror = env.COMPUTERS.getByName(name);
  await mirror.configure({ computer: name, role: "mirror", project: projectId, objective: objectiveId });
  const remote = artifactsRemote(env, projectRepo(projectId));
  const mirrored = await mirror.exec(["bash", "-lc", `rm -rf /workspace/main && git clone --quiet ${remote} /workspace/main && cd /workspace/main && git fetch --quiet origin ${candidateRef(candidateId)} && git merge --ff-only --quiet ${c.commit} && git push --quiet origin HEAD:refs/heads/main`], "/workspace", {}, 180).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  await objective.log("Artifacts", "mirror", mirrored.exitCode === 0
    ? `Fast-forwarded ${projectId} main to ${c.commit.slice(0, 7)}${config.production ? `; production deploys from main to ${config.production}` : ""}`
    : `Main will catch up: ${mirrored.stderr.slice(0, 200)}`);
  return { checkpoint };
}

const KIND_DIRS: Record<string, string> = { requirement: "req", decision: "dec", evidence: "ev", policy: "policy", note: "note" };

/**
 * A human adds a context item or accepts a new version of one. The head gets a context-only checkpoint;
 * in every objective of the project, work that cited the old version is found by the citation index, its
 * outcomes are marked outdated, and the frontier is recomposed under the new version.
 */
export async function changeContext(env: Env, projectId: string, input: { id: string; body: string; title?: string; kind?: string }) {
  const project = projectStub(env, projectId);
  const head = await project.head();
  if (!head) throw new AcceptError("NOT_BOOTSTRAPPED");
  const cur = (await project.context()).find((i) => i.id === input.id) ?? null;
  const body = String(input.body ?? "").trim();
  if (!body) throw new AcceptError("EMPTY_CONTEXT", "a context item needs a body");
  let path: string;
  let kind: string;
  if (cur) {
    path = cur.path;
    kind = cur.kind;
  } else {
    kind = input.kind && KIND_DIRS[input.kind] ? input.kind : "requirement";
    const m = /^([a-z]+)\/([a-z0-9][a-z0-9-]{0,60})$/.exec(input.id ?? "");
    if (!m || m[1] !== KIND_DIRS[kind]) throw new AcceptError("INVALID_CONTEXT_ID", `a new ${kind} is named ${KIND_DIRS[kind]}/<name>, lowercase letters, digits and hyphens`);
    path = `${m[1]}/${m[2]}.md`;
  }
  const title = String(input.title ?? cur?.title ?? input.id).replace(/\s+/g, " ").trim().slice(0, 120);
  const nextText = renderContextFile({ id: input.id, kind, version: (cur?.version ?? 0) + 1, owner: "human", title, body, policy: null });
  const parsed = parseContextFile(path, nextText, head.commit);
  if (!parsed) throw new AcceptError("INVALID_CONTEXT");
  const { checkpoint } = await project.acceptContext(head.version, parsed);

  if (parsed.id === "policy/review-routing") await refreshPolicies(env, projectId);
  const radii: Record<string, { contributions: number; candidates: number; tasks: number }> = {};
  for (const o of await registryStub(env).objectives(projectId)) {
    const objective = objectiveStub(env, o.id);
    const radius = await objective.blastRadius(parsed.id, parsed.version);
    await objective.markCandidatesOutdated(radius.candidates);
    radii[o.id] = { contributions: radius.contributions.length, candidates: radius.candidates.length, tasks: radius.tasks.length };
    await objective.log("Durable Objects", "context", cur
      ? `Accepted ${parsed.id} version ${parsed.version}. Blast radius: ${radius.contributions.length} contributions, ${radius.candidates.length} outcomes, ${radius.tasks.length} running tasks cited version ${cur.version}`
      : `Added ${parsed.id}: ${title}`, { item: parsed.id, version: parsed.version, ...radius });
    try { await env.COMPOSE.create({ id: `compose-${await objective.generation()}-ctx-${checkpoint.version}`, params: { objective: o.id, reason: `context ${parsed.id} v${parsed.version}` } }); } catch { /* already running */ }
  }

  // Mirror the item into the context repository, so the history is ordinary git. Only the project's
  // context computer, which never runs candidate code, may write there; the text arrives on stdin.
  const name = `context.${projectId}`;
  const writer = env.COMPUTERS.getByName(name);
  await writer.configure({ computer: name, role: "context", project: projectId, objective: "-" });
  const repo = artifactsRemote(env, contextRepo(projectId));
  const script = `rm -rf /workspace/ctx && git clone --quiet ${repo} /workspace/ctx && cd /workspace/ctx && mkdir -p "$(dirname ${path})" && cat > ${path} && git add -A && git -c user.name="Nest" -c user.email=context@nest.invalid commit --quiet -m "${cur ? "Accept" : "Add"} ${parsed.id} version ${parsed.version}" && git push --quiet origin HEAD:main`;
  const mirrored = await writer.execWithInput(["bash", "-lc", script], nextText).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  if (mirrored.exitCode !== 0) console.warn(`context repo ${contextRepo(projectId)} will catch up: ${mirrored.stderr.slice(0, 200)}`);
  return { checkpoint, item: { id: parsed.id, version: parsed.version }, radius: radii, mirrored: mirrored.exitCode === 0 };
}
