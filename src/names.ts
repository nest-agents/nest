// Names and stubs. Workspace repos encode objective, task and attempt so a push identifies its attempt.

export const OBJECTIVE_ID = "harbor-export";

export const projectStub = (env: Env) => env.PROJECTS.getByName(env.PROJECT);
export const objectiveStub = (env: Env, id: string = OBJECTIVE_ID) => env.OBJECTIVES.getByName(id);

export const projectRepo = (env: Env) => env.PROJECT;
export const contextRepo = (env: Env) => `${env.PROJECT}-context`;

export const workspaceRepo = (objective: string, task: string, epoch: number) => `${objective}--${task}--e${epoch}`;

export function parseWorkspaceRepo(name: string): { objective: string; task: string; epoch: number } | null {
  const m = /^([a-z0-9][a-z0-9-]*[a-z0-9])--(t_[a-z0-9-]{1,48})--e(\d{1,6})$/.exec(name);
  return m ? { objective: m[1]!, task: m[2]!, epoch: Number(m[3]) } : null;
}

export const candidateBranch = (id: string) => `cand-${id}`;

/** Short, stable display handle for a contribution id (c_xxxxxxxxxxxx -> xxxx). */
export const short = (id: string) => id.replace(/^c_/, "").slice(0, 4);
