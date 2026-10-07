# Nest v0.1 review

Reviewed 2026-10-07 against the uncommitted tree at `~/nest` (source snapshot `a0677e9f`). Citations name the file and symbol. Every claim marked **verified** was reproduced in this review; the rest are read from source.

## Verdicts on the six requested areas

| Area | Verdict | Evidence |
|---|---|---|
| Acceptance atomicity | **Sound** | `engine.ts` `accept` compares head id, head version, context digest and policy digest before `advance`. The Durable Object wraps load, dispatch and save in one `ctx.storage.transaction` (`coordinator.ts` `transition`). Local mode uses `BEGIN IMMEDIATE` (`service.ts` `mutate`). The cloud route verifies the frozen snapshot and reads the hash-checked R2 evidence *before* the CAS (`index.ts`, `action === "accept"`). No network call happens inside the transaction. |
| Incremental contribution correctness | **Local sound. Cloud wrong for same-file edits.** | Local: `runner/index.ts` `checkedDelta` requires a single parent equal to the declared base. `verifyAuthoringBase` rebuilds baseline plus every declared dependency and compares trees. `apply` uses real `git apply --3way`. Cloud: `delta.ts` `normalizedPatch` emits one hunk spanning the whole file. **Verified** (`docs/evidence/v01_cloud_patch_probe.ts`): two agents editing line 1 and line 5 of the same file compose to `PATCH_CONFLICT:src/a.ts` in the cloud path, while `git apply --3way` merges them cleanly. |
| Recovery | **Good in the cloud outbox, incomplete locally** | The outbox interruption test kills workerd after the external write and observes exactly one dispatch on restart. Locally, a crash during `LocalService.action` leaves `external_operations` at `IN_FLIGHT`. Replaying that operation returns `RECONCILIATION_REQUIRED`, and no reconcile action exists. |
| Fencing | **Sound and consistently applied** | The epoch increments on pause, resume and cancel. `publish` checks epoch, attempt id, model, provider and mode. The DO re-checks `taskAccess` every turn and on every budget reservation. `withGitCapability` mints a 300-second token and revokes it after each git operation. One caveat: local `pause` invents its own boundary (`op + "-read"`) instead of using the agent's last real tool boundary. The cloud path uses the recorded `last_boundary`. |
| Budget enforcement | **Correct and conservative, but heavy** | Integer micro-USD admission runs inside `transactionSync` (`coordinator.ts` `reserveCall`), cumulative across approval IDs. Input bytes are counted as tokens, an overrun blocks all further spend, and the smoke stage is capped separately. Actual usage is never credited back, so the remaining budget only shrinks by estimates. About 2,500 lines across `control`, `stages`, `live-evidence`, `live-verification`, `outbox` and `events` gate spend, against a roughly 1,000-line domain engine. |
| Does the live plan prove the claims? | **It proves the plumbing, not the product** | Running `smoke:cloud` and `demo:live` would show Workers, Artifacts fork/push/events, Container checks and two provider tool loops. That satisfies the competition rule. It would not show what judges score (next section). |

## What the live run would not prove

1. **Coordination.** The live task prompt dictates the decomposition: "Publish A1 (CSV encoder) separately from A2 (direct strategy); B1 background strategy depends on A1…" (`task-workflow.ts`, `instruction`). Models following a script show parallel execution, not agents coordinating.
2. **Generality.** The engine is the Harbor scenario. `currentRefs` hard-codes four context item IDs. `policyVersion` is the literal type `"v1" | "v2"`. `pause` writes `rejectedAlternatives: [{ id: "A2", … }]`. `accept` writes a fixed decision sentence. `service.ts` `seed` hard-codes tasks T1–T3. The runner path allowlist and trusted harness only accept Harbor's file shapes.
3. **Scale.** The limits are 3 concurrent agents and 6 tasks per objective. Cloud trees are capped at 64 files and 1 MB in total (`artifacts.ts` `readFiles`, `git.ts` `snapshot`). The challenge headline is hundreds of thousands of agents.
4. **Conflict handling.** The demo never has two contributions edit the same file, and the cloud composer would fail if it did (see above).
5. **Review by both sides.** One human reviews. No agent reviews exist, and review is not a recorded object.
6. **Honest observation.** Local `publishDraft` sets `observedContextReads` from the declared references (`repairDepth === 1 ? refs.filter(...) : refs`) rather than from recorded reads.

## Findings outside the requested areas

- **The state is one JSON row.** Both stores keep the whole `NestState` in a single row and rewrite it on every mutation. **Verified:** after one complete fixture run (5 contributions, 4 candidates, a 17-file app) the row is **354 KB**. 55% of that is the idempotency cache (`operations` stores full results), and another 43 KB is `candidates[].files` holding whole file contents. Cloudflare's Artifacts launch post gives a 2 MB maximum Durable Object row size. A few more objectives, or one realistic repository, breaks the cloud authority.
- **The models are stale.** The manifest proposes `gpt-4.1-2025-04-14` and `claude-sonnet-4-6`, two generations behind current models.
- **The environment is more ready than the docs say.** `BLOCKERS.md` and the live report describe Wrangler as unauthenticated. On 2026-10-07, `npx wrangler@4.148.0` was logged in and `wrangler artifacts namespaces list` succeeded (no namespaces yet). The global `wrangler` is 4.90.0, which predates the `artifacts` command and the 4.145 binding types.
- **Nothing is published yet.** The repository has no commits, the LICENSE holder is a placeholder, and no public repository exists. Submission requires all three.
- **The fit to the judging criteria is weak.**
  - Originality (50%): the concept is strong, but the interface is forms and checkboxes.
  - Concurrency and coordination (25%): 3 scripted agents.
  - Ease of use (25%): the README and interface lead with caveats rather than the product.
- **Maintainability.** The UI is one 1,473-line `App.tsx`. The source uses lines up to 1,846 characters long.

## What to carry into v1

| Keep | Source |
|---|---|
| Canonical hashing, `seal` and `verifyDigest` | `packages/protocol` |
| Dependency closure with cycle and alternative detection | `engine.ts` `closure` |
| CAS acceptance against head, context and policy | `engine.ts` `accept`, `coordinator.ts` `transition` |
| Epoch fencing and per-operation token revocation | `engine.ts` `fence`, `artifacts.ts` `withGitCapability` |
| Authoring-base verification and real three-way application | `runner/index.ts` `verifyAuthoringBase`, `apply` |
| Trusted checks with egress disabled and structured results | `packages/test-policy`, `runner.validate`, `sandbox.ts` |
| Outbox with a frozen intent and an alarm committed with the head | `outbox.ts` |
| Artifacts fork, verification and initial-token revocation | `artifacts.ts` |

Leave behind: the single-row state, Harbor-specific engine code, whole-file cloud patches, the scripted prompt, and the multi-stage approval machinery. Spend control moves to AI Gateway limits plus one reservation counter.
