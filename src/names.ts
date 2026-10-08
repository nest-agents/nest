// Names and stubs. Every project and objective is named explicitly; nothing defaults to a built-in one.
// Workspace repos encode objective, generation, task and attempt so a push identifies its attempt.

export const registryStub = (env: Env) => env.REGISTRY.getByName("registry");
export const projectStub = (env: Env, project: string) => env.PROJECTS.getByName(project);
export const objectiveStub = (env: Env, objective: string) => env.OBJECTIVES.getByName(objective);

/** A project's code lives in the Artifacts repository named after it; its context next to it. */
export const projectRepo = (project: string) => project;
export const contextRepo = (project: string) => `${project}-context`;

export const artifactsRemote = (env: Env, repo: string) => `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${repo}.git`;

/** The generation is random per objective, so no repository or token can ever map onto another objective's work. */
export const workspaceRepo = (objective: string, generation: string, task: string, epoch: number) => `${objective}.${generation}--${task}--e${epoch}`;

export function parseWorkspaceRepo(name: string): { objective: string; generation: string; task: string; epoch: number } | null {
  const m = /^([a-z][a-z0-9-]{1,46}[a-z0-9])\.([0-9a-f]{8})--(t_[a-z0-9-]{1,48})--e(\d{1,6})$/.exec(name);
  return m ? { objective: m[1]!, generation: m[2]!, task: m[3]!, epoch: Number(m[4]) } : null;
}

/**
 * Every composed outcome is kept at a ref no deploy pipeline builds. The `cand-<id>` branch, which the
 * project's Workers Builds turns into a Preview, exists only for an outcome whose every contribution is
 * approved, so unreviewed code never reaches a build.
 */
export const candidateRef = (id: string) => `refs/nest/cand/${id}`;
export const candidateBranch = (id: string) => `cand-${id}`;

/** One computer per workspace, so an attempt never finds an agent left running by another attempt. */
export const agentComputer = (repo: string) => `agent.${repo}`;

/** Workflow instance ids are global and permanent, so they carry the objective's generation. */
export const taskWorkflowId = (generation: string, task: string, epoch: number) => `task-${generation}-${task}-e${epoch}`;

/** Short, stable display handle for a contribution id (c_xxxxxxxxxxxx -> xxxx). */
export const short = (id: string) => id.replace(/^c_/, "").slice(0, 4);
