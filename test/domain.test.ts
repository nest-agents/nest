import { describe, expect, it } from "vitest";
import { canonical, contributionId, parseCitation, parseTrailers } from "../src/protocol";
import { authoredOn, closure, GraphError, planFrontier, type ContributionNode } from "../src/domain/graph";
import { blastRadius, staleCitations } from "../src/domain/context";
import { DEFAULT_POLICY, route, type ReviewFact } from "../src/domain/review";
import { acceptError, type CandidateFacts, type Head } from "../src/domain/accept";

const C = (id: string, seq: number, extra: Partial<ContributionNode> = {}): ContributionNode => ({
  id, commit: id.padEnd(40, "0").slice(0, 40), requires: [], status: "approved", seq, ...extra,
});
const graph = (...n: ContributionNode[]) => new Map(n.map((x) => [x.id, x]));
const code = (fn: () => unknown) => { try { fn(); return "OK"; } catch (e) { return e instanceof GraphError ? e.code : String(e); } };

describe("protocol", () => {
  it("canonical JSON is key-order independent and rejects non-finite numbers", () => {
    expect(canonical({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
    expect(() => canonical({ x: Number.NaN })).toThrow();
  });
  it("contribution ids depend on repository and commit", async () => {
    const a = await contributionId("nest-ws-00", "t-a-e1", "a".repeat(40));
    expect(a).toMatch(/^c_[0-9a-f]{12}$/);
    expect(a).not.toBe(await contributionId("nest-ws-01", "t-a-e1", "a".repeat(40)));
  });
  it("parses citations with versions and line ranges", () => {
    expect(parseCitation("req/export-columns@v2#L3-7")).toEqual({ item: "req/export-columns", version: 2, lines: [3, 7] });
    expect(parseCitation("dec/0004@v1")).toEqual({ item: "dec/0004", version: 1 });
    expect(parseCitation("req/x@v0")).toBeNull();
    expect(parseCitation("req/x@v2#L9-3")).toBeNull();
  });
  it("reads trailers only from the final paragraph and reports malformed ones", () => {
    const t = parseTrailers(
      "Add encoder\n\nBody mentions Nest-Task: t_fake\n\nNest-Task: t_csv\nNest-Attempt: t_csv/e2\nNest-Requires: c_aaaaaaaaaaaa, c_bbbbbbbbbbbb\nNest-Alternative: export-strategy\nNest-Cites: req/csv-format@v1#L1-4, bad-cite\nNest-Assumes: rows are pre-filtered\nNest-Bogus: 1",
    );
    expect(t.task).toBe("t_csv");
    expect(t.attempt).toEqual({ task: "t_csv", epoch: 2 });
    expect(t.requires).toEqual(["c_aaaaaaaaaaaa", "c_bbbbbbbbbbbb"]);
    expect(t.alternative).toBe("export-strategy");
    expect(t.cites).toEqual([{ item: "req/csv-format", version: 1, lines: [1, 4] }]);
    expect(t.assumes).toEqual(["rows are pre-filtered"]);
    expect(t.invalid).toEqual(["Nest-Cites: bad-cite", "Nest-Bogus: 1"]);
    expect(parseTrailers("single paragraph\nNest-Task: t_x").task).toBeUndefined();
  });
});

describe("authoring base", () => {
  const index = {
    checkpointCommits: new Set(["c".repeat(40)]),
    byCommit: new Map([["a".repeat(40), { id: "c_a", requires: ["c_z"] }]]),
    materializations: new Map([["m".repeat(40), ["c_b", "c_a"]]]),
  };
  it("accepts a checkpoint, a prior contribution, or a Nest-materialized base", () => {
    expect(authoredOn("c".repeat(40), index)).toEqual([]);
    expect(authoredOn("a".repeat(40), index)).toEqual(["c_a", "c_z"]);
    expect(authoredOn("m".repeat(40), index)).toEqual(["c_a", "c_b"]);
  });
  it("rejects any other parent", () => {
    expect(code(() => authoredOn("f".repeat(40), index))).toBe("UNKNOWN_PARENT");
  });
});

describe("closure", () => {
  const g = graph(
    C("enc", 1),
    C("direct", 2, { requires: ["enc"], alternative: "strategy" }),
    C("bg", 3, { requires: ["enc"], alternative: "strategy" }),
    C("ui", 4),
    C("tests", 5, { requires: ["ui"] }),
  );
  it("orders dependencies first and includes them automatically", () => {
    expect(closure(g, ["tests", "bg"])).toEqual(["enc", "bg", "ui", "tests"]);
  });
  it("treats accepted contributions as already satisfied", () => {
    expect(closure(g, ["bg"], new Set(["enc"]))).toEqual(["bg"]);
  });
  it("rejects alternatives together, including against the accepted base", () => {
    expect(code(() => closure(g, ["direct", "bg"]))).toBe("ALTERNATIVE_CONFLICT");
    expect(code(() => closure(g, ["direct"], new Set(["enc", "bg"])))).toBe("ALTERNATIVE_CONFLICT");
  });
  it("rejects missing dependencies and cycles", () => {
    expect(code(() => closure(graph(C("x", 1, { requires: ["nope"] })), ["x"]))).toBe("MISSING_DEPENDENCY");
    expect(code(() => closure(graph(C("x", 1, { requires: ["y"] }), C("y", 2, { requires: ["x"] })), ["x"]))).toBe("DEPENDENCY_CYCLE");
  });
  it("rejects a contribution together with the one it supersedes", () => {
    expect(code(() => closure(graph(C("old", 1), C("new", 2, { supersedes: "old" })), ["old", "new"]))).toBe("SUPERSEDED_SELECTED");
  });
});

describe("frontier", () => {
  it("offers one outcome per alternative and keeps shared pieces in both", () => {
    const g = graph(
      C("enc", 1),
      C("direct", 2, { requires: ["enc"], alternative: "strategy" }),
      C("bg", 3, { requires: ["enc"], alternative: "strategy" }),
      C("ui", 4),
      C("tests", 5, { requires: ["ui"] }),
    );
    const f = planFrontier(g, new Set());
    expect(f.map((c) => c.order)).toEqual([
      ["enc", "direct", "ui", "tests"],
      ["enc", "bg", "ui", "tests"],
    ]);
    expect(f.every((c) => c.ready)).toBe(true);
  });
  it("drops blocked work and anything that depends on it, and prefers replacements", () => {
    const g = graph(
      C("enc", 1),
      C("direct", 2, { requires: ["enc"], alternative: "strategy", status: "blocked" }),
      C("bg", 3, { requires: ["enc"], alternative: "strategy" }),
      C("copy", 4, { status: "changes" }),
      C("copy2", 5, { supersedes: "copy" }),
    );
    const f = planFrontier(g, new Set());
    expect(f).toHaveLength(1);
    expect(f[0]!.order).toEqual(["enc", "bg", "copy2"]);
  });
  it("marks an outcome not ready while a member awaits review", () => {
    const f = planFrontier(graph(C("a", 1), C("b", 2, { status: "proposed" })), new Set());
    expect(f[0]!.ready).toBe(false);
  });
  it("locks an alternative group once one option is accepted", () => {
    const g = graph(
      C("enc", 1, { status: "accepted" }),
      C("bg", 2, { requires: ["enc"], alternative: "strategy", status: "accepted" }),
      C("direct", 3, { requires: ["enc"], alternative: "strategy" }),
      C("repair", 4, { requires: ["bg"] }),
    );
    const f = planFrontier(g, new Set(["enc", "bg"]));
    expect(f.map((c) => c.order)).toEqual([["repair"]]);
  });
});

describe("context", () => {
  it("finds stale citations and the blast radius of a new version", () => {
    const current = new Map([["req/cols", 2], ["dec/jobs", 1]]);
    expect(staleCitations([{ item: "req/cols", version: 1 }, { item: "dec/jobs", version: 1 }], current)).toEqual([{ item: "req/cols", version: 1 }]);
    const edges = [
      { from: "c1", kind: "contribution" as const, cite: { item: "req/cols", version: 1 } },
      { from: "c2", kind: "contribution" as const, cite: { item: "req/cols", version: 2 } },
      { from: "r1", kind: "review" as const, cite: { item: "req/cols", version: 1 } },
      { from: "c3", kind: "contribution" as const, cite: { item: "dec/jobs", version: 1 } },
    ];
    expect(blastRadius(edges, "req/cols", 2)).toEqual({ contributions: ["c1"], reviews: ["r1"], packs: [] });
  });
});

describe("review routing", () => {
  const subject = { authorKind: "agent" as const, authorFamily: "openai", paths: ["src/csv.ts"], citedItems: ["req/csv"] };
  const triage: ReviewFact = { reviewer: "triage", kind: "agent", family: "workers-ai", verdict: "comment", confidence: 1, triage: true };
  const a = (family: string, verdict: ReviewFact["verdict"], confidence = 0.9): ReviewFact => ({ reviewer: family, kind: "agent", family, verdict, confidence });
  it("starts with triage, then asks reviewers from families other than the author's", () => {
    expect(route(DEFAULT_POLICY, subject, []).state).toBe("needs-triage");
    expect(route(DEFAULT_POLICY, subject, [triage])).toEqual({ state: "needs-reviewers", count: 2, excludeFamilies: ["openai"] });
    expect(route(DEFAULT_POLICY, subject, [triage, a("openai", "approve"), a("anthropic", "approve")])).toEqual({
      state: "needs-reviewers", count: 1, excludeFamilies: ["openai", "anthropic"],
    });
  });
  it("settles agreement and escalates disagreement, blocks and low confidence", () => {
    expect(route(DEFAULT_POLICY, subject, [triage, a("anthropic", "approve"), a("deepseek", "approve")])).toEqual({ state: "approved", by: "agents" });
    const d = route(DEFAULT_POLICY, subject, [triage, a("anthropic", "approve"), a("deepseek", "block")]);
    expect(d.state).toBe("needs-human");
    expect(d.state === "needs-human" && d.reasons).toEqual(["Reviewers disagree", "A reviewer blocked it"]);
    expect(route(DEFAULT_POLICY, subject, [triage, a("anthropic", "approve", 0.5), a("deepseek", "approve")]).state).toBe("needs-human");
  });
  it("escalates protected files and lets a person's verdict settle it", () => {
    const s = { ...subject, paths: ["wrangler.jsonc"] };
    expect(route(DEFAULT_POLICY, s, [triage, a("anthropic", "approve"), a("deepseek", "approve")]).state).toBe("needs-human");
    const person: ReviewFact = { reviewer: "scott", kind: "person", family: "person", verdict: "block", confidence: 1 };
    expect(route(DEFAULT_POLICY, s, [triage, person])).toEqual({ state: "blocked", by: "people" });
  });
  it("reviews people's work the same way", () => {
    const mine = { ...subject, authorKind: "person" as const, authorFamily: "person" };
    expect(route(DEFAULT_POLICY, mine, [triage, a("openai", "changes"), a("anthropic", "changes")])).toEqual({ state: "changes", by: "agents" });
  });
});

describe("acceptance", () => {
  const head: Head = { version: 3, checkpointId: "cp3", commit: "c".repeat(40), contextDigest: "ctx", policyDigest: "pol" };
  const ok: CandidateFacts = {
    baseVersion: 3, contextDigest: "ctx", policyDigest: "pol", requiredChecks: ["a", "b"],
    checks: [{ id: "a", status: "PASS" }, { id: "b", status: "PASS" }], membersApproved: true, openConflicts: 0,
    staleCitations: 0, contextReviewRecorded: false, commit: "d".repeat(40), parentOk: true,
  };
  const req = { candidateId: "k", expectedVersion: 3, expectedContextDigest: "ctx", expectedPolicyDigest: "pol" };
  it("accepts only a current, checked, reviewed candidate", () => {
    expect(acceptError(head, req, ok)).toBeNull();
    expect(acceptError(head, { ...req, expectedVersion: 2 }, ok)).toBe("BASELINE_MOVED");
    expect(acceptError(head, { ...req, expectedContextDigest: "old" }, ok)).toBe("CONTEXT_MOVED");
    expect(acceptError(head, req, { ...ok, baseVersion: 2 })).toBe("STALE_CANDIDATE");
    expect(acceptError(head, req, { ...ok, checks: [{ id: "a", status: "PASS" }] })).toBe("CHECKS_NOT_PASSING");
    expect(acceptError(head, req, { ...ok, checks: [...ok.checks, { id: "b", status: "PASS" }] })).toBe("CHECKS_NOT_PASSING");
    expect(acceptError(head, req, { ...ok, membersApproved: false })).toBe("REVIEW_INCOMPLETE");
    expect(acceptError(head, req, { ...ok, staleCitations: 2 })).toBe("CONTEXT_REVIEW_REQUIRED");
    expect(acceptError(head, req, { ...ok, staleCitations: 2, contextReviewRecorded: true })).toBeNull();
  });
});
