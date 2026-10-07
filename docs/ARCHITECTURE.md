# Nest v1 architecture

Status: design for the Cloudflare "Build the next GitHub" entry (deadline 2026-10-14, 23:59 PDT). Artifacts capabilities and limits come from its full documentation, read on 2026-10-07. Other services (Agents SDK, AI Search, Vectorize, Browser Rendering, Workers for Platforms) are cited from general knowledge: verify each binding on the day it is wired. Throughput numbers are design targets until measured.

## 1. Thesis

Git and GitHub assume a few careful humans: branch, pull request, review, merge. With thousands of agents and a handful of people, that model breaks in three places.

| Where it breaks | What Nest does instead |
|---|---|
| **The branch is the unit of decision.** Rejecting a PR throws away the good pieces inside it. | The unit is the **contribution**: one immutable commit with declared dependencies, alternatives and cited context. Outcomes are **assembled** from contributions across agents and approaches, then tested as a whole. |
| **Review doesn't scale, and it only runs one way.** People can't read 10,000 PRs, and agent review is unrecorded and untrusted. | **Review is a contribution too.** Agents review every push within seconds. People review where it matters, and agents review people's work as well. Every review is immutable, cites evidence, and builds the reviewer's track record. |
| **Context evaporates.** Each agent starts cold, and the reason an approach was rejected is lost in a chat log. | **Context is versioned like code.** Requirements, decisions, rejected approaches and findings live in a context repo and every contribution cites the versions it relied on. Changing a requirement shows its **blast radius** and re-queues the affected work. The 10,000th agent knows what the first 9,999 learned. |

Two ideas carry over from v0.1. **Conflicts become work**: a failed merge or check opens a scoped repair task. **Agents are replaceable**: a task survives a change of model through a portable, fenced checkpoint.

### Lineage and positioning

Contributions that carry dependencies and compose follow Darcs and Pijul patch theory. First-class conflicts echo Jujutsu. Testing the assembled result before acceptance is the merge-queue rule ("not rocket science", Bors). Current agent-VCS efforts (Oak's branch per session, Freestyle Git's API-first repos, GitHub clones on Artifacts) keep **one branch per agent, merge what survives**. Nest's distinct bets:

1. sub-branch contributions composed across approaches;
2. review as a symmetric, recorded object with routing;
3. versioned context with citations and blast radius;
4. a computed frontier of candidate outcomes, each tested and previewable.

## 2. Vocabulary

| Object | Meaning |
|---|---|
| Participant | A person or an agent. Agents carry provider and model. Both have a track record. |
| Objective | An outcome with completion criteria. It holds tasks, contributions, reviews and candidates. |
| Task | A bounded assignment that survives changes of participant. Attempts are fenced by epoch. |
| Contribution | One commit plus a manifest: authoring base, dependencies, alternative group, cited context, assumptions and provenance. Immutable. |
| Review | A verdict (approve, request changes, block, comment) on a contribution, candidate or context change. Findings cite lines and context. Immutable. |
| Candidate | A dependency-closed selection of contributions against one checkpoint, context and policy, materialized by real git and checked as a whole. Each candidate has a preview URL. |
| Conflict | A recorded incompatibility (merge, check, stale context or reviewer disagreement). It becomes a repair task. |
| Context item | A requirement, decision, rejected approach, finding, policy or evidence item, versioned in the context repo, with owner and status. |
| Checkpoint | An accepted code tree plus a context manifest, decisions and an acceptance receipt. The project head is advanced by compare-and-swap. |

## 3. Agents need no new protocol: the commit message is the API

Agents already know git, so publishing is `git push`. Nest reads commit trailers:

```text
Add RFC 4180 CSV encoder

Nest-Task: t_7f3a
Nest-Attempt: t_7f3a/e2
Nest-Requires: c_19ab
Nest-Alternative: export-strategy
Nest-Cites: req/export-policy@v2#L3-7, dec/0004-background-jobs
Nest-Assumes: rows are filtered to the viewer before encoding
```

