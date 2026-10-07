// ComposeWorkflow: assemble the frontier of candidate outcomes with real git, check each one as a whole
// from outside its container, open a live preview, and turn failures into repair tasks.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ArtifactsClient } from "../artifacts";
import { exportByClick } from "../checks/browser";
import { HARBOR_CHECKS, runHarborChecks } from "../checks/harbor";
import { candidateBranch, objectiveStub, projectRepo, projectStub, short } from "../names";
import { sha256Hex } from "../protocol";

type Params = { objective: string; reason?: string };

const remoteOf = (env: Env, repo: string) => `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${repo}.git`;

export class ComposeWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const objectiveId = event.payload.objective;
    const objective = objectiveStub(this.env, objectiveId);
    const project = projectStub(this.env);
    const artifacts = new ArtifactsClient(this.env.ARTIFACTS);

    const plan = await step.do("plan the frontier", async () => {
      const head = await project.head();
      const checkpoints = await project.checkpoints();
      const context = await project.context();
      const state = await objective.state();
      if (!head) throw new Error("not bootstrapped");
      const accepted = state.contributions.filter((c) => c.status === "accepted").map((c) => c.id);
      const frontier = await objective.frontier(accepted, 4);
      const columns = ((context.find((i) => i.id === "req/export-columns")?.policy as { columns?: string[] } | null)?.columns) ?? [];
      const seed = await artifacts.readBytes(projectRepo(this.env), checkpoints[0]!.commit, "src/data.ts");
      const byId = new Map(state.contributions.map((c) => [c.id, c]));
      const planned = [];
      for (const f of frontier.slice(0, 3)) {
        const id = `k${(await sha256Hex(`${head.version}|${head.contextDigest}|${f.order.join(",")}`)).slice(0, 10)}`;
        const name = outcomeName(f.order.map((cid) => byId.get(cid)!).filter(Boolean), Object.keys(f.choice).filter((g) => !g.startsWith("overlap:")).map((g) => byId.get(f.choice[g]!)!), state);
        const reusedAcross = f.order.filter((cid) => {
          const c = byId.get(cid);
          const chosenTasks = Object.values(f.choice).map((x) => byId.get(x)?.task);
          return c && !c.alternative && chosenTasks.length && !chosenTasks.includes(c.task) && state.contributions.some((o) => o.task === c.task && o.alternative && !f.order.includes(o.id));
        });
        planned.push({ id, name, order: f.order, choice: f.choice, ready: f.ready, reusedAcross });
      }
      return {
        head: { version: head.version, commit: head.commit, contextDigest: head.contextDigest, policyDigest: head.policyDigest },
        columns, dataSha256: seed ? await sha256Hex(seed) : "", planned,
        picks: Object.fromEntries(state.contributions.map((c) => [c.id, { repo: c.repo, commit: c.commit, title: c.title, author: c.author, status: c.status }])),
        existing: state.candidates.map((c) => ({ id: c.id, status: c.status })),
      };
    });

    if (!plan.planned.length) return { composed: 0 };

    // What the checkpoint itself passes. An outcome that fails only what the checkpoint also fails is
    // unfinished; one that fails a check the checkpoint passes has broken something.
    // The key names the check set too, so adding a check re-measures the checkpoint.
    const baselineKey = `${plan.head.version}:${plan.head.contextDigest.slice(0, 16)}:${[...HARBOR_CHECKS, "export-click"].length}`;
    // Generous retries: right after a deploy, Durable Objects can run the previous code for a minute or more.
    const baseline = await step.do(`measure checkpoint ${plan.head.version}`, { retries: { limit: 5, delay: "20 seconds", backoff: "linear" }, timeout: "10 minutes" }, async () => {
      const known = await objective.baseline(baselineKey);
      if (known) return known;
      const id = `base-${plan.head.version}-${plan.head.commit.slice(0, 10)}-${plan.head.contextDigest.slice(0, 6)}`;
      const computerName = `runner-${id}`;
      const computer = this.env.COMPUTERS.getByName(computerName);
      try {
        const composed = await computer.compose(
          { computer: computerName, role: "runner", objective: objectiveId, candidate: id },
          { remote: remoteOf(this.env, projectRepo(this.env)), commit: plan.head.commit }, [], candidateBranch(id),
        );
        if (!composed.ok) return [];
        const served = await computer.serveCandidate();
        if (!served.ok) return [];
        const data = await artifacts.readBytes(projectRepo(this.env), plan.head.commit, "src/data.ts");
        const call = (path: string, viewer: string | null, method = "GET") =>
          computer.serve(new Request(new URL(path, "http://candidate"), { method, headers: viewer ? { "x-harbor-viewer": viewer } : {} }));
        const checks = [
          ...(await runHarborChecks(call, { columns: plan.columns, dataSha256: plan.dataSha256 }, data ? await sha256Hex(data) : "missing", 25_000)),
          (await exportByClick(this.env, `${this.env.PUBLIC_URL}/preview/${id}/`, plan.columns, (path, viewer) => call(path, viewer))).check,
        ];
        await objective.setBaseline(baselineKey, checks);
        await objective.log("Sandbox", "baseline", `Checkpoint ${plan.head.version} passes ${checks.filter((k) => k.status === "PASS").length} of ${checks.length} checks on its own`);
        return checks;
      } finally {
        await computer.destroy("baseline measured").catch(() => undefined);
      }
    });
    const passingAtHead = new Set(baseline.filter((k) => k.status === "PASS").map((k) => k.id));

    await Promise.all(plan.planned.map((c) =>
      step.do(`compose ${c.id}`, { retries: { limit: 1, delay: "10 seconds" }, timeout: "10 minutes" }, async () => {
        const prior = plan.existing.find((e) => e.id === c.id);
        if (prior && !["composing", "outdated"].includes(prior.status)) return { skipped: prior.status };
        const note = c.reusedAcross.length
          ? `Keeps ${c.reusedAcross.map((id) => `${short(id)} ${plan.picks[id]?.title ?? ""}`).join(", ")} from an approach that was not chosen.`
          : null;
        await objective.upsertCandidate({
          id: c.id, name: c.name, baseVersion: plan.head.version, baseCommit: plan.head.commit, contextDigest: plan.head.contextDigest,
          policyDigest: plan.head.policyDigest, order: c.order, choice: c.choice, status: "composing", commit: null, checks: [],
          previewReady: false, note, conflict: null,
        });
        await objective.log("Workflows", "candidate", `Composer planned ${c.name}: ${c.order.map(short).join(" + ")}`, { candidate: c.id });
        const computerName = `runner-${c.id}`;
        const computer = this.env.COMPUTERS.getByName(computerName);
        const result = await computer.compose(
          { computer: computerName, role: "runner", objective: objectiveId, candidate: c.id },
          { remote: remoteOf(this.env, projectRepo(this.env)), commit: plan.head.commit },
          c.order.map((id) => ({ id, remote: remoteOf(this.env, plan.picks[id]!.repo), commit: plan.picks[id]!.commit })),
          candidateBranch(c.id),
        );
        if (!result.ok) {
          const detail = `Cherry-picking ${short(result.at)} conflicted${result.paths.length ? ` in ${result.paths.join(", ")}` : ""}`;
          await objective.updateCandidate(c.id, { status: "conflict", conflict: `${detail}. ${result.detail}`.slice(0, 1500) }, { svc: "Sandbox", text: `${c.name}: ${detail}` });
          // A real overlap is a choice for a person, not a bug for an agent to rewrite.
          await objective.openInbox({ id: `conflict-${c.id}`, kind: "conflict", target: c.id, reasons: [`${detail}. Choose which contribution to keep, or start a task to reconcile them.`] });
          return { conflict: result.at };
        }
        await objective.recordMaterialization(result.commit, c.order);
        await objective.log("Sandbox", "candidate", `Cherry-picked ${c.order.length} contributions onto checkpoint ${plan.head.version} with real git`, { candidate: c.id, commit: result.commit });
        const served = await computer.serveCandidate();
        const candidateData = await artifacts.readBytes(projectRepo(this.env), result.commit, "src/data.ts");
        const actual = candidateData ? await sha256Hex(candidateData) : "missing";
        const call = (path: string, viewer: string | null, method = "GET") =>
          computer.serve(new Request(new URL(path, "http://candidate"), { method, headers: viewer ? { "x-harbor-viewer": viewer } : {} }));
        const checks: { id: string; status: string; detail: string }[] = served.ok
          ? await runHarborChecks(call, { columns: plan.columns, dataSha256: plan.dataSha256 }, actual, 25_000)
          : HARBOR_CHECKS.map((id) => ({ id, status: "ERROR" as const, detail: `candidate did not start: ${served.detail}`.slice(0, 500) }));
        if (served.ok) {
          // A real browser clicks the button on the live preview; the screenshot goes on the outcome card.
          const click = await exportByClick(this.env, `${this.env.PUBLIC_URL}/preview/${c.id}/`, plan.columns, (path, viewer) => call(path, viewer));
          checks.push(click.check);
          if (click.screenshot) await this.env.OBJECTS.put(`shots/${c.id}.png`, click.screenshot, { httpMetadata: { contentType: "image/png" } });
        }
        const failed = checks.filter((x) => x.status !== "PASS");
        const state = await objective.state();
        const membersApproved = c.order.every((id) => state.contributions.find((x) => x.id === id)?.status === "approved");
        const broken = failed.filter((f) => passingAtHead.has(f.id));
        const status = broken.length ? "failing" : failed.length ? "incomplete" : membersApproved ? "ready" : "waiting";
        const atHead = new Map(baseline.map((k) => [k.id, k.status]));
        await objective.updateCandidate(c.id, { status, commit: result.commit, checks: checks.map((k) => ({ ...k, atHead: atHead.get(k.id) ?? null })), previewReady: served.ok }, {
          svc: "Sandbox",
          text: `Trusted checks on ${c.name}: ${checks.length - failed.length} of ${checks.length} passed${failed.length ? `; ${failed.map((f) => f.id).join(", ")} failed` : ""}`,
        });
        if (status === "ready") await objective.openInbox({ id: `accept-${c.id}`, kind: "accept", target: c.id, reasons: [`${c.name} is ready to accept`] });
        // Repair regressions only: a check that passed for this same selection of work before (for example
        // under an older requirement version) and fails now. An unfinished objective is not a regression.
        const before = state.candidates.filter((x) => x.id !== c.id && x.order.join(",") === c.order.join(",") && x.checks.length);
        const regressed = failed.filter((f) => before.some((b) => b.checks.some((k) => k.id === f.id && k.status === "PASS")));
        if (failed.length && membersApproved && served.ok && regressed.length) {
          await openRepair(this.env, objective, c.id, c.name, regressed.map((f) => `${f.id}: ${f.detail}`).join("\n"), result.commit, plan.head.version);
        }
        return { status };
      }),
    ));
    return { composed: plan.planned.length };
  }
}

