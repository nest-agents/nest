// Swarm: many synthetic contributors on real infrastructure, to measure throughput honestly.
// Each contributor gets a real Artifacts fork and a scoped write token; pushes go through the real
// event trigger, ingest Workflow and Durable Object registration. Reviews and composition are skipped.

import { ArtifactsClient } from "./artifacts";
import { projectRepo, projectStub, workspaceRepo } from "./names";

export async function prepareSwarm(env: Env, name: string, count: number, offset: number) {
  if (!/^swarm-[a-z0-9-]{1,30}$/.test(name)) throw new Error("swarm objectives are named swarm-<id>");
  const objective = env.OBJECTIVES.getByName(name);
  const head = await projectStub(env).head();
  if (!head) throw new Error("bootstrap the project first");
  await objective.init({ id: name, title: `Throughput swarm ${name}`, criteria: [], project: env.PROJECT, mode: "swarm" });
  await objective.upsertParticipant({ id: "swarm", kind: "agent", name: "Swarm", family: "synthetic", model: "synthetic", harness: "external" });
  const generation = await objective.generation();
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const out: { task: string; repo: string; remote: string; token: string; epoch: number }[] = [];
  const ids = Array.from({ length: count }, (_, i) => offset + i);
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await Promise.all(ids.slice(i, i + 20).map(async (n) => {
      const task = `t_s${n}`;
      await objective.createTask({ id: task, title: `Swarm contributor ${n}`, brief: "synthetic", baseVersion: head.version });
      const repo = workspaceRepo(name, generation, task, 1);
      const fork = await artifacts.fork(projectRepo(env), repo, `swarm ${name} ${n}`);
      await objective.startAttempt(task, "swarm", 0, repo);
      const token = await artifacts.token(repo, "write", 3600);
      return { task, repo, remote: fork.remote, token: token.secret, epoch: 1 };
    }));
    out.push(...batch);
  }
  return { objective: name, generation, base: head.commit, contributors: out };
}
