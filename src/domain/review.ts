// Review routing: agents review everything, people are asked only when it matters.
// The policy is data so that changing it is itself a reviewable context change.

import type { ParticipantKind, Verdict } from "../protocol";

export type ReviewPolicy = {
  agentReviewers: number;
  minConfidence: number;
  protectedPaths: string[];
  humanOwnedItems: string[];
};

export const DEFAULT_POLICY: ReviewPolicy = {
  agentReviewers: 2,
  minConfidence: 0.75,
  protectedPaths: [".nest/", "wrangler.jsonc", "package.json", "pnpm-lock.yaml"],
  humanOwnedItems: [],
};

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
};

/** Repo-relative, "./" stripped; anything that tries to climb out is treated as protected. */
function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.join("/");
}

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
export function route(policy: ReviewPolicy, subject: Subject, reviews: ReviewFact[]): Routing {
  const others = reviews.filter((r) => r.reviewer !== subject.author);
  const people = others.filter((r) => r.kind === "person" && r.verdict !== "comment");
  const last = people[people.length - 1];
  if (last) return { state: last.verdict === "approve" ? "approved" : last.verdict === "block" ? "blocked" : "changes", by: "people" };

  if (!others.some((r) => r.triage)) return { state: "needs-triage" };

  // Independence: a reviewer from the author's own model family does not count.
  const required = Math.max(1, Math.floor(policy.agentReviewers));
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
  const protectedHit = subject.paths.filter((raw) => {
    const p = normalizePath(raw);
    if (p === null) return true;
    return policy.protectedPaths.some((q) => (q.endsWith("/") ? p.startsWith(q) || `${p}/` === q : p === q));
  });
  if (!subject.paths.length) reasons.push("Changed files are unknown");
  if (protectedHit.length) reasons.push(`Touches protected files: ${protectedHit.join(", ")}`);
  const owned = subject.citedItems.filter((i) => policy.humanOwnedItems.includes(i));
  if (owned.length && subject.authorKind === "agent") reasons.push(`Relies on human-owned context: ${owned.join(", ")}`);
  if (reasons.length) return { state: "needs-human", reasons };

  return { state: verdicts.has("changes") ? "changes" : "approved", by: "agents" };
}