/**
 * Names an outcome the way a person would: the approach it takes and who built it, for example
 * "Direct CSV export, by Heron and Wren". Without a chosen approach it falls back to the work itself.
 */
function outcomeName(members: { task: string | null; author: string; title: string }[], approaches: { task: string | null }[], state: { tasks: { id: string; title: string }[]; participants: { id: string; name: string }[] }): string {
  const nameOf = (id: string) => state.participants.find((p) => p.id === id)?.name ?? id;
  const authors = [...new Set(members.map((m) => nameOf(m.author)))].sort();
  const by = authors.length > 1 ? `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}` : authors[0] ?? "nobody";
  const approach = approaches.map((a) => state.tasks.find((t) => t.id === a.task)?.title).filter((t): t is string => !!t)
    .map((t) => t.replace(/^(explore|try|build|add)\s+(an?|the)\s+/i, "")).map((t) => t[0]!.toUpperCase() + t.slice(1));
  const what = approach.length ? approach.join(" with ") : members.length === 1 ? members[0]!.title : `${members.length} contributions`;
  return `${what}, by ${by}`;
}

/** A failing or conflicting outcome becomes a task. The repair builds on the composed tree itself. */
async function openRepair(env: Env, objective: DurableObjectStub<import("../objective").ObjectiveDO>, candidateId: string, name: string, detail: string, baseCommit: string, baseVersion: number) {
  const id = `t_repair-${candidateId.slice(1, 9)}`;
  const existing = await objective.task(id);
  if (existing) return;
  await objective.createTask({
    id, title: `Repair ${name.replace(/^Outcome: /, "")}`, baseVersion, baseCommit,
    brief: `The composed outcome ${candidateId} fails:\n${detail}\n\nYour workspace starts from that exact composed tree. Make the smallest change that makes the outcome satisfy the current requirements, run the tests, commit with the Nest trailers and publish.`,
  });
  // One automatic repair at a time: a cascade is impossible whatever else goes wrong.
  if (env.AUTO_REPAIR_AGENT && !(await objective.repairRunning())) {
    const { startTask } = await import("../tasks");
    await startTask(env, id, env.AUTO_REPAIR_AGENT, "agent").catch((e) => objective.log("Workflows", "repair", `Could not start the repair automatically: ${String(e).slice(0, 200)}`));
  }
}
