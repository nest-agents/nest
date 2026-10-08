// Context packs and search. A pack is everything an agent or reviewer should know, with citations.

import { ArtifactsClient } from "./artifacts";
import { citeOf, compilePack, type Pack, type PackSection } from "./context";
import { estimateTokens } from "./domain/context";
import { objectiveStub, projectRepo, projectStub, short } from "./names";
import { boundary, UNTRUSTED_RULE, wrapUntrusted } from "./untrusted";

/**
 * The repository at a commit, as pack sections: a file map first, then source before tests before the
 * rest, each file whole, stopping at the token budget. Large or binary files are listed but not included.
 */
/** File names and paths a task mentions, so the files it is about come first in the pack. */
export function fileHints(text: string): string[] {
  return [...new Set((text.match(/[\w@./-]*\w\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|md|css|html|toml|ya?ml)\b/g) ?? []).map((h) => h.replace(/^\.\//, "")))];
}

/** Mentioned files first, then instructions for agents, then source, then tests, then everything else. */
export function rankPath(p: string, hints: string[]): number {
  if (hints.some((h) => p === h || p.endsWith(`/${h}`))) return 0;
  return /^(AGENTS|README)\.md$/i.test(p) ? 1 : /(^|\/)(src|lib|app)\//.test(p) ? 2 : /(^|\/)(test|tests|__tests__)\//.test(p) ? 3 : 4;
}

export async function repositorySections(env: Env, repo: string, commit: string, label: string, budgetTokens: number, nonce = boundary(), hints: string[] = []): Promise<PackSection[]> {
  const MAX_FILES = 300;
  const artifacts = new ArtifactsClient(env.ARTIFACTS);
  const files = await artifacts.listFiles(repo, commit, 5000);
  const rank = (p: string) => rankPath(p, hints);
  const textual = /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|css|html|txt|toml|yaml|yml)$/i;
  const map = files.slice(0, 2000).map((f) => f.path).join("\n") + (files.length > 2000 ? `\n... ${files.length - 2000} more` : "");
  const sections: PackSection[] = [{ title: `${label}: file map`, text: wrapUntrusted(nonce, "file map", map) }];
  let used = estimateTokens(map);
  // Lockfiles are listed only.
  const queue = files.filter((f) => textual.test(f.path) && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|worker-configuration\.d\.ts)$/.test(f.path)).sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
  // Read in small parallel batches and stop as soon as the budget is spent.
  for (let i = 0; i < queue.length && used < budgetTokens; i += 8) {
    const batch = await Promise.all(queue.slice(i, i + 8).map(async (f) => ({ path: f.path, text: await artifacts.readText(repo, commit, f.path, 200_000).catch(() => null) })));
    for (const { path, text } of batch) {
      if (text === null) continue;
      const t = estimateTokens(text) + 40;
      if (used + t > budgetTokens) continue;
      used += t;
      sections.push({ title: `${label}: ${path}`, text: wrapUntrusted(nonce, path, text) });
    }
  }
  return sections;
}

type SearchHit = { cite: string; title: string; text: string; score: number };

export async function buildPack(env: Env, objectiveId: string, taskId: string, budgetTokens = 200_000, extra: PackSection[] = []): Promise<Pack> {
  const objective = objectiveStub(env, objectiveId);
  const state = await objective.state();
  const projectId = state.objective.project;
  if (!projectId) throw new Error("NOT_INITIALIZED");
  const project = projectStub(env, projectId);
  const context = await project.context();
  const notes = await project.notes();
  const task = state.tasks.find((t) => t.id === taskId);
  const people = new Map(state.participants.map((p) => [p.id, p.name]));
  const nonce = boundary();

  const mandatory: PackSection[] = [
    { title: "How to read this pack", text: UNTRUSTED_RULE.replaceAll("<id>", nonce) },
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
      text: wrapUntrusted(nonce, "published work", others.map((c) => {
        const reviews = state.reviews.filter((r) => r.target === c.id && !r.triage);
        const verdicts = reviews.map((r) => `${people.get(r.reviewer) ?? r.reviewer}: ${r.verdict}${r.summary ? ` — ${r.summary.slice(0, 200)}` : ""}`).join("; ");
        return `- ${c.id} "${c.title}" by ${people.get(c.author) ?? c.author} [${c.status}]${c.alternative ? ` alternative=${c.alternative}` : ""}\n  files: ${c.paths.join(", ")}${verdicts ? `\n  reviews: ${verdicts}` : ""}`;
      }).join("\n")),
    });
  }
  const findings = state.reviews.filter((r) => !r.triage && r.findings.length);
  if (findings.length) {
    optional.push({
      title: "Review findings so far",
      text: wrapUntrusted(nonce, "review findings", findings.slice(-40).map((r) => `- on ${short(r.target)} by ${people.get(r.reviewer) ?? r.reviewer}: ${r.findings.map((f) => f.text).join(" | ").slice(0, 400)}`).join("\n")),
    });
  }
  for (const item of context.filter((i) => !["requirement", "decision", "policy"].includes(i.kind)))
    optional.push({ title: `${item.kind}: ${item.title}`, cite: citeOf(item), text: item.body });
  // Massive context: the whole accepted repository, then other agents' full diffs, within the budget.
  const head = await project.head();
  if (head) optional.push(...(await repositorySections(env, projectRepo(projectId), head.commit, `Repository at checkpoint ${head.version}`, Math.floor(budgetTokens * 0.5), nonce, task ? fileHints(`${task.title}\n${task.brief}`) : [])));
  if (others.length) {
    const { contributionDiff } = await import("./workflows/review");
    let diffBudget = Math.floor(budgetTokens * 0.25);
    for (const c of others.filter((x) => x.status !== "blocked").slice(-8)) {
      if (diffBudget <= 0) break;
      const diff = await contributionDiff(env, c.repo, c.parent, c.commit, c.paths.slice(0, 20), 40_000).catch(() => "");
      if (!diff) continue;
      diffBudget -= estimateTokens(diff);
      optional.push({ title: `Diff of ${c.id} by ${people.get(c.author) ?? c.author}`, text: wrapUntrusted(nonce, `diff of ${c.id}`, `${c.title}\n\n${diff}`) });
    }
  }
  if (task) {
    const hits = await searchContext(env, projectId, `${task.title} ${task.brief}`.slice(0, 400));
    for (const h of hits.results.slice(0, 8)) optional.push({ title: `Related: ${h.title}`, cite: h.cite, text: h.text });
  }
  const pack = compilePack(mandatory, optional, budgetTokens);
  return pack;
}

/**
 * Keyword search over the project's current context items and notes: every term counts once per
 * occurrence, titles included. Results carry the citation an agent puts in Nest-Cites.
 */
export async function searchContext(env: Env, projectId: string, query: string): Promise<{ results: SearchHit[] }> {
  const project = projectStub(env, projectId);
  const context = await project.context();
  const notes = await project.notes();
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  const score = (text: string) => terms.reduce((n, t) => n + (text.toLowerCase().split(t).length - 1), 0);
  const hits: SearchHit[] = [
    ...context.map((i) => ({ cite: citeOf(i), title: i.title, text: i.body, score: score(`${i.title} ${i.body}`) })),
    ...notes.map((n) => ({ cite: n.id, title: n.title, text: n.body, score: score(`${n.title} ${n.body}`) })),
  ].filter((h) => h.score > 0);
  return { results: hits.sort((a, b) => b.score - a.score).slice(0, 12) };
}
