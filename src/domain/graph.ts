// Contribution graph: authoring bases, dependency closure and the frontier of candidate outcomes.

export type ContributionStatus = "proposed" | "approved" | "changes" | "blocked" | "superseded" | "accepted";

export type ContributionNode = {
  id: string;
  commit: string;
  requires: string[];
  alternative?: string;
  supersedes?: string;
  status: ContributionStatus;
  seq: number;
};

export class GraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export type AuthoringIndex = {
  checkpointCommits: Set<string>;
  byCommit: Map<string, { id: string; requires: string[] }>;
  materializations: Map<string, string[]>;
};

/**
 * Which contributions were present in the tree this commit was written on.
 * Its single parent must be an accepted checkpoint, a registered contribution, or a
 * base that Nest itself materialized from declared contributions.
 */
export function authoredOn(parent: string, index: AuthoringIndex): string[] {
  if (index.checkpointCommits.has(parent)) return [];
  const prior = index.byCommit.get(parent);
  if (prior) return [...new Set([prior.id, ...prior.requires])].sort();
  const base = index.materializations.get(parent);
  if (base) return [...base].sort();
  throw new GraphError(
    "UNKNOWN_PARENT",
    `parent ${parent.slice(0, 12)} is not a checkpoint, a contribution or a Nest-materialized base`,
  );
}

/** Dependency-closed, deterministic application order. `accepted` ids are satisfied by the base. */
export function closure(nodes: Map<string, ContributionNode>, selected: string[], accepted: Set<string> = new Set()): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const active: string[] = [];
  const bySeq = (a: string, b: string) => (nodes.get(a)?.seq ?? 0) - (nodes.get(b)?.seq ?? 0) || a.localeCompare(b);
  const visit = (id: string) => {
    if (done.has(id) || accepted.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new GraphError("MISSING_DEPENDENCY", `unknown contribution ${id}`);
    if (active.includes(id)) throw new GraphError("DEPENDENCY_CYCLE", [...active, id].join(" -> "));
    active.push(id);
    for (const dep of [...node.requires].sort(bySeq)) visit(dep);
    active.pop();
    done.add(id);
    order.push(id);
  };
  for (const id of [...new Set(selected)].sort(bySeq)) visit(id);
  assertCompatible(nodes, [...order, ...accepted]);
  return order;
}

/** One option per alternative group, and never a contribution together with the one it supersedes. */
export function assertCompatible(nodes: Map<string, ContributionNode>, ids: Iterable<string>): void {
  const groups = new Map<string, string>();
  const set = new Set(ids);
  for (const id of set) {
    const n = nodes.get(id);
    if (!n) continue;
    if (n.alternative) {
      const prior = groups.get(n.alternative);
      if (prior && prior !== id)
        throw new GraphError("ALTERNATIVE_CONFLICT", `${prior} and ${id} are alternatives in ${n.alternative}`);
      groups.set(n.alternative, id);
    }
    if (n.supersedes && set.has(n.supersedes))
      throw new GraphError("SUPERSEDED_SELECTED", `${id} replaces ${n.supersedes}; select one`);
  }
}

export type PlannedCandidate = { selected: string[]; order: string[]; choice: Record<string, string>; ready: boolean };

/**
 * Enumerates the outcomes worth composing: one option per open alternative group, plus every
 * other live contribution whose dependencies survive that choice. Bounded and deterministic.
 */
export function planFrontier(
  nodes: Map<string, ContributionNode>,
  accepted: Set<string>,
  limit = 8,
): PlannedCandidate[] {
  const live = [...nodes.values()].filter(
    (n) => !accepted.has(n.id) && n.status !== "blocked" && n.status !== "superseded" && n.status !== "accepted",
  );
  const replaced = new Set(live.map((n) => n.supersedes).filter((x): x is string => !!x));
  const pool = live.filter((n) => !replaced.has(n.id));
  const locked = new Map<string, string>();
  for (const id of accepted) {
    const n = nodes.get(id);
    if (n?.alternative) locked.set(n.alternative, id);
  }
  const groups = new Map<string, ContributionNode[]>();
  for (const n of pool)
    if (n.alternative && !locked.has(n.alternative)) groups.set(n.alternative, [...(groups.get(n.alternative) ?? []), n]);
  const groupNames = [...groups.keys()].sort();
  const combos: Record<string, string>[] = [{}];
  for (const g of groupNames) {
    const next: Record<string, string>[] = [];
    for (const c of combos) for (const opt of groups.get(g)!.sort((a, b) => a.seq - b.seq)) next.push({ ...c, [g]: opt.id });
    combos.splice(0, combos.length, ...next.slice(0, 64));
  }
  const out: PlannedCandidate[] = [];
  const seen = new Set<string>();
  for (const choice of combos) {
    const chosen = new Set(Object.values(choice));
    const excluded = new Set(
      pool.filter((n) => n.alternative && (locked.has(n.alternative) ? locked.get(n.alternative) !== n.id : !chosen.has(n.id))).map((n) => n.id),
    );
    for (const id of replaced) excluded.add(id);
    const usable = (id: string, trail: Set<string> = new Set()): boolean => {
      if (accepted.has(id)) return true;
      if (excluded.has(id) || trail.has(id)) return false;
      const n = nodes.get(id);
      if (!n || n.status === "blocked" || n.status === "superseded") return false;
      trail.add(id);
      return n.requires.every((d) => usable(d, trail));
    };
    const selected = pool.filter((n) => !excluded.has(n.id) && usable(n.id)).map((n) => n.id);
    if (!selected.length) continue;
    let order: string[];
    try {
      order = closure(nodes, selected, accepted);
    } catch {
      continue;
    }
    const key = order.join("+");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ selected, order, choice, ready: order.every((id) => nodes.get(id)!.status === "approved") });
  }
  // Ready first, then the most complete, then whichever chose earlier-published work.
  const seqs = (c: PlannedCandidate) => Object.keys(c.choice).sort().map((g) => nodes.get(c.choice[g]!)!.seq);
  const earlier = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  };
  return out
    .sort((a, b) => Number(b.ready) - Number(a.ready) || b.order.length - a.order.length || earlier(seqs(a), seqs(b)))
    .slice(0, limit);
}
