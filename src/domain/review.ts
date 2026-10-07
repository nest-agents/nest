// Review routing: agents review everything, people are asked only when it matters.
// The policy is data so that changing it is itself a reviewable context change.

import type { ParticipantKind, Verdict } from "../protocol";

export type ReviewPolicy = {
  agentReviewers: number;
  minConfidence: number;
  protectedPaths: string[];
};

/**
 * Floors that no policy can lower. A policy may add protected paths or raise thresholds; it can never
 * remove these, so a missing or partial policy fails closed rather than open.
 */
export const FLOOR = {
  agentReviewers: 1,
  minConfidence: 0.5,
  protectedPaths: [".nest/", "wrangler.jsonc", "wrangler.toml", "package.json", "pnpm-lock.yaml", "package-lock.json"],
} as const;

export const DEFAULT_POLICY: ReviewPolicy = {
  agentReviewers: 2,
  minConfidence: 0.75,
  protectedPaths: [...FLOOR.protectedPaths],
};

export function effectivePolicy(policy: Partial<ReviewPolicy> | null | undefined): ReviewPolicy {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    agentReviewers: Math.max(FLOOR.agentReviewers, Math.floor(n(policy?.agentReviewers, DEFAULT_POLICY.agentReviewers))),
    minConfidence: Math.min(1, Math.max(FLOOR.minConfidence, n(policy?.minConfidence, DEFAULT_POLICY.minConfidence))),
    protectedPaths: [...new Set([...FLOOR.protectedPaths, ...(Array.isArray(policy?.protectedPaths) ? policy!.protectedPaths.filter((p) => typeof p === "string") : [])])],
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
  /** Deterministic concerns (for example possible prompt injection) that only a person can clear. */
  flags?: string[];
};

/**
 * Paths arrive as exact git tree paths from ingest. Nest never rewrites them: a path that is not
 * already plain (printable ASCII segments, no "." or ".." segments, no empty segments, no trailing
 * dot or space, no backslash) is unusual enough that a person should look.
 */
export function unusualPath(path: string): boolean {
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(path) || path.includes("\\")) return true;
  return path.split("/").some((s) => s === "" || s === "." || s === ".." || /[. ]$/.test(s));
}

const protectedMatch = (path: string, rule: string) => {
  const p = path.toLowerCase();
  const q = rule.toLowerCase();
  return q.endsWith("/") ? p.startsWith(q) || `${p}/` === q : p === q;
};

const validConfidence = (c: number) => Number.isFinite(c) && c >= 0 && c <= 1;

export type Routing =
  | { state: "needs-triage" }
  | { state: "needs-reviewers"; count: number; excludeFamilies: string[] }
  | { state: "needs-human"; reasons: string[] }
  | { state: "approved" | "changes" | "blocked"; by: "people" | "agents" };

/**
 * `ReviewFact.kind` and `reviewer` must come from the authenticated principal, never from a
 * review payload. Authors never count as reviewers of their own work, person or agent.
 */
export function route(given: ReviewPolicy, subject: Subject, reviews: ReviewFact[]): Routing {
  const policy = effectivePolicy(given);
  const others = reviews.filter((r) => r.reviewer !== subject.author);
  const people = others.filter((r) => r.kind === "person" && r.verdict !== "comment");
  const last = people[people.length - 1];
  if (last) return { state: last.verdict === "approve" ? "approved" : last.verdict === "block" ? "blocked" : "changes", by: "people" };

  if (!others.some((r) => r.triage)) return { state: "needs-triage" };

  // Independence: a reviewer from the author's own model family does not count.
  const required = policy.agentReviewers;
  const agents = others.filter((r) => r.kind === "agent" && !r.triage && r.verdict !== "comment" && r.family !== subject.authorFamily);
  const families = new Set(agents.map((r) => r.family));
  if (families.size < required) {
    return {
      state: "needs-reviewers",
      count: required - families.size,
      excludeFamilies: [...new Set([subject.authorFamily, ...families])],
    };
  }

  const reasons: string[] = [];
  const verdicts = new Set(agents.map((r) => r.verdict));
  if (verdicts.size > 1) reasons.push("Reviewers disagree");
  if (verdicts.has("block")) reasons.push("A reviewer blocked it");
  if (agents.some((r) => !validConfidence(r.confidence) || r.confidence < policy.minConfidence)) reasons.push("Reviewer confidence is low");
  const unusual = subject.paths.filter(unusualPath);
  const protectedHit = subject.paths.filter((p) => !unusualPath(p) && policy.protectedPaths.some((q) => protectedMatch(p, q)));
  if (!subject.paths.length) reasons.push("Changed files are unknown");
  if (unusual.length) reasons.push(`Unusual file paths: ${unusual.map((p) => JSON.stringify(p)).join(", ")}`);
  if (subject.specialEntries) reasons.push("Adds a symlink or submodule");
  for (const f of subject.flags ?? []) reasons.push(f);
  if (protectedHit.length) reasons.push(`Touches protected files: ${protectedHit.join(", ")}`);
  if (reasons.length) return { state: "needs-human", reasons };

  return { state: verdicts.has("changes") ? "changes" : "approved", by: "agents" };
}