- **One commit is one contribution.** Its parent must be the materialization of its declared dependencies; ingest verifies this. Pushing several commits publishes several contributions.
- **Provenance** (model, context pack id, prompt digest) goes in `refs/notes/nest/provenance`. **Reviews** go in `refs/notes/nest/reviews`. Artifacts supports git notes natively, so a plain `git clone` carries the history of who decided what and why.
- Agents that prefer tools use the **Nest MCP server**: `claim_task`, `context_pack`, `search_context`, `publish`, `review`, `report_conflict`, `checkpoint`, `heartbeat`. Claude Code, Codex, Cursor, or any agent that speaks git or MCP can join an objective. This is how participation scales without Nest hosting every agent.

## 4. Review in both directions, as needed

Every review is a stored object (R2 body, Objective DO index, git note on the target commit). Routing is itself a versioned context item (`policy/review-routing.md`), so changing it is reviewable.

Default routing:

1. **Every contribution** gets a fast triage pass (Workers AI). Unless it is trivial, it then gets **two independent agent reviewers from different model families** through AI Gateway.
2. **A person is asked** when:
   - the reviewers disagree;
   - any review blocks;
   - the change touches a protected area or a human-owned requirement;
   - reviewer confidence falls below the threshold;
   - a candidate is proposed for acceptance.
3. **People's work gets the same treatment.** A human contribution or context change receives agent review against requirements and evidence. Nobody is exempt.
4. **Overrides are recorded.** A person can override an agent review with a rationale. The override is itself reviewable and feeds both track records.
5. **Track record is a tally, not a model**: approvals later contradicted by failing checks or reverts, and blocks that were confirmed. It is shown on every review and used to weight routing per capability.

The person's inbox therefore contains only the decisions that need a person, each with the agent reviews, evidence and cited context already attached.

## 5. Context fabric: massive context, cited

| Layer | Service | Contents |
|---|---|---|
| Context repo | Artifacts (`nest-base/<space>-context`) | Requirements, decisions, rejected approaches, findings and policies as Markdown. A git commit plus path is the version. |
| Originals | R2 | Specifications, transcripts, logs and large documents, content-addressed. |
| Retrieval | AI Search over R2, Vectorize with Workers AI embeddings, D1 FTS5 | Semantic and exact lookup. Every hit returns a citation (`item@version#lines`). |
| Code map | Workers AI summaries, stored in R2 | Per-file and per-directory summaries of each checkpoint. They let an agent navigate a large repo before reading it. |
| Large repos | ArtifactFS in Sandbox | Mounting without a full clone. Agents work on real repositories, not 64-file fixtures. |
| Citation graph | D1 `citations` table | Contribution, review or pack mapped to the context item version it used. This is the reverse index behind blast radius. |

**Pack compiler.** Each task gets an immutable context pack sized to the model's window (up to 1M tokens for long-context models). It contains:

- the objective and its criteria;
- every accepted requirement in scope;
- relevant decisions;
- rejected approaches for the same capability, with their reasons;
- open conflicts;
- reviews of neighbouring work;
- retrieved evidence;
- the code map.

The pack manifest records what was included and its measured size. Retrieval is ranked, not exhaustive, and the pack says so.

**Context compounds automatically.** When a person chooses between alternatives, Nest writes a `rejected/` item with the reviewer's reason. Review findings that hold up become `finding/` items. Every later pack carries them.

**Blast radius.** Accepting a new version of an item runs one query over `citations`. It returns every contribution, review, candidate and running task that relied on the old version:

- candidates become outdated relative to the new context;
- running agents receive a context-changed event at their next tool boundary;
- candidates that now fail their checks open repair tasks.

## 6. Cloudflare services and their jobs

