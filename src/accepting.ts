// Acceptance and context change: the two ways a human moves a project forward.

import { acceptError, type CandidateFacts } from "./domain/accept";
import { parseContextFile, renderContextFile } from "./context";
import { artifactsRemote, candidateRef, contextRepo, objectiveStub, projectRepo, projectStub, registryStub, short } from "./names";
import { requiredChecks } from "./projectconfig";
import { readProjectConfig, refreshPolicies } from "./projects";
import { requestCompose } from "./tasks";

export class AcceptError extends Error {
  // Durable Object RPC keeps only the message, so the code leads it.
  constructor(readonly code: string, message = code) {
    super(message === code ? code : `${code}: ${message}`);
  }
}

/**
 * Finishes any acceptance that was cut short between the project's head swap and the objective's
 * bookkeeping, from the project's own record of which outcome its head came from.
 */
export async function reconcileAcceptance(env: Env, objectiveId: string): Promise<string[]> {
  const objective = objectiveStub(env, objectiveId);
  const projectId = (await objective.state()).objective.project;
  if (!projectId) return [];
  const head = await projectStub(env, projectId).head();
  return head ? objective.reconcileAcceptance(head) : [];
}

export async function acceptCandidate(env: Env, objectiveId: string, candidateId: string, expectedVersion: number, contextReview: string | null, reason: string | null = null) {
  const objective = objectiveStub(env, objectiveId);
  await reconcileAcceptance(env, objectiveId);
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

  // Fenced in two steps: the objective verifies readiness and every member's approval inside one
  // transaction and freezes them as "accepting"; only then does the project swap its head. A swap the
  // project refuses puts the outcome back; a swap that succeeds is finished here or, if this request dies
  // first, by the next composer from the project's own record.
  await objective.beginAccept(candidateId);
  let checkpoint;
  try {
    checkpoint = await project.advance(
      { version: expectedVersion, contextDigest: head.contextDigest, policyDigest: head.policyDigest },
      c.commit, candidateId, reason?.trim() || contextReview?.trim() || `Accepted ${c.name}`,
    );
  } catch (e) {
    await objective.abortAccept(candidateId);
    throw e;
  }
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

  await mirrorMain(env, projectId, objectiveId, checkpoint, config.production);
  // Work that was not in this outcome is composed again on the new checkpoint.
  await requestCompose(env, objectiveId, `checkpoint ${checkpoint.version} accepted`);
  return { checkpoint };
}

/**
 * The project's main branch follows the accepted head, which is what its deploy pipeline (for example
 * Workers Builds) ships to production. Only the project's mirror computer, which never runs candidate
 * code, may move main. A composer calls this again whenever it finds main behind the head.
 */
