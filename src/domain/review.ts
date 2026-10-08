// Review routing: agents review everything, humans are asked only when it matters.
// The policy is data so that changing it is itself a reviewable context change.

import type { ParticipantKind, Verdict } from "../protocol";

export type ReviewPolicy = {
  agentReviewers: number;
  minConfidence: number;
  protectedPaths: string[];
  /**
   * Who settles what a first round of agent reviews does not: "human" asks a human; "agents" asks another
   * reviewer family and lets unanimous, confident agents decide. Either way a human's review decides over agents'.
   */
  decider: "human" | "agents";
  /** When agents decide, changes to these paths still need a human. */
  humanPaths: string[];
  /** Accept a ready outcome without a human, unless accepting it would choose between people's work. */
  autoAccept: boolean;
};

/**
 * Floors that no policy can lower. A policy may add protected paths or raise thresholds; it can never
 * remove these, so a missing or partial policy fails closed rather than open.
 */
export const FLOOR = {
  agentReviewers: 1,
  minConfidence: 0.5,
  // What decides how a project is installed, built and deployed: a change here can run code in a build.
  protectedPaths: [
    ".nest/", "wrangler.jsonc", "wrangler.json", "wrangler.toml", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "bun.lock", "bun.lockb", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "pnpm-workspace.yaml", "bunfig.toml",
  ],
  // Even when agents decide, no model may approve a change to how Nest checks the project.
  humanPaths: [".nest/"],
} as const;

/** Raised bar for a protected file when agents decide alone. */
export const AGENT_PROTECTED_CONFIDENCE = 0.9;

export const DEFAULT_POLICY: ReviewPolicy = {
  agentReviewers: 2,
  minConfidence: 0.75,
  protectedPaths: [...FLOOR.protectedPaths],
  decider: "human",
  // By default, what decides how the project is installed and built stays with a human even when agents
  // decide everything else. A human may narrow this to the floor, in the policy, on purpose.
  humanPaths: [...FLOOR.protectedPaths],
  autoAccept: false,
};

export function effectivePolicy(policy: Partial<ReviewPolicy> | null | undefined): ReviewPolicy {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    agentReviewers: Math.max(FLOOR.agentReviewers, Math.floor(n(policy?.agentReviewers, DEFAULT_POLICY.agentReviewers))),
    minConfidence: Math.min(1, Math.max(FLOOR.minConfidence, n(policy?.minConfidence, DEFAULT_POLICY.minConfidence))),
    protectedPaths: [...new Set([...FLOOR.protectedPaths, ...(Array.isArray(policy?.protectedPaths) ? policy!.protectedPaths.filter((p) => typeof p === "string") : [])])],
    decider: policy?.decider === "agents" ? "agents" : "human",
    humanPaths: [...new Set([...FLOOR.humanPaths, ...(Array.isArray(policy?.humanPaths) ? policy!.humanPaths.filter((p) => typeof p === "string") : DEFAULT_POLICY.humanPaths)])],
    autoAccept: policy?.autoAccept === true,
  };
}

export type ReviewFact = {
  reviewer: string;
  kind: ParticipantKind;
  family: string;
  verdict: Verdict;
  confidence: number;
  triage?: boolean;
};

export type Subject = {
  author: string;
  authorKind: ParticipantKind;
  authorFamily: string;
  paths: string[];
  citedItems: string[];
  /** True when the change adds a symlink (mode 120000) or a submodule (mode 160000). */
  specialEntries?: boolean;
  /** Deterministic concerns (for example possible prompt injection) that only a human can clear. */
  flags?: string[];
};

/**
 * Paths arrive as exact git tree paths from ingest. Nest never rewrites them: a path that is not
 * already plain (printable ASCII segments, no "." or ".." segments, no empty segments, no trailing
 * dot or space, no backslash) is unusual enough that a human should look.
 */
export function unusualPath(path: string): boolean {
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(path) || path.includes("\\")) return true;
  return path.split("/").some((s) => s === "" || s === "." || s === ".." || /[. ]$/.test(s));
}

/**
 * A rule ending in "/" is a directory; a rule with a "/" inside is one exact path; a rule without any
 * names that file anywhere in the tree, since a nested package.json or .npmrc also decides what an install runs.
 */
export const protectedMatch = (path: string, rule: string) => {
  const p = path.toLowerCase();
  const q = rule.toLowerCase();
  if (q.endsWith("/")) return p.startsWith(q) || `${p}/` === q;
  if (!q.includes("/")) return p === q || p.endsWith(`/${q}`);
  return p === q;
};

