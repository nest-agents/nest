// Callers are authenticated here and nowhere else. Durable Objects trust only what the Worker passes.

export type Principal =
  | { kind: "owner" }
  | { kind: "task"; objective: string; generation: string; task: string; epoch: number }
  | { kind: "participant"; id: string }
  | { kind: "viewer" };

const enc = new TextEncoder();

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Task tokens are minted per attempt and only ever injected by the sandbox's Outbound entrypoint. */
export async function taskToken(env: Env, objective: string, generation: string, task: string, epoch: number): Promise<string> {
  const body = `${objective}.${generation}.${task}.${epoch}`;
  return `${body}.${await hmac(env.NEST_SIGNING_KEY, `task:${body}`)}`;
}

/** External agents (MCP clients) act as a registered participant with this token, valid for one generation. */
export async function participantToken(env: Env, id: string, generation: string): Promise<string> {
  return `p.${id}.${generation}.${await hmac(env.NEST_SIGNING_KEY, `participant:${id}:${generation}`)}`;
}

export async function authenticate(env: Env, request: Request): Promise<Principal | null> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookie = /(?:^|;\s*)nest_owner=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
  const owner = bearer || decodeURIComponent(cookie);
  if (owner && env.NEST_OWNER_TOKEN && timingSafeEqual(owner, env.NEST_OWNER_TOKEN)) return { kind: "owner" };
  if (bearer.startsWith("p.")) {
    const [, id, generation, sig] = bearer.split(".");
    if (!id || !generation || !sig || !timingSafeEqual(sig, await hmac(env.NEST_SIGNING_KEY, `participant:${id}:${generation}`))) return null;
    const { objectiveStub } = await import("./names");
    const current = await objectiveStub(env).generation().catch(() => null);
    return current === generation ? { kind: "participant", id } : null;
  }

  const task = request.headers.get("x-nest-task");
  if (task) {
    const parts = task.split(".");
    if (parts.length === 5) {
      const [objective, generation, taskId, epochText, sig] = parts as [string, string, string, string, string];
      const expected = await hmac(env.NEST_SIGNING_KEY, `task:${objective}.${generation}.${taskId}.${epochText}`);
      if (!timingSafeEqual(sig, expected)) return null;
      // A token from before a reset names an older generation and is no longer valid.
      const { objectiveStub } = await import("./names");
      const current = await objectiveStub(env, objective).generation().catch(() => null);
      return current === generation ? { kind: "task", objective, generation, task: taskId, epoch: Number(epochText) } : null;
    }
    return null;
  }
  return { kind: "viewer" };
}
