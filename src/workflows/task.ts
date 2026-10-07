// TaskWorkflow: one attempt of one task by one agent, in its own computer and its own Artifacts fork.
// Pausing is durable: committed work is published, uncommitted work is saved, and the attempt is fenced.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ingestPush } from "../ingest";
import { gatewayBase } from "../models";
import { objectiveStub, projectRepo, projectStub, short } from "../names";
import { buildPack } from "../packs";

type Params = { objective: string; task: string; epoch: number; participant: string; repo: string };
type Handover = { patch: string | null; head: string; notes: string[]; by: string };

const REPO_DIR = "/workspace/repo";
const remoteOf = (env: Env, repo: string) => `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${repo}.git`;

function brief(p: {
  name: string; task: string; epoch: number; title: string; body: string; alternative: string | null; objective: string; criteria: string[];
  handover: (Handover & { byName: string }) | null; repair: boolean;
}): string {
  return `You are ${p.name}, a coding agent working in Nest on Harbor, a small issue tracker built as a Cloudflare Worker in TypeScript.
Node 24 runs the TypeScript directly: keep explicit ".ts" extensions in imports and avoid TypeScript-only runtime syntax (enums, namespaces, parameter properties).

Objective: ${p.objective}
${p.criteria.map((c) => `- ${c}`).join("\n")}

Your task: ${p.title}
${p.body}
${p.handover ? `
You are continuing this task. ${p.handover.byName} worked on it before you and was paused.
Your workspace already contains their committed work${p.handover.patch ? ", and their uncommitted changes are restored as staged changes" : ""}.
Their notes:
${p.handover.notes.length ? p.handover.notes.map((n) => `- ${n}`).join("\n") : "- (no notes)"}
Review what is there before changing it.
` : ""}${p.repair ? "\nYour workspace starts from the composed outcome that failed. Fix the failure with the smallest correct change.\n" : ""}
Before you start, read your context pack: /workspace/nest/context.md. It holds the requirements, decisions, rejected approaches and other agents' work, each with a citation such as req/export-api@v1.

How Nest works:
- Publish small, separable commits. Each commit is a contribution that others can reuse even if your overall approach is not chosen. Put a reusable building block (for example a pure helper module with its own tests) in its own commit before the commit that uses it.
- End every commit message with a blank line and these trailers:
    Nest-Task: ${p.task}
    Nest-Attempt: ${p.task}/e${p.epoch}
    Nest-Cites: <the context citations you relied on, comma-separated, for example req/csv-format@v1>
  Add "Nest-Alternative: ${p.alternative ?? "<group>"}" only to the commit that embodies a competing design choice${p.alternative ? "" : " (this task has no competing group, so you will usually not need it)"}.
  Add "Nest-Requires: <contribution id>" only when your change depends on another agent's contribution that is not already in your workspace (see "nest contributions").
- After each commit, run "nest publish". It pushes and registers your commits; read its output. A rejected commit says why.
- "nest contributions" lists everyone's work; "nest show <id>" prints one; "nest search <words>" searches the project context; "nest note <text>" records progress for whoever continues.
- Run the tests with "node --test test/". Add tests for what you build.
- Do not edit src/data.ts, package.json or wrangler.jsonc.
- When your part is complete, committed and published, stop.`;
}

