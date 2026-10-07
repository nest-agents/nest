// Names and stubs. Workspace repos encode objective, task and attempt so a push identifies its attempt.

export const OBJECTIVE_ID = "harbor-export";

export const projectStub = (env: Env) => env.PROJECTS.getByName(env.PROJECT);
export const objectiveStub = (env: Env, id: string = OBJECTIVE_ID) => env.OBJECTIVES.getByName(id);

export const projectRepo = (env: Env) => env.PROJECT;
export const contextRepo = (env: Env) => `${env.PROJECT}-context`;

/** The generation changes on every reset, so no repository or token from before a reset maps onto new work. */
export const workspaceRepo = (objective: string, generation: string, task: string, epoch: number) => `${objective}.${generation}--${task}--e${epoch}`;

export function parseWorkspaceRepo(name: string): { objective: string; generation: string; task: string; epoch: number } | null {
  const m = /^([a-z0-9][a-z0-9-]*[a-z0-9])\.([0-9a-f]{8})--(t_[a-z0-9-]{1,48})--e(\d{1,6})$/.exec(name);
  return m ? { objective: m[1]!, generation: m[2]!, task: m[3]!, epoch: Number(m[4]) } : null;
}

export const candidateBranch = (id: string) => `cand-${id}`;

/** Workflow instance ids are global and permanent, so they carry the objective generation too. */
export const taskWorkflowId = (generation: string, task: string, epoch: number) => `task-${generation}-${task}-e${epoch}`;

/** Short, stable display handle for a contribution id (c_xxxxxxxxxxxx -> xxxx). */
export const short = (id: string) => id.replace(/^c_/, "").slice(0, 4);
