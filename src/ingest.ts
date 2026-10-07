// Push ingestion. The same idempotent path runs for Artifacts push events and for explicit publish calls.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ArtifactsClient } from "./artifacts";
import { authoredOn, GraphError } from "./domain/graph";
import { contributionId, parseTrailers, SHA1, subjectLine } from "./protocol";
import { objectiveStub, projectStub, parseWorkspaceRepo } from "./names";

export type IngestOutcome =
  | { commit: string; status: "registered" | "known"; contribution: string }
  | { commit: string; status: "rejected"; reason: string };

/** Registers every new commit on a workspace repo's main branch, oldest first. */
export async function ingestPush(env: Env, repo: string, after: string): Promise<IngestOutcome[]> {
  const ws = parseWorkspaceRepo(repo);
  if (!ws || !SHA1.test(after)) return [];
  const objective = objectiveStub(env, ws.objective);
  const project = projectStub(env);
  const generation = await objective.generation().catch(() => null);
  if (generation !== ws.generation) return [{ commit: after, status: "rejected", reason: "workspace belongs to an earlier generation of this objective" }];
  const attempt = await objective.attemptForRepo(repo);
  if (!attempt) return [{ commit: after, status: "rejected", reason: "repository is not a Nest task workspace" }];

  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const checkpoints = await project.checkpoints();
  const checkpointCommits = new Set(checkpoints.map((c) => c.commit));
  const authoring = await objective.authoringIndex();
  const byCommit = new Map(authoring.byCommit.map((b) => [b.commit, { id: b.id, requires: b.requires }] as const));
  const materializations = new Map(authoring.materializations.map((m) => [m.commit, m.deps] as const));
  const stop = new Set([...checkpointCommits, ...byCommit.keys(), ...materializations.keys()]);
  const fresh = (await artifacts.newCommits(repo, after, stop)).reverse();
  const out: IngestOutcome[] = [];

  for (const sha of fresh) {
    const facts = await artifacts.commit(repo, sha);
    if (!facts) { out.push({ commit: sha, status: "rejected", reason: "commit not readable" }); break; }
    const reject = async (reason: string) => {
      out.push({ commit: sha, status: "rejected", reason });
      await objective.log("Queues", "rejected", `Rejected ${sha.slice(0, 7)} from ${repo}: ${reason}`, { repo, commit: sha });
    };
    if (facts.parents.length !== 1) { await reject("merge and root commits are not contributions"); break; }
    const trailers = parseTrailers(facts.message);
    if (!attempt.current) { await reject(`attempt ${attempt.epoch} of ${attempt.task} is fenced`); break; }
    if (trailers.attempt && (trailers.attempt.task !== attempt.task || trailers.attempt.epoch !== attempt.epoch)) {
      await reject(`Nest-Attempt says ${trailers.attempt.task}/e${trailers.attempt.epoch}, but this workspace belongs to ${attempt.task}/e${attempt.epoch}`);
      break;
    }
    const parent = facts.parents[0]!;
    let authored: string[];
    try {
      authored = authoredOn(parent, { checkpointCommits, byCommit, materializations });
    } catch (e) {
      await reject(e instanceof GraphError ? e.message : String(e));
      break;
    }
    const known = new Set([...byCommit.values()].map((v) => v.id));
    const unknownDeclared = trailers.requires.filter((id) => !known.has(id));
    if (unknownDeclared.length) { await reject(`Nest-Requires names unknown contributions ${unknownDeclared.join(", ")}`); break; }
    const parentFacts = await artifacts.commit(repo, parent);
    const diff = await artifacts.diffTrees(repo, parentFacts?.tree ?? null, facts.tree);
    if (!diff.paths.length) { await reject("empty change"); break; }
    const id = await contributionId(env.ARTIFACTS_NAMESPACE, repo, sha);
    const requires = [...new Set([...authored, ...trailers.requires])].sort();
    let result: { created: boolean };
    try {
      result = await objective.registerContribution({
        id, task: attempt.task, epoch: attempt.epoch, author: attempt.participant, repo, commit: sha, parent,
        title: subjectLine(facts.message) || sha.slice(0, 7), message: facts.message.slice(0, 8000),
        alternative: trailers.alternative ?? null, supersedes: trailers.supersedes ?? null,
        paths: diff.paths.map((p) => p.path), adds: diff.paths.filter((p) => p.change === "add").map((p) => p.path), special: diff.special, requires, declared: trailers.requires,
        cites: trailers.cites, assumes: trailers.assumes,
      });
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      // Rule violations are the contributor's to fix; anything else is retried by the workflow.
      if (/NOT_YOUR_CONTRIBUTION|ALREADY_ACCEPTED|MISSING_DEPENDENCY|STALE_EPOCH|ATTEMPT_MISMATCH/.test(m)) { await reject(m); break; }
      throw e;
    }
    byCommit.set(sha, { id, requires });
    out.push({ commit: sha, status: result.created ? "registered" : "known", contribution: id });
  }
  if (out.some((o) => o.status === "registered") && !(await objective.isSwarm())) await ensureReviews(env, ws.objective);
  return out;
}

/**
 * Every proposed contribution without a review gets a review workflow. Instance ids are derived from the
 * contribution, so this is idempotent, and a review lost to a failed start is picked up by the next push.
 */
export async function ensureReviews(env: Env, objectiveId: string): Promise<{ started: string[]; failed: string[] }> {
  const objective = objectiveStub(env, objectiveId);
  const state = await objective.state();
  const reviewed = new Set(state.reviews.map((r) => r.target));
  const started: string[] = [];
  const failed: string[] = [];
  for (const c of state.contributions) {
    if (c.status !== "proposed" || reviewed.has(c.id)) continue;
    try {
      await env.REVIEWS.create({ id: `review-${c.id}`, params: { objective: objectiveId, contribution: c.id } });
      started.push(c.id);
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/already|exists|duplicate/i.test(m)) continue;
      failed.push(c.id);
      await objective.log("Workflows", "review-start-failed", `Could not start the review of ${c.title}: ${m.slice(0, 200)}`, { contribution: c.id });
    }
  }
  return { started, failed };
}

type PushEvent = { repo: string; ref: string; after: string };

/** The Artifacts trigger payload shape is undocumented; accept the documented event body and common wrappers. */
export function readPushEvent(payload: unknown): PushEvent | null {
  const seen = new Set<unknown>();
  const visit = (v: unknown): PushEvent | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    const source = o.source as Record<string, unknown> | undefined;
    const body = (o.payload ?? o.data ?? o) as Record<string, unknown>;
    const repo = (source?.repoName ?? source?.repo_name ?? o.repoName ?? o.repo_name ?? body.repoName) as string | undefined;
    const after = (body.after ?? o.after) as string | undefined;
    const ref = (body.ref ?? o.ref ?? "refs/heads/main") as string;
    if (typeof repo === "string" && typeof after === "string") return { repo, ref, after };
    for (const child of Object.values(o)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(payload);
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const push = readPushEvent(event.payload);
    if (!push) {
      await step.do("record unrecognised event", async () => {
        const keys = event.payload && typeof event.payload === "object" ? Object.keys(event.payload as object) : [];
        console.log("nest-ingest: unrecognised event", JSON.stringify(event.payload).slice(0, 2000));
        return { keys };
      });
      return { ignored: true };
    }
    if (push.ref !== "refs/heads/main") return { ignored: true, ref: push.ref };
    return await step.do(`ingest ${push.repo}@${push.after.slice(0, 12)}`, { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" }, async () => {
      const results = await ingestPush(this.env, push.repo, push.after);
      return { repo: push.repo, results };
    });
  }
}