export class TaskWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { objective: oid, task: tid, epoch, participant: pid, repo } = event.payload;
    const env = this.env;
    const objective = objectiveStub(env, oid);
    const computerName = `agent-${tid}-e${epoch}`;
    const computer = env.COMPUTERS.getByName(computerName);

    const setup = await step.do("prepare the brief", async () => {
      const state = await objective.state();
      const task = state.tasks.find((t) => t.id === tid);
      const who = state.participants.find((p) => p.id === pid);
      if (!task || !who) throw new Error("task or participant missing");
      let handover: (Handover & { byName: string }) | null = null;
      if (epoch > 1) {
        const prev = (await objective.attempts(tid)).find((a) => Number(a.epoch) === epoch - 1);
        const note = task.pausedNote ? (JSON.parse(task.pausedNote) as Handover) : null;
        if (prev && note) handover = { ...note, byName: state.participants.find((p) => p.id === String(prev.participant))?.name ?? String(prev.participant) };
      }
      const pack = await buildPack(env, tid, who.family === "anthropic" ? 300_000 : 200_000);
      return {
        who, handover, baseCommit: task.baseCommit, pack: pack.text, packTokens: pack.tokens,
        prompt: brief({ name: who.name, task: tid, epoch, title: task.title, body: task.brief, alternative: task.alternative, objective: state.objective.title ?? "", criteria: state.objective.criteria, handover, repair: !!task.baseCommit }),
      };
    });

    await step.do("start the computer", { retries: { limit: 2, delay: "10 seconds" }, timeout: "5 minutes" }, async () => {
      const props = { computer: computerName, role: "agent" as const, objective: oid, task: tid, epoch, workspace: repo };
      const ready = await computer.prepareAgent(props, remoteOf(env, repo), { name: setup.who.name, email: `${setup.who.id}@agents.nest.invalid` });
      if (ready.exitCode !== 0) throw new Error(`workspace setup failed: ${ready.stderr.slice(-500)}`);
      if (setup.baseCommit) {
        // A repair starts from the composed outcome: Nest recorded that commit as a materialization.
        const r = await computer.exec(["bash", "-lc", `git fetch --quiet ${remoteOf(env, projectRepo(env))} ${setup.baseCommit} && git reset --quiet --hard FETCH_HEAD && git push --quiet origin HEAD:main`], REPO_DIR);
        if (r.exitCode !== 0) throw new Error(`could not start from the composed outcome: ${r.stderr.slice(-500)}`);
      }
      if (setup.handover?.patch) {
        const patch = await env.OBJECTS.get(setup.handover.patch);
        if (patch) await computer.execWithInput(["git", "apply", "--index", "--whitespace=nowarn"], await patch.text(), REPO_DIR);
      }
      await computer.writeFile("/workspace/nest/context.md", setup.pack);
      await computer.writeFile("/workspace/nest/prompt.md", setup.prompt);
      await objective.log("Containers", "computer", `${setup.who.name}'s computer is ready: ${repo} cloned, context pack of ${Math.round(setup.packTokens / 1000)}k tokens`, { task: tid, epoch });
    });

    await step.do("start the agent", async () => {
      const env2 = { NEST_REPO: repo, NEST_TASK: tid, NEST_EPOCH: String(epoch) };
      const command = setup.who.harness === "codex"
        ? ["codex", "exec", "--json", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", "/workspace/task/last.txt",
          "--model", setup.who.model, "--config", 'model_provider="cloudflare-ai-gateway"',
          "--config", `model_providers.cloudflare-ai-gateway={ name = "Cloudflare AI Gateway", base_url = ${JSON.stringify(`${gatewayBase(env)}/openai`)}, wire_api = "responses" }`,
          "--config", "analytics.enabled=false", "--config", "check_for_update_on_startup=false", "--config", "features.plugins=false",
          "--", "Read /workspace/nest/prompt.md and follow it exactly."]
        : ["node", "/opt/nest/nest-agent.mjs", "/workspace/nest/prompt.md"];
      const modelEnv: Record<string, string> = setup.who.harness === "codex" ? {} : { NEST_MODEL_URL: `${gatewayBase(env)}/openrouter/v1/chat/completions`, NEST_MODEL: setup.who.model, NEST_MAX_TURNS: "45" };
      const started = await computer.startAgent(command, { ...env2, ...modelEnv });
      await objective.log("Agents", "agent", `${setup.who.name} started (${setup.who.harness}, ${setup.who.model})`, { task: tid, epoch });
      return started;
    });

    let offset = 0;
    let paused = false;
    const myGeneration = repo.split("--")[0]!.split(".")[1];
    for (let i = 0; i < 70; i++) {
      // A reset starts a new generation; an attempt from an older one shuts itself down.
      const stale = await step.do(`generation check ${i}`, async () => (await objective.generation().catch(() => null)) !== myGeneration);
      if (stale) {
        await step.do("stand down after a reset", async () => {
          await computer.stopAgent().catch(() => undefined);
          await computer.destroy("objective was reset").catch(() => undefined);
        });
        return { stale: true };
      }
      try {
        await step.waitForEvent(`pause window ${i}`, { type: "pause", timeout: "30 seconds" });
        paused = true;
        break;
      } catch { /* no pause requested in this window */ }
      const status = await step.do(`check ${i}`, async () => {
        const st = await computer.agentState();
        const lines = (await computer.agentOutput()).split("\n").filter(Boolean);
        const fresh = lines.slice(offset);
        const notable: string[] = [];
        for (const line of fresh) {
          // Progress lines come from the container: parse defensively and never fail the step on them.
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev || typeof ev !== "object") continue;
          const item = ev.item as Record<string, unknown> | undefined;
          const detail = String(ev.detail ?? "").slice(0, 80);
          if (ev.type === "tool" && ev.name === "run") notable.push(`ran ${detail}`);
          else if (ev.type === "tool" && ev.name === "write_file") notable.push(`wrote ${detail}`);
          else if (ev.type === "finish") notable.push(`finished: ${String(ev.summary ?? "").slice(0, 160)}`);
          else if (ev.type === "model_error") notable.push(`hit a model error (${String(ev.status ?? "")})`);
          else if (item?.type === "command_execution") notable.push(`ran ${String(item.command ?? "").slice(0, 80)}`);
          else if (item?.type === "file_change") notable.push(`changed files`);
        }
        for (const n of notable.slice(-3)) await objective.log("Containers", "progress", `${setup.who.name} ${n}`, { task: tid, epoch });
        return { state: st.state, exitCode: st.exitCode ?? null, offset: lines.length, tail: st.tail ?? "" };
      });
      offset = status.offset;
      if (status.state !== "running") break;
    }

    if (paused) {
      return await step.do("pause at a boundary", async () => {
        const stopped = await computer.stopAgent();
        await computer.exec(["bash", "-lc", "git push --quiet origin HEAD:main || true"], REPO_DIR);
        const results = stopped.head ? await ingestPush(env, repo, stopped.head) : [];
        const key = stopped.uncommitted.trim() ? `pauses/${tid}-e${epoch}.patch` : null;
        if (key) await env.OBJECTS.put(key, stopped.uncommitted, { httpMetadata: { contentType: "text/x-diff" } });
        const notes = (await objective.events(0, 1000)).filter((e) => e.kind === "note" && e.data !== null && (JSON.parse(e.data) as { task?: string }).task === tid).map((e) => e.text);
        const handover: Handover = { patch: key, head: stopped.head, notes, by: pid };
        await objective.pause(tid, epoch, JSON.stringify(handover));
        await objective.log("R2", "handover", `Saved ${setup.who.name}'s portable checkpoint: ${short(stopped.head || "-------")}${key ? " plus uncommitted work" : ""}, ${notes.length} notes`, { task: tid, epoch });
        await computer.destroy("paused");
        return { paused: true, published: results.length };
      });
    }

    return await step.do("publish and finish", async () => {
      const r = await computer.exec(["bash", "-lc", "git status --porcelain | head -20; git push --quiet origin HEAD:main 2>&1 | tail -3; echo HEAD=$(git rev-parse HEAD)"], REPO_DIR);
      const head = /HEAD=([0-9a-f]{40})/.exec(r.stdout)?.[1];
      const results = head ? await ingestPush(env, repo, head) : [];
      const st = await computer.agentState();
      const ok = st.state === "exited" && st.exitCode === 0;
      const dirty = r.stdout.split("\n").filter((l) => /^[ MADRCU?]{2} /.test(l)).length;
      const published = await objective.attemptContributions(tid, epoch);
      await objective.finishAttempt(tid, epoch, ok ? "done" : "failed", `${published} contributions published${dirty ? `; ${dirty} files left uncommitted` : ""}${ok ? "" : `; ${st.tail?.slice(-200) ?? st.state}`}`);
      await computer.destroy("task finished");
      return { ok, results };
    });
  }
}
