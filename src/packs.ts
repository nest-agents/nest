// Context packs and search. A pack is everything an agent or reviewer should know, with citations.

import { citeOf, compilePack, type Pack, type PackSection } from "./context";
import { objectiveStub, projectStub, short } from "./names";

type SearchHit = { cite: string; title: string; text: string; score: number };

export async function buildPack(env: Env, taskId: string, budgetTokens = 200_000, extra: PackSection[] = []): Promise<Pack> {
  const project = projectStub(env);
  const objective = objectiveStub(env);
  const context = await project.context();
  const notes = await project.notes();
  const state = await objective.state();
  const task = state.tasks.find((t) => t.id === taskId);
  const people = new Map(state.participants.map((p) => [p.id, p.name]));

  const mandatory: PackSection[] = [
    {
      title: `Objective: ${state.objective.title ?? ""}`,
      text: `Completion criteria:\n${state.objective.criteria.map((c) => `- ${c}`).join("\n")}`,
    },
  ];
  if (task) mandatory.push({ title: `Your task: ${task.title}`, text: `${task.brief}${task.alternative ? `\n\nCompeting design group for this task: \`${task.alternative}\`` : ""}` });
  for (const kind of ["requirement", "decision", "policy"]) {
    for (const item of context.filter((i) => i.kind === kind))
      mandatory.push({ title: `${kind[0]!.toUpperCase()}${kind.slice(1)}: ${item.title}`, cite: citeOf(item), text: item.body });
  }
  const rejected = notes.filter((n) => n.kind === "rejected");
  for (const n of rejected) mandatory.push({ title: `Rejected approach: ${n.title}`, cite: n.id, text: n.body });

  const optional: PackSection[] = [...extra];
  const others = state.contributions.filter((c) => c.task !== taskId && c.status !== "superseded");
  if (others.length) {
    optional.push({
      title: "Work already published by others",
      text: others.map((c) => {
        const reviews = state.reviews.filter((r) => r.target === c.id && !r.triage);
        const verdicts = reviews.map((r) => `${people.get(r.reviewer) ?? r.reviewer}: ${r.verdict}${r.summary ? ` — ${r.summary.slice(0, 200)}` : ""}`).join("; ");
        return `- ${c.id} "${c.title}" by ${people.get(c.author) ?? c.author} [${c.status}]${c.alternative ? ` alternative=${c.alternative}` : ""}\n  files: ${c.paths.join(", ")}${verdicts ? `\n  reviews: ${verdicts}` : ""}`;
      }).join("\n"),
    });
  }
  const findings = state.reviews.filter((r) => !r.triage && r.findings.length);
  if (findings.length) {
    optional.push({
      title: "Review findings so far",
      text: findings.slice(-40).map((r) => `- on ${short(r.target)} by ${people.get(r.reviewer) ?? r.reviewer}: ${r.findings.map((f) => f.text).join(" | ").slice(0, 400)}`).join("\n"),
    });
  }
  for (const item of context.filter((i) => !["requirement", "decision", "policy"].includes(i.kind)))
    optional.push({ title: `${item.kind}: ${item.title}`, cite: citeOf(item), text: item.body });
  if (task) {
    const hits = await searchContext(env, `${task.title} ${task.brief}`.slice(0, 400));
    for (const h of hits.results.slice(0, 8)) optional.push({ title: `Related: ${h.title}`, cite: h.cite, text: h.text });
  }
  const pack = compilePack(mandatory, optional, budgetTokens);
  return pack;
}

/**
 * Hybrid retrieval over project context. Uses the AI Search instance when it is bound; always merges a
 * deterministic keyword pass over the exact current items so a configured index can only add results.
 */
export async function searchContext(env: Env, query: string): Promise<{ results: SearchHit[]; engines: string[] }> {
  const project = projectStub(env);
  const context = await project.context();
  const notes = await project.notes();
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  const score = (text: string) => terms.reduce((n, t) => n + (text.toLowerCase().split(t).length - 1), 0);
  const keyword: SearchHit[] = [
    ...context.map((i) => ({ cite: citeOf(i), title: i.title, text: i.body, score: score(`${i.title} ${i.body}`) })),
    ...notes.map((n) => ({ cite: n.id, title: n.title, text: n.body, score: score(`${n.title} ${n.body}`) })),
  ].filter((h) => h.score > 0);
  const engines = ["keyword"];
  const search = (env as unknown as { CONTEXT_SEARCH?: { search: (q: unknown) => Promise<{ chunks?: { text: string; item?: { key?: string; metadata?: Record<string, string> }; score?: number }[] }> } }).CONTEXT_SEARCH;
  const semantic: SearchHit[] = [];
  if (search && query.trim()) {
    try {
      const res = await search.search({ query, ai_search_options: { retrieval: { max_num_results: 10 }, cache: { enabled: false } } });
      for (const c of res.chunks ?? []) {
        const meta = c.item?.metadata ?? {};
        semantic.push({ cite: meta.cite ?? c.item?.key ?? "search", title: meta.title ?? c.item?.key ?? "match", text: c.text, score: (c.score ?? 0) * 10 });
      }
      engines.push("ai-search");
    } catch (e) {
      console.warn("AI Search unavailable", e);
    }
  }
  const merged = new Map<string, SearchHit>();
  for (const h of [...semantic, ...keyword]) {
    const prior = merged.get(h.cite);
    if (!prior || h.score > prior.score) merged.set(h.cite, h);
  }
  return { results: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 12), engines };
}
