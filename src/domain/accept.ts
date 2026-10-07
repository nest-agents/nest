// Acceptance is a compare-and-swap on the project head, checked inside one storage transaction.

export type Head = { version: number; checkpointId: string; commit: string; contextDigest: string; policyDigest: string };

export type AcceptRequest = {
  candidateId: string;
  expectedVersion: number;
  expectedContextDigest: string;
  expectedPolicyDigest: string;
};

export type CandidateFacts = {
  baseVersion: number;
  contextDigest: string;
  policyDigest: string;
  checks: { id: string; status: string }[];
  requiredChecks: string[];
  membersApproved: boolean;
  openConflicts: number;
  staleCitations: number;
  contextReviewRecorded: boolean;
  commit: string;
  parentOk: boolean;
};

export function acceptError(head: Head, req: AcceptRequest, c: CandidateFacts): string | null {
  if (req.expectedVersion !== head.version) return "BASELINE_MOVED";
  if (req.expectedContextDigest !== head.contextDigest || req.expectedPolicyDigest !== head.policyDigest) return "CONTEXT_MOVED";
  if (c.baseVersion !== head.version || c.contextDigest !== head.contextDigest || c.policyDigest !== head.policyDigest)
    return "STALE_CANDIDATE";
  for (const id of c.requiredChecks) {
    const runs = c.checks.filter((x) => x.id === id);
    if (runs.length !== 1 || runs[0]!.status !== "PASS") return "CHECKS_NOT_PASSING";
  }
  if (!c.membersApproved) return "REVIEW_INCOMPLETE";
  if (c.openConflicts > 0) return "OPEN_CONFLICT";
  if (c.staleCitations > 0 && !c.contextReviewRecorded) return "CONTEXT_REVIEW_REQUIRED";
  if (!c.parentOk) return "NOT_FAST_FORWARD";
  return null;
}