const validConfidence = (c: number) => Number.isFinite(c) && c >= 0 && c <= 1;

export type Routing =
  | { state: "needs-triage" }
  | { state: "needs-reviewers"; count: number; excludeFamilies: string[] }
  | { state: "needs-human"; reasons: string[] }
  | { state: "approved" | "changes" | "blocked"; by: "people" | "agents" };

/**
 * `ReviewFact.kind` and `reviewer` must come from the authenticated principal, never from a
 * review payload. Authors never count as reviewers of their own work, human or agent.
 */
export function route(given: ReviewPolicy, subject: Subject, reviews: ReviewFact[]): Routing {
  const policy = effectivePolicy(given);
  const others = reviews.filter((r) => r.reviewer !== subject.author);
  const people = others.filter((r) => r.kind === "person" && r.verdict !== "comment");
  const last = people[people.length - 1];
  if (last) return { state: last.verdict === "approve" ? "approved" : last.verdict === "block" ? "blocked" : "changes", by: "people" };

  if (!others.some((r) => r.triage)) return { state: "needs-triage" };

  // Independence: a reviewer from the author's own model family does not count. When agents decide alone,
  // one family is never enough, whatever the policy says.
  const required = policy.decider === "agents" ? Math.max(2, policy.agentReviewers) : policy.agentReviewers;
  const agents = others.filter((r) => r.kind === "agent" && !r.triage && r.verdict !== "comment" && r.family !== subject.authorFamily);
  const families = new Set(agents.map((r) => r.family));
  if (families.size < required) {
    return {
      state: "needs-reviewers",
      count: required - families.size,
      excludeFamilies: [...new Set([subject.authorFamily, ...families])],
    };
  }

  const verdicts = new Set(agents.map((r) => r.verdict));
  const unusual = subject.paths.filter(unusualPath);
  const protectedHit = subject.paths.filter((p) => !unusualPath(p) && policy.protectedPaths.some((q) => protectedMatch(p, q)));
  // What no model may clear, whoever decides: changes reviewers could not fully see, and deterministic guards.
  const hard: string[] = [];
  if (!subject.paths.length) hard.push("Changed files are unknown");
  if (unusual.length) hard.push(`Unusual file paths: ${unusual.map((p) => JSON.stringify(p)).join(", ")}`);
  if (subject.specialEntries) hard.push("Adds a symlink or submodule");
  for (const f of subject.flags ?? []) hard.push(f);

  if (policy.decider === "agents") {
    const humanOnly = subject.paths.filter((p) => !unusualPath(p) && policy.humanPaths.some((q) => protectedMatch(p, q)));
    if (humanOnly.length) hard.push(`Only a human may approve changes to ${humanOnly.join(", ")}`);
    if (hard.length) return { state: "needs-human", reasons: hard };
    if (verdicts.has("block")) return { state: "blocked", by: "agents" };
    // Agents deciding alone must be unanimous and confident; protected files raise the bar.
    const bar = protectedHit.length ? Math.max(policy.minConfidence, AGENT_PROTECTED_CONFIDENCE) : policy.minConfidence;
    if (verdicts.size === 1 && agents.every((r) => validConfidence(r.confidence) && r.confidence >= bar))
      return { state: verdicts.has("changes") ? "changes" : "approved", by: "agents" };
    // Not settled: one more independent family, once. After that, a human, told exactly why.
    if (families.size < required + 1)
      return { state: "needs-reviewers", count: 1, excludeFamilies: [...new Set([subject.authorFamily, ...families])] };
    const why = verdicts.size > 1 ? "Reviewers disagree, even with a reviewer from another family"
      : protectedHit.length ? `Reviewers agree but none is confident enough (${bar}) for a change to protected files: ${protectedHit.join(", ")}`
      : "Reviewers agree but are not confident enough";
    return { state: "needs-human", reasons: [why] };
  }

  const reasons: string[] = [];
  if (verdicts.size > 1) reasons.push("Reviewers disagree");
  if (verdicts.has("block")) reasons.push("A reviewer blocked it");
  if (agents.some((r) => !validConfidence(r.confidence) || r.confidence < policy.minConfidence)) reasons.push("Reviewer confidence is low");
  reasons.push(...hard);
  if (protectedHit.length) reasons.push(`Touches protected files: ${protectedHit.join(", ")}`);
  if (reasons.length) return { state: "needs-human", reasons };

  return { state: verdicts.has("changes") ? "changes" : "approved", by: "agents" };
}
