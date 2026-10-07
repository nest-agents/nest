// Acceptance and context change: the two ways a person moves the project forward.

import { acceptError, type CandidateFacts } from "./domain/accept";
import { HARBOR_CHECKS } from "./checks/harbor";
import { parseContextFile, renderContextFile } from "./context";
import { contextRepo, objectiveStub, projectRepo, projectStub, short } from "./names";

export class AcceptError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

export async function acceptCandidate(env: Env, candidateId: string, expectedVersion: number, contextReview: string | null) {
  const project = projectStub(env);
  const objective = objectiveStub(env);
  const head = await project.head();
  const context = await project.context();
  const state = await objective.state();
  if (!head) throw new AcceptError("NOT_BOOTSTRAPPED");
  const c = state.candidates.find((x) => x.id === candidateId);
  if (!c || !c.commit) throw new AcceptError("NOT_READY", "This outcome has not been composed and checked");
  const members = c.order.map((id) => state.contributions.find((x) => x.id === id));
  const current = new Map(context.map((i) => [i.id, i.version]));
  const stale = members.flatMap((m) => m?.cites ?? []).filter((x) => (current.get(x.item) ?? 0) > x.version);
  const facts: CandidateFacts = {
    baseVersion: c.baseVersion, contextDigest: c.contextDigest, policyDigest: c.policyDigest,
    checks: c.checks, requiredChecks: [...HARBOR_CHECKS],
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
    c.commit, candidateId, contextReview?.trim() || `Accepted ${c.name}`,
  );
  await objective.markAccepted(candidateId, checkpoint);
  await objective.log("Durable Objects", "accept", `Compare-and-swap moved the project head from checkpoint ${head.version} to ${checkpoint.version}`, { candidate: candidateId, checkpoint: checkpoint.version });

  // Every alternative that lost becomes a note with its reason, so later agents start informed.
  for (const [group, chosen] of Object.entries(c.choice)) {
    for (const loser of state.contributions.filter((x) => x.alternative === group && x.id !== chosen)) {
      const reasons = state.reviews.filter((r) => r.target === loser.id && !r.triage && r.verdict !== "approve").map((r) => r.summary).filter(Boolean);
      await project.addNote({
        id: `rej/${group}-${short(loser.id)}`, kind: "rejected", title: loser.title, source: loser.id,
        body: `In group "${group}", ${short(loser.id)} "${loser.title}" was not chosen at checkpoint ${checkpoint.version}; ${short(chosen)} was. ${reasons.length ? `Reviews against it: ${reasons.join(" ")}` : "Its reviews did not object; it lost on the person's choice."}`,
      });
      await objective.log("Artifacts", "note", `Recorded why ${short(loser.id)} ${loser.title} was not chosen`, { note: `rej/${group}-${short(loser.id)}` });
    }
  }

  // The Artifacts main branch mirrors the accepted head; Workers Builds deploys it when connected.
  // A dedicated mirror computer that never runs candidate code is the only one allowed to move main.
  const mirror = env.COMPUTERS.getByName("mirror");
  await mirror.configure({ computer: "mirror", role: "mirror", objective: "harbor-export" });
  const remote = `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${projectRepo(env)}.git`;
  const mirrored = await mirror.exec(["bash", "-lc", `rm -rf /workspace/main && git clone --quiet ${remote} /workspace/main && cd /workspace/main && git fetch --quiet origin ${candidateBranchName(candidateId)} && git merge --ff-only --quiet ${c.commit} && git push --quiet origin HEAD:refs/heads/main`], "/workspace", {}, 180).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  await objective.log("Artifacts", "mirror", mirrored.exitCode === 0 ? `Fast-forwarded main to ${c.commit.slice(0, 7)}` : `Main will catch up: ${mirrored.stderr.slice(0, 200)}`);
  return { checkpoint };
}

const candidateBranchName = (id: string) => `cand-${id}`;

/**
 * A person accepts a new version of a context item. The head gets a context-only checkpoint; work that
 * cited the old version is found by the citation index, its outcomes are marked outdated, and the
 * frontier is recomposed under the new requirement.
 */
export async function changeContext(env: Env, id: string, body: string, title?: string) {
  const project = projectStub(env);
  const objective = objectiveStub(env);
  const head = await project.head();
  if (!head) throw new AcceptError("NOT_BOOTSTRAPPED");
  const cur = (await project.context()).find((i) => i.id === id);
  if (!cur) throw new AcceptError("NOT_FOUND", `no context item ${id}`);
  const nextText = renderContextFile({ ...cur, version: cur.version + 1, body: body.trim(), title: title ?? cur.title });
  const parsed = parseContextFile(cur.path, nextText, head.commit);
  if (!parsed) throw new AcceptError("INVALID_CONTEXT");
  const { checkpoint } = await project.acceptContext(head.version, parsed);
  const radius = await objective.blastRadius(id, parsed.version);
  await objective.markCandidatesOutdated(radius.candidates);
  await objective.log("D1", "context", `Accepted ${id} version ${parsed.version}. Blast radius: ${radius.contributions.length} contributions, ${radius.candidates.length} outcomes, ${radius.tasks.length} running tasks cited version ${cur.version}`, {
    item: id, version: parsed.version, ...radius,
  });
  if (id === "policy/review-routing" && parsed.policy) await objective.setPolicy(parsed.policy as never);
  try { await env.COMPOSE.create({ id: `compose-${await objective.generation()}-ctx-${checkpoint.version}`, params: { objective: "harbor-export", reason: `context ${id} v${parsed.version}` } }); } catch { /* already running */ }

  // Mirror the new version into the context repository so the history is ordinary git.
  const writer = env.COMPUTERS.getByName("context-writer");
  const repo = `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${contextRepo(env)}.git`;
  const script = `rm -rf /workspace/ctx && git clone --quiet ${repo} /workspace/ctx && cd /workspace/ctx && mkdir -p "$(dirname ${cur.path})" && cat > ${cur.path} && git -c user.name="Nest" -c user.email=context@nest.invalid commit --quiet -am "Accept ${id} version ${parsed.version}" && git push --quiet origin HEAD:main`;
  await writer.configure({ computer: "context-writer", role: "context", objective: "harbor-export" });
  const mirrored = await writer.execWithInput(["bash", "-lc", script], nextText).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  await objective.log("Artifacts", "context", mirrored.exitCode === 0 ? `Committed ${id} version ${parsed.version} to ${contextRepo(env)}` : `Context repo will catch up: ${mirrored.stderr.slice(0, 200)}`);
  return { checkpoint, radius };
}
