// Context staleness is a relation between a citation and the current version, never a flag on the work.

import type { Citation } from "../protocol";

export type CitationEdge = { from: string; kind: "contribution" | "review" | "pack"; cite: Citation };

export function staleCitations(cites: Citation[], current: Map<string, number>): Citation[] {
  return cites.filter((c) => {
    const v = current.get(c.item);
    return v !== undefined && v > c.version;
  });
}

/** Everything that relied on `item` at a version older than `newVersion`. */
export function blastRadius(edges: CitationEdge[], item: string, newVersion: number) {
  const hit = edges.filter((e) => e.cite.item === item && e.cite.version < newVersion);
  const ids = (kind: CitationEdge["kind"]) => [...new Set(hit.filter((e) => e.kind === kind).map((e) => e.from))].sort();
  return { contributions: ids("contribution"), reviews: ids("review"), packs: ids("pack") };
}

/** Rough token estimate used for pack budgets; providers report exact usage afterwards. */
export const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 4);
