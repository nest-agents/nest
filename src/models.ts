// Model access for Worker-side work (triage and reviews). Agents in containers reach the same gateway
// through Outbound. Prices are conservative per-token USD figures used for admission and settlement.

const PRICES: Record<string, { in: number; out: number }> = {
  // OpenAI list prices (standard tier, short context), 2026-10-08.
  "gpt-6-sol": { in: 2, out: 10 },
  "gpt-6.1-sol": { in: 2, out: 10 },
  "gpt-6-astra": { in: 10, out: 50 },
  "gpt-6-luna": { in: 0.1, out: 0.5 },
  "anthropic/claude-haiku-5.5": { in: 0.1, out: 0.5 },
  "anthropic/claude-sonnet-5.5": { in: 2, out: 10 },
  "anthropic/claude-opus-5.5": { in: 4, out: 20 },
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
  // Workers AI catalog prices, rounded up.
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { in: 0.5, out: 1.5 },
  "@cf/zai-org/glm-5.3": { in: 1.5, out: 4.5 },
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

/** Every provider request goes through the account's AI Gateway, which logs it and caps daily spend. */
export const gatewayBase = (env: Env) => `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;

/**
 * The gateway is authenticated, so provider requests through it carry its token (a secret scoped to AI
 * Gateway: Run on this account). Workers AI calls through the binding are authenticated automatically.
 */
export const gatewayHeaders = (env: Env): Record<string, string> => ({ "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}` });

export const providerTarget = (env: Env, provider: "openai" | "openrouter", rest: string) => `${gatewayBase(env)}/${provider}/${rest}`;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { text: string; inputTokens: number; outputTokens: number; model: string; finish: string | null; reasoningChars: number };

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
    const options = { gateway: { id: env.AI_GATEWAY_ID, metadata: opts.metadata ?? {} } };
    const out = (await env.AI.run(route.model as keyof AiModels, { messages, max_tokens: maxTokens } as never, options as never)) as {
      response?: string; choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = out.choices?.[0];
    const text = out.response ?? choice?.message?.content ?? "";
    const inT = out.usage?.prompt_tokens ?? promptTokens;
    const outT = out.usage?.completion_tokens ?? Math.ceil(text.length / 4);
    const p = priceFor(route.model);
    await opts.settle(id, inT * p.inPerToken + outT * p.outPerToken);
    return { text, inputTokens: inT, outputTokens: outT, model: route.model, finish: choice?.finish_reason ?? null, reasoningChars: (choice?.message?.reasoning_content ?? "").length };
  }

  const url = providerTarget(env, route.provider, route.provider === "openai" ? "chat/completions" : "v1/chat/completions");
  const key = route.provider === "openai" ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "cf-aig-metadata": JSON.stringify(opts.metadata ?? {}),
      ...gatewayHeaders(env),
    },
    body: JSON.stringify({
      model: route.model,
      messages,
      // On OpenAI reasoning models the completion budget includes reasoning tokens.
      ...(route.provider === "openai" ? { max_completion_tokens: maxTokens, ...(opts.effort ? { reasoning_effort: opts.effort } : {}) } : { max_tokens: maxTokens }),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (!res.ok) {
    await opts.settle(id, 0);
    throw new Error(`model ${route.model} returned ${res.status}: ${body.error?.message ?? ""}`.slice(0, 400));
  }
  const choice = body.choices?.[0];
  const text = choice?.message?.content ?? "";
  const inT = body.usage?.prompt_tokens ?? promptTokens;
  const outT = body.usage?.completion_tokens ?? Math.ceil(text.length / 4);
  const p = priceFor(route.model);
  await opts.settle(id, inT * p.inPerToken + outT * p.outPerToken);
  return { text, inputTokens: inT, outputTokens: outT, model: route.model, finish: choice?.finish_reason ?? null, reasoningChars: (choice?.message?.reasoning_content ?? "").length };
}

/**
 * The JSON object in a model reply. Models that reason before they answer put prose, sometimes with
 * braces, before the object, so every balanced top-level object is tried. With `key`, only objects that
 * carry that key count. Exactly one must remain: a reply with two candidate verdicts, which is what an
 * injected verdict quoted in prose would produce, is no verdict at all.
 */
export function parseJsonReply<T>(text: string, key?: string): T | null {
  const source = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const found: T[] = [];
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(source.slice(start, i + 1)) as T;
          if (obj && typeof obj === "object" && (!key || Object.hasOwn(obj, key))) found.push(obj);
          start = i; // skip the objects nested inside this one
        } catch { /* not an object; keep scanning */ }
        break;
      }
    }
  }
  return found.length === 1 ? found[0]! : null;
}
