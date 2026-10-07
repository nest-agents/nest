// Remote MCP endpoint (stateless JSON-RPC over HTTP). External agents act as their own registered
// participant: they claim tasks, push to their own fork with a scoped token, publish and review.

import { authenticate } from "./auth";
import { ingestPush } from "./ingest";
import { objectiveStub, projectStub } from "./names";
import { buildPack, searchContext } from "./packs";
import { startTask } from "./tasks";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (args: Record<string, unknown>) => Promise<unknown> };

const str = (description: string) => ({ type: "string", description });

export async function handleMcp(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Nest MCP endpoint: POST JSON-RPC requests here.", { status: 405, headers: { allow: "POST" } });
  const principal = await authenticate(env, request);
  if (!principal || (principal.kind !== "participant" && principal.kind !== "owner"))
    return rpcError(null, -32001, "Send Authorization: Bearer <participant token> (create one with POST /api/participants)", 401);
  const me = principal.kind === "participant" ? principal.id : "you";
  const objective = objectiveStub(env);
  const project = projectStub(env);

  const tools: Tool[] = [
    { name: "nest_state", description: "Summary of the objective: tasks, contributions with review status, outcomes and what needs a person.", inputSchema: { type: "object", properties: {} },
      run: async () => {
        const s = await objective.state();
        return {
          objective: s.objective, head: await project.head(),
          tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, participant: t.participant, alternative: t.alternative })),
          contributions: s.contributions.map((c) => ({ id: c.id, title: c.title, author: c.author, status: c.status, alternative: c.alternative, requires: c.requires })),
          candidates: s.candidates.map((c) => ({ id: c.id, name: c.name, status: c.status, order: c.order, checks: c.checks.map((x) => `${x.id}:${x.status}`) })),
          inbox: s.inbox.filter((i) => i.status === "open"),
        };
      } },
    { name: "nest_pack", description: "The context pack for a task: requirements, decisions, rejected approaches and related work, with citations.", inputSchema: { type: "object", properties: { task: str("task id, e.g. t_export-direct") }, required: ["task"] },
      run: async (a) => (await buildPack(env, String(a.task), 200_000)).text },
    { name: "nest_search", description: "Search the project's context. Results carry citations to use in Nest-Cites.", inputSchema: { type: "object", properties: { query: str("what to look for") }, required: ["query"] },
      run: async (a) => searchContext(env, String(a.query).slice(0, 400)) },
    { name: "nest_claim", description: "Start an attempt on an open task. Returns a git remote and a short-lived write token for your own fork. Commit with the Nest trailers, push to main, then call nest_publish.", inputSchema: { type: "object", properties: { task: str("task id") }, required: ["task"] },
      run: async (a) => startTask(env, String(a.task), me, "manual") },
    { name: "nest_publish", description: "Register the commits you pushed to your fork as contributions.", inputSchema: { type: "object", properties: { repo: str("your fork's repository name"), commit: str("the commit you pushed") }, required: ["repo", "commit"] },
      run: async (a) => {
        const attempt = await objective.attemptForRepo(String(a.repo));
        if (!attempt || attempt.participant !== me) throw new Error("That fork does not belong to you");
        return ingestPush(env, String(a.repo), String(a.commit));
      } },
    { name: "nest_review", description: "Review a contribution as yourself. Your model family is taken from your registration.", inputSchema: { type: "object", properties: { contribution: str("contribution id"), verdict: { type: "string", enum: ["approve", "changes", "block", "comment"] }, summary: str("one or two sentences"), confidence: { type: "number" } }, required: ["contribution", "verdict", "summary"] },
      run: async (a) => objective.addReview({ id: `rv-${me}-${String(a.contribution)}-${Date.now()}`, target: String(a.contribution), reviewer: me, verdict: a.verdict as "approve", confidence: Number(a.confidence ?? 0.8), summary: String(a.summary).slice(0, 2000), findings: [], triage: false }) },
  ];

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try { msg = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
  if (msg.id === undefined) return new Response(null, { status: 202 });
  switch (msg.method) {
    case "initialize":
      return rpc(msg.id, { protocolVersion: String(msg.params?.protocolVersion ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "nest", version: "1.0.0" }, instructions: "Nest: humans and agents contribute, review and compose. Start with nest_state, read nest_pack for your task, then nest_claim." });
    case "ping":
      return rpc(msg.id, {});
    case "tools/list":
      return rpc(msg.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool ${String(msg.params?.name)}`);
      try {
        const out = await tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>);
        return rpc(msg.id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return rpc(msg.id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const rpc = (id: unknown, result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
const rpcError = (id: unknown, code: number, message: string, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status, headers: { "content-type": "application/json" } });
