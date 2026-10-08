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
  /** Paths this contribution creates. Two independent contributions that create the same path cannot compose. */
  adds?: string[];
  /** The task it was written for. Commits of one task in one alternative group are one option, chosen together. */
  task?: string;
};

/** Within an alternative group, an approach is everything one task contributed to it. */
const optionOf = (n: ContributionNode) => n.task ?? n.id;

/** Every contribution this one depends on, directly or not. */
function ancestors(nodes: Map<string, ContributionNode>, id: string, seen = new Set<string>()): Set<string> {
  for (const d of nodes.get(id)?.requires ?? []) if (!seen.has(d)) { seen.add(d); ancestors(nodes, d, seen); }
  return seen;
}

/**
 * Implicit alternatives: independent contributions that create the same file are mutually exclusive, so
 * the planner chooses between them instead of composing a conflict it can already see.
 */
export function overlapGroups(nodes: Map<string, ContributionNode>, ids: string[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = nodes.get(ids[i]!)!, b = nodes.get(ids[j]!)!;
    if (!a.adds?.length || !b.adds?.length || !a.adds.some((p) => b.adds!.includes(p))) continue;
    if (ancestors(nodes, a.id).has(b.id) || ancestors(nodes, b.id).has(a.id)) continue;
    parent.set(find(a.id), find(b.id));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((x, y) => nodes.get(x)!.seq - nodes.get(y)!.seq));
}

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
  const groups = new Map<string, ContributionNode>();
  const set = new Set(ids);
  for (const id of set) {
    const n = nodes.get(id);
    if (!n) continue;
    if (n.alternative) {
      const prior = groups.get(n.alternative);
      if (prior && optionOf(prior) !== optionOf(n))
        throw new GraphError("ALTERNATIVE_CONFLICT", `${prior.id} and ${id} are alternatives in ${n.alternative}`);
      groups.set(n.alternative, n);
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
  // Superseding your own work retires it at once (its status says so). A replacement of someone else's
  // work, which only a human-requested reconcile can publish, takes effect once it is approved; until
  // then both stay plannable, and closure never selects both.
  const replaced = new Set(live.filter((n) => n.status === "approved" || nodes.get(n.supersedes ?? "")?.status === "superseded").map((n) => n.supersedes).filter((x): x is string => !!x));
  // A file the checkpoint already has cannot be created again: such work can never apply.
  const settled = new Set([...nodes.values()].filter((n) => accepted.has(n.id) || n.status === "accepted").flatMap((n) => n.adds ?? []));
  // Once a group is decided, every task that explored a losing option lost as a whole, tagged or not.
  const decided = new Map<string, string>();
  for (const n of nodes.values()) if ((accepted.has(n.id) || n.status === "accepted") && n.alternative) decided.set(n.alternative, optionOf(n));
  const losingTasks = new Set([...nodes.values()].filter((n) => n.alternative && n.task && decided.has(n.alternative) && decided.get(n.alternative) !== optionOf(n)).map((n) => n.task!));
  const dead = new Set(live.filter((n) => (n.adds ?? []).some((p) => settled.has(p)) || (n.task && losingTasks.has(n.task))).map((n) => n.id));
  const pool = live.filter((n) => !replaced.has(n.id) && !dead.has(n.id));
  const locked = new Map<string, string>();
  for (const id of accepted) {
    const n = nodes.get(id);
    if (n?.alternative) locked.set(n.alternative, optionOf(n));
  }
  // Each group lists its options; an option's representative is its earliest contribution.
  const groups = new Map<string, ContributionNode[]>();
  for (const n of pool) {
    if (!n.alternative || locked.has(n.alternative)) continue;
    const opts = groups.get(n.alternative) ?? [];
    if (!opts.some((o) => optionOf(o) === optionOf(n))) groups.set(n.alternative, [...opts, n]);
    else groups.set(n.alternative, opts.map((o) => (optionOf(o) === optionOf(n) && n.seq < o.seq ? n : o)));
  }
  // Overlaps among the remaining free contributions become implicit groups named after the shared file.
  const free = pool.filter((n) => !n.alternative).map((n) => n.id);
  const implicit = new Map<string, string>();
  for (const g of overlapGroups(nodes, free)) {
    const shared = nodes.get(g[0]!)!.adds!.find((p) => g.every((id) => nodes.get(id)!.adds?.includes(p))) ?? g[0]!;
    const name = `overlap:${shared}`;
    groups.set(name, g.map((id) => nodes.get(id)!));
    for (const id of g) implicit.set(id, name);
  }
  // A replacement still awaiting approval is a choice between it and the original.
  const freeSet = new Set(free);
  for (const n of pool) {
    const old = n.supersedes;
    if (!old || replaced.has(old) || !freeSet.has(n.id) || !freeSet.has(old)) continue;
    const name = implicit.get(old) ?? implicit.get(n.id) ?? `replace:${old}`;
    const members = groups.get(name) ?? [];
    for (const m of [nodes.get(old)!, n]) if (!members.some((x) => x.id === m.id)) members.push(m);
    groups.set(name, members);
    implicit.set(old, name);
    implicit.set(n.id, name);
  }
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
      pool.filter((n) => {
        if (n.alternative) {
          const want = locked.get(n.alternative) ?? (choice[n.alternative] ? optionOf(nodes.get(choice[n.alternative]!)!) : undefined);
          return want !== optionOf(n);
        }
        const group = implicit.get(n.id);
        return group ? !chosen.has(n.id) : false;
      }).map((n) => n.id),
    );
    for (const id of [...replaced, ...dead]) excluded.add(id);
    // A pending replacement that could not become a choice (one side is in an explicit group) wins when
    // both are in play, so the combination is not lost to an incompatibility.
    for (const n of pool)
      if (n.supersedes && !excluded.has(n.id) && !(implicit.get(n.id) && implicit.get(n.id) === implicit.get(n.supersedes))) excluded.add(n.supersedes);
    // Memoized depth-first search. Shared ancestors (diamonds) are normal: every commit requires its
    // whole authoring closure. Only an id still on the current path is a cycle.
    const memo = new Map<string, boolean>();
    const onPath = new Set<string>();
    const usable = (id: string): boolean => {
      if (accepted.has(id)) return true;
      if (excluded.has(id) || onPath.has(id)) return false;
      const known = memo.get(id);
      if (known !== undefined) return known;
      const n = nodes.get(id);
      if (!n || n.status === "blocked" || n.status === "superseded") return false;
      onPath.add(id);
      const ok = n.requires.every((d) => usable(d));
      onPath.delete(id);
      memo.set(id, ok);
      return ok;
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
  const approvedCount = (c: PlannedCandidate) => c.order.filter((id) => nodes.get(id)!.status === "approved").length;
  // A fragment of another outcome is worth composing only after the whole outcomes are.
  const sets = out.map((c) => new Set(c.order));
  const maximal = new Map(out.map((c, i) => [c, !sets.some((t, j) => j !== i && t.size > sets[i]!.size && c.order.every((id) => t.has(id)))]));
  // Whole outcomes first, then ready, then the most approved, then whichever chose earlier-published work.
  const seqs = (c: PlannedCandidate) => Object.keys(c.choice).sort().map((g) => nodes.get(c.choice[g]!)!.seq);
  const earlier = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  };
  return out
    .sort((a, b) => Number(maximal.get(b)) - Number(maximal.get(a)) || Number(b.ready) - Number(a.ready) || approvedCount(b) - approvedCount(a) || b.order.length - a.order.length || earlier(seqs(a), seqs(b)))
    .slice(0, limit);
}
