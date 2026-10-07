// Model access for Worker-side work (triage and reviews). Agents in containers reach the same gateway
// through Outbound. Prices are conservative per-token USD figures used for admission and settlement.

const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-6-sol": { in: 2, out: 10 },
  "gpt-6.1-sol": { in: 2, out: 10 },
  "gpt-6-astra": { in: 5, out: 25 },
  "gpt-6-luna": { in: 2, out: 10 },
  "anthropic/claude-haiku-5.5": { in: 0.1, out: 0.5 },
  "anthropic/claude-sonnet-5.5": { in: 2, out: 10 },
  "anthropic/claude-opus-5.5": { in: 4, out: 20 },
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
};
// Far above any listed price, so a reservation for an unlisted model is still an upper bound. Agents
// never reach it: Outbound only lets them call the configured, priced models.
const FALLBACK = { in: 30, out: 150 };

export const isPriced = (model: string) => Object.hasOwn(PRICES, model);

/** Micro-USD per token, by exact model id. */
export function priceFor(model: string): { inPerToken: number; outPerToken: number } {
  const p = isPriced(model) ? PRICES[model]! : FALLBACK;
  return { inPerToken: p.in, outPerToken: p.out };
}

export function estimateCost(model: string, inputTokens: number, maxOutputTokens: number): number {
  const p = priceFor(model);
  return Math.max(1, Math.ceil(inputTokens * p.inPerToken + maxOutputTokens * p.outPerToken));
}

export const gatewayBase = (env: Env) => `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;

/**
 * Where a provider request really goes. Agents and reviewers always address the gateway; in "direct"
 * mode (before the gateway exists) the same path is sent straight to the provider.
 */
export function providerTarget(env: Env, provider: string, rest: string): string | null {
  if ((env.AI_GATEWAY_MODE as string) === "gateway") return `${gatewayBase(env)}/${provider}/${rest}`;
  if (provider === "openai") return `https://api.openai.com/v1/${rest.replace(/^v1\//, "")}`;
  if (provider === "openrouter") return `https://openrouter.ai/api/v1/${rest.replace(/^v1\//, "")}`;
  return null;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { text: string; inputTokens: number; outputTokens: number; model: string };

/**
 * One chat call through AI Gateway, reserved against the objective's spend cap first and settled with
 * the provider's reported usage afterwards.
 */
export async function chat(
  env: Env,
  route: { provider: "openai" | "openrouter" | "workers-ai"; model: string },
  messages: ChatMessage[],
  opts: { maxTokens?: number; json?: boolean; effort?: "low" | "medium" | "high"; metadata?: Record<string, string>; reserve: (id: string, micro: number, model: string) => Promise<boolean>; settle: (id: string, micro: number) => Promise<void> },
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 2000;
  const promptTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
  const id = `chat-${crypto.randomUUID()}`;
  if (!(await opts.reserve(id, estimateCost(route.model, promptTokens, maxTokens), route.model))) throw new Error("SPEND_CAP_REACHED");

  if (route.provider === "workers-ai") {
    const options = (env.AI_GATEWAY_MODE as string) === "gateway" ? { gateway: { id: env.AI_GATEWAY_ID, metadata: opts.metadata ?? {} } } : {};
    const out = (await env.AI.run(route.model as keyof AiModels, { messages, max_tokens: maxTokens } as never, options as never)) as { response?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = out.response ?? out.choices?.[0]?.message?.content ?? "";
    const inT = out.usage?.prompt_tokens ?? promptTokens;
    const outT = out.usage?.completion_tokens ?? Math.ceil(text.length / 4);
    const p = priceFor(route.model);
    await opts.settle(id, inT * p.inPerToken + outT * p.outPerToken);
    return { text, inputTokens: inT, outputTokens: outT, model: route.model };
  }

  const url = providerTarget(env, route.provider, route.provider === "openai" ? "chat/completions" : "v1/chat/completions")!;
  const key = route.provider === "openai" ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "cf-aig-metadata": JSON.stringify(opts.metadata ?? {}),
    },
    body: JSON.stringify({
      model: route.model,
      messages,
      // On OpenAI reasoning models the completion budget includes reasoning tokens.
      ...(route.provider === "openai" ? { max_completion_tokens: maxTokens, ...(opts.effort ? { reasoning_effort: opts.effort } : {}) } : { max_tokens: maxTokens }),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (!res.ok) {
    await opts.settle(id, 0);
    throw new Error(`model ${route.model} returned ${res.status}: ${body.error?.message ?? ""}`.slice(0, 400));
  }
  const text = body.choices?.[0]?.message?.content ?? "";
  const inT = body.usage?.prompt_tokens ?? promptTokens;
  const outT = body.usage?.completion_tokens ?? Math.ceil(text.length / 4);
  const p = priceFor(route.model);
  await opts.settle(id, inT * p.inPerToken + outT * p.outPerToken);
  return { text, inputTokens: inT, outputTokens: outT, model: route.model };
}

/** Pulls the first JSON object out of a model reply, tolerating code fences. */
export function parseJsonReply<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(fenced.slice(start, end + 1)) as T; } catch { return null; }
}
