// Callers are authenticated here and nowhere else. Durable Objects trust only what the Worker passes.

import { objectiveStub, registryStub } from "./names";

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

/**
 * External agents and invited humans act as a registered participant with this token. It names the
 * participant's revision, so rotating the participant revokes every token issued before.
 */
export async function participantToken(env: Env, id: string, rev: number): Promise<string> {
  return `p.${id}.${rev}.${await hmac(env.NEST_SIGNING_KEY, `participant:${id}:${rev}`)}`;
}

export async function authenticate(env: Env, request: Request): Promise<Principal | null> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookie = /(?:^|;\s*)nest_owner=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
  let fromCookie = "";
  try { fromCookie = decodeURIComponent(cookie); } catch { /* a malformed cookie is no cookie */ }
  const owner = bearer || fromCookie;
  if (owner && env.NEST_OWNER_TOKEN && timingSafeEqual(owner, env.NEST_OWNER_TOKEN)) return { kind: "owner" };
  if (bearer.startsWith("p.")) {
    const [, id, revText, sig, extra] = bearer.split(".");
    if (!id || !revText || !sig || extra !== undefined || !/^\d{1,9}$/.test(revText)) return null;
    if (!timingSafeEqual(sig, await hmac(env.NEST_SIGNING_KEY, `participant:${id}:${revText}`))) return null;
    const current = await registryStub(env).participant(id).catch(() => null);
    return current && current.rev === Number(revText) ? { kind: "participant", id } : null;
  }

  const task = request.headers.get("x-nest-task");
  if (task) {
    const parts = task.split(".");
    if (parts.length === 5) {
      const [objective, generation, taskId, epochText, sig] = parts as [string, string, string, string, string];
      const expected = await hmac(env.NEST_SIGNING_KEY, `task:${objective}.${generation}.${taskId}.${epochText}`);
      if (!timingSafeEqual(sig, expected)) return null;
      const current = await objectiveStub(env, objective).generation().catch(() => null);
      return current === generation ? { kind: "task", objective, generation, task: taskId, epoch: Number(epochText) } : null;
    }
    return null;
  }
  return { kind: "viewer" };
}