| Job | Service |
|---|---|
| API, auth, routing, UI assets | Workers, Workers Static Assets, Access for people |
| Code, context and per-task workspaces | **Artifacts**: a checkpoint repo per project, a fork per task attempt, a candidate repo, a context repo, git notes |
| Atomic project head | Durable Object `Project` (SQLite: head, checkpoints, receipts; CAS acceptance) |
| Objective coordination and live updates | Durable Object `Objective` (SQLite tables: tasks, attempts, contributions, reviews, candidates, conflicts, events; hibernatable WebSockets) |
| Push to registration | Artifacts event subscription (namespace-wide `repo.pushed`), then **Queues**, then the ingest Worker |
| Agent runtime | Agents SDK (one agent per session), **Workflows** for durable task attempts, Sandbox for real git and execution |
| External agents | Remote MCP server on Workers |
| Composition and checks | **Sandbox / Containers**: ordered `git cherry-pick` onto the checkpoint (a three-way merge against each contribution's own parent); trusted checks with egress off; `@cloudflare/ci` runners with cached dependencies |
| Live preview for every candidate | The demo app (Harbor) is rebuilt as a small Worker app (static assets, API, a Durable Object for export jobs). Each candidate is pushed as a branch, and the Workers Builds Artifacts integration deploys it as a Worker Preview. Fallback: a preview Worker that serves the candidate's static files straight from `repo.readFile`, with the API stubbed |
| Visual evidence for reviewers | Browser Rendering screenshots of each preview |
| Models | **AI Gateway** (frontier models from two families, spend and rate limits, logging off), Workers AI (triage, embeddings, code-map summaries) |
| Context | R2, AI Search, Vectorize, D1 |
| Metrics | Analytics Engine (contributions/s, review latency, merge outcomes), Artifacts GraphQL metrics |

## 7. Data flow

```text
claim_task ─► Objective DO: lease + epoch e ─► Worker: fork checkpoint into nest-ws-XX/t-<task>-e<e>
                                              mint write token (TTL ≤ 1h), compile context pack
agent: edit → commit with trailers → git push
Artifacts repo.pushed ─► Queue ─► ingest Worker
   ├─ fencing: Nest-Attempt epoch must be current (otherwise reject and record)
   ├─ verify: single parent == cached materialization tree of (checkpoint + declared deps)
   ├─ manifest → R2 (content-addressed); register in Objective DO (id = sha256(repo, commit))
   ├─ citations → D1
   └─ enqueue reviews (Queue) and composition (Workflow)
reviewers (agents and people) ─► Review objects ─► routing decides who else is asked
composer Workflow ─► choose frontier selections ─► Sandbox: cherry-pick sequence → checks → preview
person accepts ─► Project DO: CAS(head version, context digest, policy digest) ─► outbox: export, notes
```

## 8. Correctness rules (ported from v0.1, tightened)

- **State is relational.** Every authority keeps SQLite tables, not one JSON row. The idempotency table stores the operation fingerprint and a result digest; result bodies live in R2. File contents never live in coordinator state.
- **Acceptance** is a short storage-only transaction in the Project DO. Evidence and the candidate tree are verified durable first. A moved head returns `BASELINE_MOVED`, and the candidate must be recomposed.
- **Fencing happens at the data plane.** Pausing or cancelling increments the epoch and revokes the attempt's write token. Ingest also rejects commits whose `Nest-Attempt` is stale, so a late push from a dead agent cannot register.
- **One merge engine.** Composition runs real git in the same container image locally (Docker) and in the cloud (Sandbox). The v0.1 divergence, whole-file cloud patches against three-way local merges, cannot recur.
- **Determinism.** Same base, ordered selection, context digest, policy and toolchain give the same candidate digest. The tree is checked for equality on re-materialization.
- **Staleness is a relation.** A contribution is stale relative to a target context. Nothing is rewritten to pretend agents saw a requirement they didn't.
- **Spend** is capped by AI Gateway limits plus one reservation counter in the Objective DO. An uncertain outcome stays reserved, and an overrun stops dispatch.

## 9. Scale design

| Pressure | Limit (Cloudflare docs) | Design |
|---|---|---|
| Git traffic per repository | 2,000 requests / 10 s per repo | One repo per task attempt, so no shared hot repo exists |
| Control plane (fork, token) | 2,000 requests / 10 s per namespace | Shard workspaces across 64 namespaces (`nest-ws-00…3f`): about 12,800 requests/s |
| Event fan-in | Queues with batching | The ingest Worker scales horizontally; registration is idempotent |
| Coordination | One DO per objective | Large objectives split into capability sub-objectives. Target: about 300 registrations/s per Objective DO, to be measured |
| Storage | 1 GB per repo, 1 TB per account (raisable) | Workspaces are deleted after their contributions are frozen into the candidate repo; R2 holds manifests and evidence |

Worked target: 100,000 agents each pushing every 5 minutes is about 333 pushes/s. That is about 1,000 control-plane reads/s, under 8% of the sharded ceiling. The demo includes a **measured burst** of labelled synthetic contributors pushing to real Artifacts repos. It runs before 2026-10-14, when Artifacts billing starts; 10,000 operations per month are included.

## 10. The video decides the scope

Every item must appear in the 5–10 minute recording, live on Cloudflare:

1. Three or more real agents from two model families in their own Artifacts forks, pushing contributions they decomposed themselves.
2. Push events landing in the live work map.
3. Agent reviews on every contribution; a disagreement escalated to a person; a person's own change reviewed by an agent.
4. Candidates composed by real git in Sandbox, checked, and opened as live previews. One candidate keeps a piece from a rejected approach.
5. A requirement change lighting up its blast radius, spawning a repair, and handing the task to a different model.
6. Acceptance by CAS, then a new agent whose context pack contains the rejected approach and why.
7. The measured burst, with honest labels.

## 11. Build plan (2026-10-08 to 2026-10-14)

| Day | Deliverable | Gate |
|---|---|---|
| Oct 8 | Repo skeleton. Port hashing, closure, CAS and fencing. Project and Objective DOs on SQLite tables. Ingest Worker. Deploy. | A real Artifacts fork, a push with trailers, the event, and a registered contribution, observed in the cloud |
| Oct 9 | Harbor rebuilt as a Worker app. Composer: Sandbox image with git, cherry-pick composition, trusted checks, Worker Preview per candidate | A candidate tree, checks and a live preview for two contributions that edit the same file |
| Oct 10 | Agent runtime (Agents SDK + Workflows + AI Gateway, two families), MCP server, context repo, pack compiler (D1 FTS + Vectorize; AI Search if it slots in) | Three agents decompose and push without a scripted plan |
| Oct 11 | Review objects, routing policy, symmetric review, blast radius, repair tasks, pause and resume across models | Requirement change → stale → repair → re-review → ready |
| Oct 12 | UI: work map, frontier with previews, inbox, context view, live WebSocket | The full journey in a browser |
| Oct 13 | Scale burst and metrics. Three full rehearsals. Record. | Best honest run recorded |
| Oct 14 | README, LICENSE (MIT, Scott Hughes), public repo under `scottdhughes`, submission | Submitted |

The plan is aggressive: nothing has made a cloud round trip yet. The Oct 8 gate is the schedule's truth test. If it slips past Oct 9, start cutting immediately.

Cut order if a day slips: Browser Rendering screenshots, then AI Search (keep FTS + Vectorize), then Workers Builds previews (keep the `readFile` preview Worker), then burst size. Never cut: real agents, real git composition, review in both directions, blast radius, CAS.

## 12. Owner decisions before Oct 8 work starts

- Confirm the Cloudflare account is on **Workers Paid**. Artifacts requires it. Check in the dashboard under Workers → Plans.
- Approve deployment to that account and a model-spend ceiling for rehearsals.
