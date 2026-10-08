// Context items live as Markdown in the project's context repo. A context pack is the exact, cited
// bundle an agent or reviewer receives, with a manifest of what was included and its measured size.

import type { ContextItem, PolicyBlock } from "./project";
import { estimateTokens } from "./domain/context";
import { formatCitation } from "./protocol";

export function parseContextFile(path: string, text: string, commit: string): ContextItem | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  const body = m[2]!.trim();
  const policyText = /```nest-policy\n([\s\S]*?)\n```/.exec(body)?.[1];
  let policy: PolicyBlock | null = null;
  if (policyText) {
    try {
      const raw = JSON.parse(policyText) as Record<string, unknown>;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      policy = {
        ...(num(raw.agentReviewers) !== undefined ? { agentReviewers: num(raw.agentReviewers) } : {}),
        ...(num(raw.minConfidence) !== undefined ? { minConfidence: num(raw.minConfidence) } : {}),
        ...(strings(raw.protectedPaths) ? { protectedPaths: strings(raw.protectedPaths) } : {}),
        ...(raw.decider === "agents" || raw.decider === "human" ? { decider: raw.decider } : {}),
        ...(strings(raw.humanPaths) ? { humanPaths: strings(raw.humanPaths) } : {}),
        ...(typeof raw.autoAccept === "boolean" ? { autoAccept: raw.autoAccept } : {}),
      };
    } catch { policy = null; }
  }
  const version = Number(meta.version);
  if (!meta.id || !Number.isSafeInteger(version) || version < 1) return null;
  return {
    id: meta.id, version, kind: meta.kind ?? "note", title: meta.title ?? meta.id, owner: meta.owner ?? "human",
    body, policy, commit, path,
  };
}

export function renderContextFile(item: Omit<ContextItem, "commit" | "path">): string {
  return `---\nid: ${item.id}\nkind: ${item.kind}\nversion: ${item.version}\nowner: ${item.owner}\ntitle: ${item.title}\n---\n${item.body}\n`;
}

export type PackSection = { title: string; cite?: string; text: string };
export type Pack = { manifest: { cite: string; tokens: number }[]; tokens: number; text: string };

/**
 * Builds a pack in priority order and stops at the budget. Mandatory sections (objective, accepted
 * requirements and decisions) are always included; later sections are dropped whole, never truncated
 * mid-item, and the manifest says exactly what made it in.
 */
export function compilePack(mandatory: PackSection[], optional: PackSection[], budgetTokens: number): Pack {
  const parts: string[] = [];
  const manifest: { cite: string; tokens: number }[] = [];
  let tokens = 0;
  const add = (s: PackSection) => {
    const text = `## ${s.title}${s.cite ? `  [${s.cite}]` : ""}\n\n${s.text.trim()}\n`;
    const t = estimateTokens(text);
    parts.push(text);
    manifest.push({ cite: s.cite ?? s.title, tokens: t });
    tokens += t;
  };
  for (const s of mandatory) add(s);
  for (const s of optional) {
    const t = estimateTokens(s.text) + 20;
    if (tokens + t > budgetTokens) continue;
    add(s);
  }
  return { manifest, tokens, text: parts.join("\n") };
}

export const citeOf = (i: Pick<ContextItem, "id" | "version">) => formatCitation({ item: i.id, version: i.version });