export async function mirrorMain(env: Env, projectId: string, objectiveId: string, head: { version: number; commit: string; candidate: string | null }, production: string | null): Promise<boolean> {
  // A context-only checkpoint keeps the commit of the last code checkpoint; that one's candidate ref is
  // where the commit can be fetched from, so a mirror that failed earlier is still caught up.
  let candidate = head.candidate;
  if (!candidate) {
    const code = (await projectStub(env, projectId).checkpoints()).filter((c) => c.candidate && c.commit === head.commit).pop();
    if (!code?.candidate) return true;
    candidate = code.candidate;
  }
  const ref = candidateRef(candidate);
  const objective = objectiveStub(env, objectiveId);
  const name = `mirror.${projectId}`;
  const mirror = env.COMPUTERS.getByName(name);
  await mirror.configure({ computer: name, role: "mirror", project: projectId, objective: objectiveId });
  const remote = artifactsRemote(env, projectRepo(projectId));
  const r = await mirror.exec(["bash", "-lc", `rm -rf /workspace/main && git clone --quiet ${remote} /workspace/main && cd /workspace/main && git fetch --quiet origin ${ref} && git merge --ff-only --quiet ${head.commit} && git push --quiet origin HEAD:refs/heads/main`], "/workspace", {}, 180).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  await objective.log("Artifacts", "mirror", r.exitCode === 0
    ? `Fast-forwarded ${projectId} main to ${head.commit.slice(0, 7)}${production ? `; production deploys from main to ${production}` : ""}`
    : `Could not move ${projectId} main to checkpoint ${head.version}; the next composition tries again: ${r.stderr.slice(0, 200)}`);
  return r.exitCode === 0;
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

  const policyChanged = parsed.id === "policy/review-routing";
  // The context is accepted either way; a refresh that fails leaves every objective on its previous policy.
  if (policyChanged) await refreshPolicies(env, projectId).catch((e) => console.error(`review policy of ${projectId} not refreshed: ${String(e).slice(0, 200)}`));
  const radii: Record<string, { contributions: number; candidates: number; tasks: number }> = {};
  for (const o of await registryStub(env).objectives(projectId)) {
    const objective = objectiveStub(env, o.id);
    const radius = await objective.blastRadius(parsed.id, parsed.version);
    await objective.markCandidatesOutdated(radius.candidates);
    // Reviews are bound to the context they read: the agent reviews of work that cited the old version no
    // longer count, and that work is reviewed again under the new one.
    for (const id of await objective.staleReviews(radius.contributions)) {
      await env.REVIEWS.create({ id: `review-${id}-v${parsed.version}-${checkpoint.version}`, params: { objective: o.id, contribution: id } }).catch(() => undefined);
    }
    radii[o.id] = { contributions: radius.contributions.length, candidates: radius.candidates.length, tasks: radius.tasks.length };
    await objective.log("Durable Objects", "context", cur
      ? `Accepted ${parsed.id} version ${parsed.version}. Blast radius: ${radius.contributions.length} contributions, ${radius.candidates.length} outcomes, ${radius.tasks.length} running tasks cited version ${cur.version}`
      : `Added ${parsed.id}: ${title}`, { item: parsed.id, version: parsed.version, ...radius });
    // A new review policy can turn a question for a human into one more agent review.
    if (policyChanged) {
      for (const c of (await objective.state()).contributions.filter((x) => x.status === "proposed")) {
        if ((await objective.routing(c.id)).state !== "needs-reviewers") continue;
        await env.REVIEWS.create({ id: `review-${c.id}-p${checkpoint.version}`, params: { objective: o.id, contribution: c.id } }).catch(() => undefined);
      }
    }
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

/**
 * A human removes a context item: a context-only checkpoint without it, a deletion commit in the context
 * repository, and a line in every objective's log. Work that cited it keeps its citations as written.
 */
export async function removeContext(env: Env, projectId: string, id: string) {
  const project = projectStub(env, projectId);
  const head = await project.head();
  if (!head) throw new AcceptError("NOT_BOOTSTRAPPED");
  const { checkpoint, removed } = await project.removeContext(head.version, id);
  for (const o of await registryStub(env).objectives(projectId)) {
    await objectiveStub(env, o.id).log("Durable Objects", "context", `Removed ${id} (${removed.title}) at checkpoint ${checkpoint.version}`, { item: id });
  }
  const name = `context.${projectId}`;
  const writer = env.COMPUTERS.getByName(name);
  await writer.configure({ computer: name, role: "context", project: projectId, objective: "-" });
  const repo = artifactsRemote(env, contextRepo(projectId));
  const script = `rm -rf /workspace/ctx && git clone --quiet ${repo} /workspace/ctx && cd /workspace/ctx && git rm --quiet -f ${removed.path} && git -c user.name="Nest" -c user.email=context@nest.invalid commit --quiet -m "Remove ${id}" && git push --quiet origin HEAD:main`;
  const mirrored = await writer.exec(["bash", "-lc", script], "/workspace").catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  if (mirrored.exitCode !== 0) console.warn(`context repo ${contextRepo(projectId)} will catch up: ${mirrored.stderr.slice(0, 200)}`);
  return { checkpoint, removed: id, mirrored: mirrored.exitCode === 0 };
}
