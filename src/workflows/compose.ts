// ComposeWorkflow: assemble the frontier of candidate outcomes with real git, run the project's own checks
// on each one as a whole in a fresh runner, wait for the outcome's preview deployment and open it in a real
// browser, and turn regressions into repair tasks. One composer runs per objective at a time.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { smokeCheck } from "../checks/browser";
import { artifactsRemote, candidateBranch, objectiveStub, projectRepo, projectStub, short } from "../names";
import type { ObjectiveDO } from "../objective";
import { CONFIG_PATH, ConfigError, previewUrl, requiredChecks, type ProjectConfig } from "../projectconfig";
import { readProjectConfig } from "../projects";
import { acceptCandidate, mirrorMain } from "../accepting";
import { reapAttempts, repairBrief, startTask } from "../tasks";
import { ArtifactsClient } from "../artifacts";
import { sha256Hex } from "../protocol";

/** `only` recomposes exactly these outcomes (an owner's request), instead of the planner's top three. */
type Params = { objective: string; reason?: string; only?: string[] };
type Check = { id: string; status: string; detail: string };

/** Browser visits 30 seconds apart, so a preview build gets about eight minutes to appear. */
const PREVIEW_PROBES = 16;

export class ComposeWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const objectiveId = event.payload.objective;
    const objective = objectiveStub(this.env, objectiveId);
    // Composers that start while one is running leave a note instead; the running one composes again.
    const mine = await step.do("claim the composer", async () => objective.claimComposer(event.instanceId));
    if (!mine) return { deferred: true };
    try {
      // Composers run often, so this is where attempts whose workflow died are closed with the reason.
      await step.do("close attempts whose workflow died", async () => reapAttempts(this.env, objectiveId));
      return await this.compose(event, step, objective);
    } finally {
      await step.do("release the composer", async () => {
        const again = await objective.releaseComposer(event.instanceId);
        if (again) {
          await this.env.COMPOSE.create({ id: `compose-${objectiveId}-${Date.now()}`, params: { objective: objectiveId, reason: "work arrived while composing" } }).catch(() => undefined);
        }
        return { again };
      });
    }
  }

  private async compose(event: WorkflowEvent<Params>, step: WorkflowStep, objective: DurableObjectStub<ObjectiveDO>) {
    const env = this.env;
    const objectiveId = event.payload.objective;

    const plan = await step.do("plan the frontier", async () => {
      const state = await objective.state();
      const projectId = state.objective.project;
      if (!projectId) throw new Error(`objective ${objectiveId} is not initialized`);
      const head = await projectStub(env, projectId).head();
      if (!head) throw new Error("not bootstrapped");
      let config: ProjectConfig | null = null;
      let configError: string | null = null;
      try {
        config = await readProjectConfig(env, projectId, head.commit);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        configError = e.message;
      }
      const accepted = state.contributions.filter((c) => c.status === "accepted").map((c) => c.id);
      const frontier = await objective.frontier(accepted, 4);
      const byId = new Map(state.contributions.map((c) => [c.id, c]));
      const planned = [];
      const only = event.payload.only?.length ? new Set(event.payload.only) : null;
      if (only) {
        for (const k of state.candidates.filter((x) => only.has(x.id) && x.baseVersion === head.version))
          planned.push({ id: k.id, name: k.name, order: k.order, choice: k.choice, reusedAcross: [] as string[] });
      }
      for (const f of only ? [] : frontier.slice(0, 3)) {
        const id = `k${(await sha256Hex(`${head.version}|${head.contextDigest}|${f.order.join(",")}`)).slice(0, 10)}`;
        const name = outcomeName(f.order.map((cid) => byId.get(cid)!).filter(Boolean), Object.keys(f.choice).filter((g) => !/^(overlap|replace):/.test(g)).map((g) => byId.get(f.choice[g]!)!), state);
        const reusedAcross = f.order.filter((cid) => {
          const c = byId.get(cid);
          const chosenTasks = Object.values(f.choice).map((x) => byId.get(x)?.task);
          return c && !c.alternative && chosenTasks.length && !chosenTasks.includes(c.task) && state.contributions.some((o) => o.task === c.task && o.alternative && !f.order.includes(o.id));
        });
        planned.push({ id, name, order: f.order, choice: f.choice, reusedAcross });
      }
      const mainCommit = await new ArtifactsClient(env.ARTIFACTS).head(projectRepo(projectId)).catch(() => null);
      return {
        project: projectId,
        head: { version: head.version, commit: head.commit, contextDigest: head.contextDigest, policyDigest: head.policyDigest, candidate: head.candidate },
        mainBehind: mainCommit !== head.commit,
        config, configError, planned,
        picks: Object.fromEntries(state.contributions.map((c) => [c.id, { repo: c.repo, commit: c.commit, title: c.title, author: c.author, status: c.status }])),
        existing: state.candidates.map((c) => ({ id: c.id, status: c.status, previewPending: c.checks.some((k) => k.id === "preview" && k.status === "PENDING") })),
        approved: state.contributions.filter((c) => c.status === "approved").map((c) => c.id),
      };
    });

    // Production follows main. If the mirror failed at acceptance, main is behind the head: catch it up.
    if (plan.mainBehind && plan.head.candidate) {
      await step.do(`catch main up to checkpoint ${plan.head.version}`, async () => mirrorMain(env, plan.project, objectiveId, plan.head, plan.config?.production ?? null));
    }

    // A conflict between work the new plan no longer combines (for example two competing approaches, now
    // known to be one choice) is not a question for a human any more.
    if (!event.payload.only?.length) {
      await step.do("retire conflicts the plan dropped", async () => {
        const planned = new Set(plan.planned.map((c) => c.id));
        const dropped = (await objective.state()).candidates.filter((k) => k.status === "conflict" && k.baseVersion === plan.head.version && !planned.has(k.id));
        for (const k of dropped) {
          await objective.updateCandidate(k.id, { status: "superseded", note: "The plan no longer combines this work" });
          await objective.resolveInbox(`conflict-${k.id}`, "no longer planned");
        }
        return { retired: dropped.map((k) => k.id) };
      });
    }

    /**
     * Composes `order` onto the head in a fresh runner, runs the project's own setup and checks, and destroys
     * the runner. `publish` pushes the branch the project's pipeline builds as a Preview; it is true only when
     * every contribution in the outcome is approved, so unreviewed code never reaches a build.
     */
    const runOn = async (id: string, order: string[], publish: boolean) => {
      const name = `runner-${id}`;
      const computer = env.COMPUTERS.getByName(name);
      try {
        const result = await computer.compose(
          { computer: name, role: "runner", project: plan.project, objective: objectiveId, candidate: id, publish },
          { remote: artifactsRemote(env, projectRepo(plan.project)), commit: plan.head.commit },
          order.map((cid) => ({ id: cid, remote: artifactsRemote(env, plan.picks[cid]!.repo), commit: plan.picks[cid]!.commit })),
          candidateBranch(id), publish,
        );
        if (!result.ok) return { result, checks: [] as Check[] };
        const composed: Check = {
          id: "compose", status: "PASS",
          detail: order.length ? `${order.length} contributions cherry-picked onto checkpoint ${plan.head.version} without conflicts` : `checkpoint ${plan.head.version} as accepted`,
        };
        const ran: Check[] = plan.config
          ? (await computer.runChecks(plan.config.setup, plan.config.checks)).map(({ id: cid, status, detail }) => ({ id: cid, status, detail }))
          : [{ id: "config", status: "ERROR", detail: `${CONFIG_PATH} at checkpoint ${plan.head.version}: ${plan.configError}` }];
        return { result, checks: [composed, ...ran] };
      } finally {
        await computer.destroy("checks finished").catch(() => undefined);
      }
    };

    /**
     * The project deploys every branch Nest pushes as a preview (Workers Builds does this for a Worker
     * connected to the repository). A real browser opens the outcome's own deployment until it exists, and
     * the first time it answers is the check: the page must load without errors.
     */
    const previewCheck = async (id: string): Promise<Check | null> => {
      if (!plan.config?.preview) return null;
      const url = previewUrl(plan.config, candidateBranch(id));
      if (!url) return { id: "preview", status: "ERROR", detail: `no preview URL for branch ${candidateBranch(id)}` };
      let last = "nothing answered";
      for (let i = 0; i < PREVIEW_PROBES; i++) {
        if (i) await step.sleep(`preview ${id}: wait ${i}`, "30 seconds");
        const seen = await step.do(`preview ${id}: open ${i}`, { retries: { limit: 1, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
          await objective.claimComposer(event.instanceId); // re-stamps the lease for the holder
          const r = await smokeCheck(env, url);
          const deployed = r.httpStatus > 0 && r.httpStatus < 400;
          if (deployed && r.screenshot) await env.OBJECTS.put(`shots/${id}.png`, r.screenshot, { httpMetadata: { contentType: "image/png" } });
          return { deployed, check: { id: r.check.id, status: r.check.status, detail: `${url} ${r.check.detail}` } };
        });
        if (seen.deployed) return seen.check;
        last = seen.check.detail;
      }
      // Nothing deployed: the project's pipeline did not build the branch. That is not the code's doing.
      return { id: "preview", status: "ERROR", detail: `no deployment answered within ${PREVIEW_PROBES / 2} minutes of the push, so the project's pipeline did not build ${candidateBranch(id)}; last: ${last}`.slice(0, 600) };
    };

    // What the checkpoint itself passes. An outcome that fails only what the checkpoint also fails is
    // unfinished; one that fails a check the checkpoint passes has broken something.
    const checkSet = plan.config ? requiredChecks(plan.config) : ["compose", "config"];
    const baselineKey = `${plan.head.version}:${plan.head.contextDigest.slice(0, 16)}:${checkSet.join(",")}`;
    const baselineId = `b${(await sha256Hex(`${objectiveId}|${baselineKey}|${plan.head.commit}`)).slice(0, 10)}`;
    let baseline: Check[] | null = await step.do(`checkpoint ${plan.head.version}: known baseline`, async () => objective.baseline(baselineKey));
    if (!baseline) {
      const own = await step.do(`checkpoint ${plan.head.version}: compose and check`, { retries: { limit: 3, delay: "30 seconds", backoff: "linear" }, timeout: "30 minutes" }, async () => {
        // The checkpoint was accepted, so its own preview may be built.
        const r = await runOn(baselineId, [], !!plan.config?.preview);
        if (!r.result.ok) throw new Error(`checkpoint ${plan.head.version} did not check out on its own: ${r.result.detail.slice(0, 300)}`);
        return r.checks;
      });
      const preview = await previewCheck(baselineId);
      const measured = [...own, ...(preview ? [preview] : [])];
      await step.do(`checkpoint ${plan.head.version}: record baseline`, async () => {
        await objective.setBaseline(baselineKey, measured);
        await objective.log("Sandbox", "baseline", `Checkpoint ${plan.head.version} passes ${measured.filter((k) => k.status === "PASS").length} of ${measured.length} checks on its own`);
      });
      baseline = measured;
    }
    const base = baseline;
    const passingAtHead = new Set(base.filter((k) => k.status === "PASS").map((k) => k.id));

    // A context change can make the accepted checkpoint itself fall short: what passed when it was accepted
    // fails under the new requirements. That is a regression of the head, repaired from the head's own tree.
    await step.do(`regressions of checkpoint ${plan.head.version}`, async () => {
      const state = await objective.state();
      const accepted = state.candidates.find((x) => x.status === "accepted" && x.commit === plan.head.commit);
      if (!accepted) return { regressed: [] };
      const regressed = base.filter((k) => k.status !== "PASS" && accepted.checks.some((a) => a.id === k.id && a.status === "PASS"));
      if (regressed.length)
        await openRepair(env, objectiveId, `h${plan.head.commit.slice(0, 10)}`, `checkpoint ${plan.head.version}`,
          `${event.payload.reason ? `After ${event.payload.reason}, ` : ""}checks that passed when it was accepted now fail:\n${regressed.map((f) => `${f.id}: ${f.detail}`).join("\n")}`,
          plan.head.commit, plan.head.version);
      return { regressed: regressed.map((k) => k.id) };
    });

    const atHead = new Map(base.map((k) => [k.id, k.status]));
    const withHead = (checks: Check[]) => checks.map((k) => ({ ...k, atHead: atHead.get(k.id) ?? null }));

    const verify = async (c: (typeof plan.planned)[number]) => {
      const prior = plan.existing.find((e) => e.id === c.id);
      // A waiting outcome whose preview held for approval is composed again once every member is approved.
      const nowApproved = c.order.every((id) => plan.approved.includes(id));
      const unblocked = prior?.status === "waiting" && prior.previewPending && nowApproved;
      if (prior && !["composing", "checking", "outdated"].includes(prior.status) && !unblocked) return { id: c.id, skipped: prior.status };

      const composed = await step.do(`compose ${c.id}`, { retries: { limit: 2, delay: "15 seconds", backoff: "linear" }, timeout: "30 minutes" }, async () => {
        await objective.claimComposer(event.instanceId); // re-stamps the lease for the holder
        const note = c.reusedAcross.length
          ? `Keeps ${c.reusedAcross.map((id) => `${short(id)} ${plan.picks[id]?.title ?? ""}`).join(", ")} from an approach that was not chosen.`
          : null;
        await objective.upsertCandidate({
          id: c.id, name: c.name, baseVersion: plan.head.version, baseCommit: plan.head.commit, contextDigest: plan.head.contextDigest,
          policyDigest: plan.head.policyDigest, order: c.order, choice: c.choice, status: "composing", commit: null, checks: [],
          previewReady: false, note, conflict: null,
        });
        await objective.log("Workflows", "candidate", `Composer planned ${c.name}: ${c.order.map(short).join(" + ")}`, { candidate: c.id });
        const fresh = await objective.state();
        const approved = c.order.every((id) => fresh.contributions.find((x) => x.id === id)?.status === "approved");
        const r = await runOn(c.id, c.order, approved && !!plan.config?.preview);
        const result = r.result;
        // A conflict names the files git could not merge. Anything else (clone, fetch, push) is ours: retry.
        if (!result.ok && (!result.paths.length || ["clone", "base", "push"].includes(result.at))) throw new Error(`composition failed at ${result.at}: ${result.detail.slice(0, 300)}`);
        if (!result.ok) {
          if (result.partial && /^[0-9a-f]{40}$/.test(result.partial)) {
            const before = c.order.slice(0, Math.max(0, c.order.indexOf(result.at)));
            if (before.length) await objective.recordMaterialization(result.partial, before);
            await objective.setConflictBasis(c.id, { commit: result.partial, at: result.at, before });
          }
          const detail = `Cherry-picking ${short(result.at)} conflicted${result.paths.length ? ` in ${result.paths.join(", ")}` : ""}`;
          // git's own advice ("hint: ...") is for a terminal, not for the human deciding.
          const gitSays = result.detail.split("\n").filter((l) => l.trim() && !/^hint:/.test(l.trim())).join(" ").slice(0, 400);
          await objective.updateCandidate(c.id, { status: "conflict", conflict: `${detail}. ${gitSays}`.slice(0, 1500) }, { svc: "Sandbox", text: `${c.name}: ${detail}` });
          // A real overlap is a choice for a human, not a bug for an agent to rewrite.
          await objective.openInbox({ id: `conflict-${c.id}`, kind: "conflict", target: c.id, reasons: [`${detail}. Choose which contribution to keep, or start a task to reconcile them.`] });
          return { ok: false as const };
        }
        await objective.recordMaterialization(result.commit, c.order);
        await objective.resolveInbox(`conflict-${c.id}`, "composed cleanly");
        const passed = r.checks.filter((k) => k.status === "PASS").length;
        await objective.updateCandidate(c.id, { status: "checking", commit: result.commit, checks: withHead(r.checks), conflict: null }, {
          svc: "Sandbox",
          text: `Composed ${c.name} with real git and ran the project's checks: ${passed} of ${r.checks.length} passed${plan.config?.preview ? "; waiting for its preview deployment" : ""}`,
        });
        return { ok: true as const, commit: result.commit, checks: r.checks, published: result.published };
      });
      if (!composed.ok) return { id: c.id, conflict: true };

      const preview: Check | null = !plan.config?.preview ? null
        : composed.published ? await previewCheck(c.id)
        : { id: "preview", status: "PENDING", detail: "The preview is built once every contribution in this outcome is approved, so unreviewed code never reaches a build" };

      return step.do(`settle ${c.id}`, async () => {
        const checks = [...composed.checks, ...(preview ? [preview] : [])];
        const failed = checks.filter((x) => x.status !== "PASS" && x.status !== "PENDING");
        const state = await objective.state();
        const membersApproved = c.order.every((id) => state.contributions.find((x) => x.id === id)?.status === "approved");
        // A preview that never deployed is composed again once: a new composition is a new commit, which
        // the pipeline builds afresh. The second time, the outcome stays incomplete for a human to see.
        if (preview?.status === "ERROR" && /did not build/.test(preview.detail) && !(await objective.previewRetried(c.id))) {
          await objective.markPreviewRetried(c.id);
          await objective.updateCandidate(c.id, { status: "outdated", commit: composed.commit, checks: withHead(checks), previewReady: false, conflict: null }, { svc: "Workers Builds", text: `${c.name}: its preview did not deploy; composing it again` });
          await env.COMPOSE.create({ id: `compose-${objectiveId}-retry-${c.id}-${Date.now()}`, params: { objective: objectiveId, reason: "a preview did not deploy", only: [c.id] } }).catch(() => undefined);
          return { id: c.id, status: "retrying" };
        }
        // An ERROR is Nest's or the pipeline's, never the code's: it leaves an outcome incomplete, not broken.
        const broken = failed.filter((f) => f.status !== "ERROR" && passingAtHead.has(f.id));
        const pending = checks.some((x) => x.status === "PENDING");
        const status = broken.length ? "failing" : failed.length ? "incomplete" : membersApproved && !pending ? "ready" : "waiting";
        const passed = checks.filter((x) => x.status === "PASS").length;
        await objective.updateCandidate(c.id, { status, commit: composed.commit, checks: withHead(checks), previewReady: preview?.status === "PASS", conflict: null }, {
          svc: preview && !pending ? "Browser Rendering" : "Sandbox",
          text: `${c.name}: ${passed} of ${checks.length} checks passed${failed.length ? `; ${failed.map((f) => f.id).join(", ")} failed` : ""}${pending ? "; the preview waits until every contribution is approved" : ""}`,
        });
        if (status === "ready") await objective.openInbox({ id: `accept-${c.id}`, kind: "accept", target: c.id, reasons: [`${c.name} is ready to accept`] });
        // Repair regressions only: a check that passed for this same selection of work before (for example
        // under an older requirement version) and fails now. An unfinished objective is not a regression.
        const before = state.candidates.filter((x) => x.id !== c.id && x.order.join(",") === c.order.join(",") && x.checks.length);
        const regressed = failed.filter((f) => before.some((b) => b.checks.some((k) => k.id === f.id && k.status === "PASS")));
        if (failed.length && membersApproved && regressed.length) {
          await openRepair(env, objectiveId, c.id, c.name, regressed.map((f) => `${f.id}: ${f.detail}`).join("\n"), composed.commit, plan.head.version);
        }
        return { id: c.id, status };
      });
    };

    const results = await Promise.all(plan.planned.map(verify));

    // A human can let Nest accept ready outcomes. Never one that chooses between competing approaches or
    // overlapping work: that choice is a human's. The head moves by the same compare-and-swap as a human's.
    const auto = await step.do("accept automatically", { retries: { limit: 2, delay: "15 seconds", backoff: "linear" }, timeout: "5 minutes" }, async () => {
      const state = await objective.state();
      if (!state.policy.autoAccept) return { accepted: null as string | null, skipped: [] as string[] };
      const head = await projectStub(env, plan.project).head();
      if (!head || head.version !== plan.head.version) return { accepted: null, skipped: [] };
      const rank = new Map(plan.planned.map((c, i) => [c.id, i]));
      const ready = state.candidates
        .filter((c) => c.status === "ready" && c.baseVersion === head.version)
        .sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
      const skipped: string[] = [];
      const current = new Map((await projectStub(env, plan.project).context()).map((i) => [i.id, i.version]));
      for (const c of ready) {
        if (Object.keys(c.choice).some((g) => !g.startsWith("replace:"))) {
          skipped.push(c.id);
          continue;
        }
        // Work written against an older requirement version needs a human's context review.
        const stale = c.order.flatMap((id) => state.contributions.find((x) => x.id === id)?.cites ?? []).some((x) => (current.get(x.item) ?? 0) > x.version);
        if (stale) {
          await objective.log("Nest", "auto-accept", `${c.name} is ready but cites an older version of a requirement, so a human reviews it`, { candidate: c.id });
          continue;
        }
        try {
          const r = await acceptCandidate(env, objectiveId, c.id, head.version, null, "Accepted automatically: every check passed and every contribution was approved");
          await objective.log("Nest", "auto-accept", `Accepted ${c.name} automatically, as this project's policy allows`, { candidate: c.id, checkpoint: r.checkpoint.version });
          return { accepted: c.id, skipped };
        } catch (e) {
          await objective.log("Nest", "auto-accept", `Could not accept ${c.name} automatically: ${String((e as Error)?.message ?? e).slice(0, 200)}`, { candidate: c.id });
        }
      }
      if (skipped.length) await objective.log("Nest", "auto-accept", `${skipped.length === 1 ? "An outcome is" : `${skipped.length} outcomes are`} ready but choose${skipped.length === 1 ? "s" : ""} between competing work, so a human decides`);
      return { accepted: null, skipped };
    });
    return { composed: results.length, results, autoAccepted: auto.accepted };
  }
}

