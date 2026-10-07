// Starting task attempts. A new attempt forks the accepted checkpoint, or the paused attempt's workspace
// when the task is being handed over, so the next participant continues from the exact same tree.

import { ArtifactsClient } from "./artifacts";
import { taskToken } from "./auth";
import { agentComputer, objectiveStub, OBJECTIVE_ID, projectRepo, projectStub, taskWorkflowId, workspaceRepo } from "./names";

export class TaskError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

export async function startTask(env: Env, taskId: string, participantId: string, mode: "agent" | "manual") {
  const objective = objectiveStub(env);
  const project = projectStub(env);
  const t = await objective.task(taskId);
  if (!t) throw new TaskError("NOT_FOUND");
  if (t.status === "running") throw new TaskError("ALREADY_RUNNING");
  const participants = await objective.participants();
  const who = participants.find((p) => p.id === participantId);
  if (!who) throw new TaskError("UNKNOWN_PARTICIPANT");
  if (mode === "agent" && !["codex", "nest-agent", "opencode"].includes(who.harness)) throw new TaskError("NOT_A_WORKER", `${who.name} cannot run tasks`);
  const head = await project.head();
  if (!head) throw new TaskError("NOT_BOOTSTRAPPED");

  const epoch = t.epoch + 1;
  const generation = await objective.generation();
  const repo = workspaceRepo(OBJECTIVE_ID, generation, taskId, epoch);
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const handover = t.status === "paused" && t.repo;
  const source = handover ? t.repo! : projectRepo(env);
  await artifacts.fork(source, repo, `Nest ${taskId} attempt ${epoch}`);
  await objective.startAttempt(taskId, participantId, t.epoch, repo);
  await objective.log("Artifacts", "fork", handover
    ? `Forked ${source} into ${repo} so ${who.name} continues from the paused tree`
    : `Forked checkpoint ${head.version} into ${repo}`, { task: taskId, epoch, repo });

  if (mode === "manual") {
    // A person or external agent pushing from their own machine: a short-lived write token for this fork only.
    const token = await artifacts.token(repo, "write", 3600);
    using r = await env.ARTIFACTS.get(repo);
    const info = await r.info();
    return { repo, remote: info.remote, token: token.secret, expiresAt: token.expiresAt, taskToken: await taskToken(env, OBJECTIVE_ID, generation, taskId, epoch), epoch };
  }
  const workflow = taskWorkflowId(generation, taskId, epoch);
  try {
    await env.TASKS.create({ id: workflow, params: { objective: OBJECTIVE_ID, task: taskId, epoch, participant: participantId, repo } });
  } catch (e) {
    // Never leave an attempt marked running without a workflow behind it.
    await objective.finishAttempt(taskId, epoch, "failed", `Could not start the workflow: ${String(e).slice(0, 200)}`);
    throw new TaskError("WORKFLOW_START_FAILED", String(e).slice(0, 300));
  }
  return { repo, epoch, workflow };
}

/**
 * Stops a task's current attempt from outside: the agent is killed, committed work is pushed and
 * registered, the attempt is closed and its workflow ends. Also the recovery path for a stuck attempt.
 */
export async function stopTask(env: Env, taskId: string) {
  const objective = objectiveStub(env);
  const t = await objective.task(taskId);
  if (!t) throw new TaskError("NOT_FOUND");
  if (t.status !== "running") throw new TaskError("NOT_RUNNING");
  let published: unknown[] = [];
  if (t.participant && t.repo) {
    const computer = env.COMPUTERS.getByName(agentComputer(t.repo));
    const stopped = await computer.stopAgent().catch(() => ({ uncommitted: "", head: "" }));
    if (stopped.head) {
      await computer.exec(["bash", "-lc", "git push --quiet origin HEAD:main || true"], "/workspace/repo").catch(() => undefined);
      const { ingestPush } = await import("./ingest");
      published = await ingestPush(env, t.repo, stopped.head).catch(() => []);
    }
    await computer.destroy("stopped by the owner").catch(() => undefined);
  }
  await objective.finishAttempt(taskId, t.epoch, "failed", "Stopped by the owner");
  const instance = await env.TASKS.get(taskWorkflowId(await objective.generation(), taskId, t.epoch)).catch(() => null);
  await instance?.terminate().catch(() => undefined);
  return { stopped: taskId, epoch: t.epoch, published };
}