/**
 * Names an outcome the way a human would: the approach it takes and who built it, for example
 * "Consecutive-failure incidents, by Heron and Wren". Without a chosen approach it falls back to the work itself.
 */
function outcomeName(members: { task: string | null; author: string; title: string }[], approaches: { task: string | null }[], state: { tasks: { id: string; title: string }[]; participants: { id: string; name: string }[] }): string {
  const nameOf = (id: string) => state.participants.find((p) => p.id === id)?.name ?? id;
  const authors = [...new Set(members.map((m) => nameOf(m.author)))].sort();
  const by = authors.length > 1 ? `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}` : authors[0] ?? "nobody";
  const tidy = (t: string) => { const x = t.replace(/^(explore|try|build|add)\s+(an?|the)\s+/i, ""); return x[0]!.toUpperCase() + x.slice(1); };
  const approach = approaches.map((a) => state.tasks.find((t) => t.id === a.task)?.title).filter((t): t is string => !!t).map(tidy);
  // Without a chosen approach, name the features: the tasks the work was written for, minus repairs.
  const features = [...new Set(members.filter((m) => m.task && !/^t_(repair|reconcile)-/.test(m.task)).map((m) => state.tasks.find((t) => t.id === m.task)?.title).filter((t): t is string => !!t).map(tidy))];
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)!.toLowerCase()}` : xs[0]!);
  // Only owner-written task titles and registered names go into a name: it becomes a repair task's title.
  const what = approach.length ? approach.join(" with ") : features.length ? list(features) : members.length === 1 ? "One contribution" : `${members.length} contributions`;
  return `${what}, by ${by}`;
}

/**
 * A failing outcome becomes a task. The repair builds on the composed tree itself. The failure detail is
 * output from running contributed code, so it reaches the agent only as data inside a random boundary.
 */
async function openRepair(env: Env, objectiveId: string, candidateId: string, name: string, detail: string, baseCommit: string, baseVersion: number) {
  const objective = objectiveStub(env, objectiveId);
  const id = `t_repair-${candidateId.slice(1, 9)}`;
  const existing = await objective.task(id);
  if (existing) return;
  await objective.createTask({
    id, title: `Repair ${name.replace(/^Outcome: /, "")}`, baseVersion, baseCommit,
    brief: repairBrief(candidateId.startsWith("h") ? `The accepted ${name}` : `The composed outcome ${candidateId}`, detail),
  });
  // One automatic repair at a time: a cascade is impossible whatever else goes wrong.
  if (env.AUTO_REPAIR_AGENT && !(await objective.repairRunning())) {
    await startTask(env, objectiveId, id, env.AUTO_REPAIR_AGENT, "agent").catch((e) => objective.log("Workflows", "repair", `Could not start the repair automatically: ${String(e).slice(0, 200)}`));
  }
}
