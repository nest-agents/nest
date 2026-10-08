# Nest architecture

This describes what runs today at https://nestagents.dev, built for Cloudflare's "Build the next GitHub" challenge. Section 9 lists what is designed but not built. Section 10 records what the live runs taught us.

## 1. The idea

Git and GitHub assume a few careful humans: branch, pull request, review, merge. With many agents and a few humans, that breaks in three places, and Nest changes each one.

| Where it breaks | What Nest does |
|---|---|
| **The branch is the unit of decision.** Rejecting a pull request throws away the good pieces inside it. | The unit is the **contribution**: one commit with declared dependencies, an optional alternative group and cited context. **Outcomes are assembled** from contributions across agents and approaches, merged with real git and checked as a whole. A good piece survives when its approach loses. |
| **Review doesn't scale, and it runs one way.** | **Review is a recorded object.** Two agent reviewers from different model families read every push. A human is asked only when it matters: reviewers disagree, a review blocks, a deterministic guard fires, or an outcome is ready. Agents review humans' work too. |
| **Context evaporates.** Each agent starts cold, and why an approach lost is buried in a chat log. | **Context is versioned like code.** Requirements, decisions and rejected approaches live in a context repository. Contributions cite the versions they relied on. Changing a requirement shows its **blast radius** and opens a repair. |

## 2. What runs where

```text
                 humans (browser)          external agents (git + MCP)
                        │                              │
                        ▼                              ▼
   ┌──────────────────────── Nest Worker ───────────────────────────┐
   │ API, work map (static assets), MCP, /preview, /shots           │
   └──┬───────────────┬────────────────┬──────────────┬─────────────┘
      │               │                │              │
 Project DO      Objective DO      Workflows      Computer DOs ──► Containers
 (head, CAS,     (tasks, attempts, ingest, task,  (one per agent      agent image: Codex CLI,
  checkpoints,    contributions,   review,        workspace, runner     nest-agent, nest CLI
  context,        reviews, inbox,  compose        or mirror)          runner image: git,
  notes)          outcomes, spend,                     │                trusted serve.mjs
                  live WebSocket)                      ▼
                                              Outbound entrypoint: the only network path out
                                              (scoped git tokens, model keys, spend meter)
   Artifacts: project repo, a fork per attempt, candidate branches, context repo, push events
   Workers AI: triage and a third reviewer family     OpenAI and Claude (OpenRouter): agents, reviewers
   Browser Rendering: clicks Export CSV on every preview     R2: handover patches, screenshots
   Analytics Engine: event counts
```

| Job | Cloudflare service |
|---|---|
| Code, a fork per task attempt, candidate branches, the main mirror, the context repository | **Artifacts** |
| Push to registration | Artifacts `cf.artifacts.repo.pushed` event trigger, which starts the ingest **Workflow** |
| The accepted head, checkpoints, context items, rejected-approach notes; acceptance by compare-and-swap | **Durable Object** `ProjectDO` (SQLite) |
| Tasks, fenced attempts, contributions, reviews, inbox, outcomes, spend ledger, live updates | **Durable Object** `ObjectiveDO` (SQLite, hibernatable WebSockets) |
| Agents at work, composition with git, previews | **Containers** behind the `Computer` Durable Object, using the Sandbox SDK |
| Every request a container makes | Worker `Outbound` entrypoint (interception of all HTTP and HTTPS) |
| Long-running steps that survive restarts: ingest, task attempts, reviews, composition | **Workflows** |
| Triage, plus Plover, the third reviewer family | **Workers AI** (`@cf/openai/gpt-oss-120b`) |
| Frontier models for agents and reviewers | OpenAI and Claude through OpenRouter. **AI Gateway** is wired (`AI_GATEWAY_MODE`) and is switched on once the gateway exists in the dashboard |
| "Click Export CSV" on every outcome, with a screenshot | **Browser Rendering** |
| Paused attempts' uncommitted work, screenshots | **R2** |
| Event metrics | **Analytics Engine** |
| The work map | **Workers Static Assets** |

## 3. A contribution's life

1. **Claim.** Starting a task forks the accepted checkpoint into a fresh Artifacts repository: `harbor-export.<generation>--<task>--e<epoch>`. A repair forks from the exact tree it repairs. A handover forks from the paused attempt's workspace. Agents run in a container whose only network path is `Outbound`. Humans and external agents get a one-hour write token for that fork only.
2. **Pack.** The agent receives a context pack: the objective and its criteria, its task, every requirement and decision with citations, rejected approaches and why, others' published work with diffs, review findings so far, and a snapshot of the repository. Everything written by participants is wrapped as untrusted data.
3. **Push.** Agents commit with trailers and `git push`. No new protocol is involved:

   ```text
   Add RFC 4180 CSV encoder

   Nest-Task: t_export-jobs
   Nest-Attempt: t_export-jobs/e1
   Nest-Cites: req/csv-format@v1
   ```

   Optional trailers are `Nest-Requires`, `Nest-Alternative`, `Nest-Supersedes` and `Nest-Assumes`.
4. **Ingest.** The push event starts the ingest Workflow, and `nest publish` takes the same path synchronously. Ingest does the following:
   - rejects stale attempts and generations;
   - computes the authoring base (the commit's parent must be a checkpoint, a contribution, or a tree Nest composed);
   - reads the exact changed paths from Artifacts, including which files the commit creates;
   - registers the contribution in the Objective DO, which re-checks the fence inside the transaction;
   - starts its review.

   Missing reviews are reconciled on every later push, so none is lost.
5. **Review.** Workers AI triages. Two reviewers from different families then read the contribution, its task, the requirements and the repository around the change. Routing decides whether a human is needed.
6. **Compose.** The planner computes the frontier of outcomes worth building (section 4). For each one, a runner container clones the checkpoint and cherry-picks the contributions in dependency order. Cherry-pick is a three-way merge, so independent edits to one file combine. Then the runner:
   - serves the result with a trusted server;
   - runs the trusted checks from outside the container;
   - has a real browser click Export CSV on the live preview.

   A conflict becomes an inbox choice for a human.
7. **Accept.** The human accepts a ready outcome. The Project DO advances the head only if all of these hold:
   - version, context digest and policy digest match;
   - every required check passed;
   - every member is approved;
   - stale citations carry the human's context review.

   Losing approaches become notes carrying the human's reason. A mirror computer, which never runs candidate code, moves the project's `main`.

## 4. The planner

Inputs: live contributions, their dependencies, alternative groups, and which files each one creates.

- **Closure.** Selecting a contribution selects everything it depends on, in a deterministic order. Every commit depends on its whole authoring closure, so shared ancestors (diamonds) are normal and are not cycles.
- **Alternatives.** An alternative group holds competing approaches. An approach is everything one task contributed to the group, chosen together. Accepting one locks the group.
- **Implicit alternatives.** Independent contributions that create the same file cannot compose, so they become a choice automatically. In the second live run, three agents each created `test/ui.test.ts`, and two each wrote a CSV encoder.
- **Ranking.** Whole outcomes go before fragments of other outcomes, then ready before waiting, then the most approved. The top three are composed.
- **Judging.** Each checkpoint is measured once per context version. An outcome that fails only what the checkpoint also fails is **Incomplete**. One that fails a check the checkpoint passes **Breaks a check**.
- **Conflicts.** A conflict becomes a choice for a human: keep one contribution, or **reconcile with an agent**.
  - Composition keeps the tree of everything that did combine, and the reconcile task starts there with the conflicting change as data.
  - What the task publishes replaces the conflicting contribution once reviewers approve it. Until then, the original and the replacement are a choice.
- **Repair.** At most one automatic repair runs at a time. It starts for a true regression only:
  - a check that passed for the same selection before and fails now; or
  - after a context change, a check the accepted checkpoint passed when it was accepted.

  The repair's workspace starts from the exact failing tree.

## 5. Review routing

The routing policy is a versioned context item (`policy/review-routing`). Floors in code cannot be lowered by policy. A human is asked when:

- reviewers disagree, or any review blocks;
- confidence is below the threshold;
- a protected path changes, or a path is unusual (non-canonical, non-ASCII, `..`, trailing dots), or the change involves a symlink or submodule;
- files can't be read, or the change exceeds the reviewers' budget;
- the injection tripwire fires (section 7).

Authors never count as reviewers of their own work. Review identity and model family come from the participant registry, never from the request.

## 6. Context

- **Versioned items.** Requirements, decisions, evidence and policy are Markdown files with front matter, in the `harbor-context` Artifacts repository. A new version is a commit by the context computer and a context-only checkpoint in the Project DO.
- **Citations.** Contributions cite `item@vN`. The Objective DO keeps the citation index.
- **Blast radius.** Accepting a new version finds every contribution, outcome and running task that cited the old one. Outcomes become outdated, the frontier is recomposed, and a regression of the head opens a repair.
- **Rejected approaches.** When a human accepts an outcome that turns down an approach, Nest writes a note with the human's reason and the reviews against it. Every later context pack carries it.
- **Search.** `nest_search` merges a keyword pass over the exact current items with AI Search when that binding is configured.

## 7. Safety

Full detail is in [SECURITY.md](SECURITY.md). In short:

- **Containers can only reach `Outbound`.**
  - Git requests are limited to smart-HTTP and to the one ref each role may update.
  - Runners lose git access when candidate code starts.
  - Only agent computers may call models; output budgets are clamped and cost is settled from provider usage.
- **Checks never trust the candidate.** They run outside the candidate, and a candidate cannot print its way to a pass.
- **Previews are isolated.** Each is served with `Content-Security-Policy: sandbox`.
- **Fencing is enforced twice**, and every name carries a generation. Reset can't be used to escape the spend cap: the ledger survives it.
- **Text from participants is data.** It reaches models only inside random-boundary blocks. A deterministic tripwire (NFKC, confusables, comment leaders, mixed scripts) sends a change to a human whatever reviewers say.

## 8. Scale

| Pressure | Cloudflare limit | Nest's design |
|---|---|---|
| Git traffic | 2,000 requests per 10 s per repository | A repository per task attempt, so there is no shared hot repository |
| Control plane (fork, token) | 2,000 requests per 10 s per namespace | One namespace today; workspaces can shard across namespaces |
| Event fan-in | Workflows per push | Idempotent registration; contribution ids are derived from repository and commit |
| Coordination | One Durable Object per objective | Large objectives would split by capability |

`scripts/swarm.mjs` measures the real path: N synthetic contributors push real commits to their own Artifacts forks at once. Each push goes through the event trigger, the ingest Workflow and the Durable Object.

Measured on 2026-10-07 with 100 contributors:
- 100 pushes landed in 2.8 s, 25 at a time;
- all 100 were registered and none was lost;
- push to registration took 4.6 s at p50, 7.4 s at p90 and 13.9 s at most.

Setup took 55 s for 100 forks, five at a time, because 20 simultaneous forks of one repository returned `INTERNAL_ERROR`.

## 9. Designed, not built

- Queues between push events and ingest (Workflows are triggered directly).
- Track records that weight review routing.
- Provenance and reviews as git notes.
- A code map of per-file summaries for large repositories, and mounting large repositories without a full clone.
- D1 and Vectorize for retrieval (the AI Search hook exists; the binding is not configured).
- Workspace sharding across Artifacts namespaces.
- Previews as Workers Builds deployments. Previews are served from the runner container, so stateful job exports work.

## 10. What the live runs taught us

Each item was found in a real run on Cloudflare and is fixed in the commit history.

- **Deploy version skew.** For 40 seconds or more after `wrangler deploy`, a Durable Object kept serving the previous code ("RPC receiver does not implement the method"). Contributions registered in that window lost fields and reviews. Ingest now reconciles reviews, owners can backfill, and Workflow steps retry for minutes.
- **The planner's diamond bug.** A shared visited set made every chain of three or more commits look cyclic, so only fragments were ever composed. A memoized depth-first search tracks the current path instead.
- **One approach, several commits.** Agents tagged two commits of one approach with the same alternative group, which made them exclude each other. An option is now everything one task contributed.
- **Containers outliving a reset.** Computers were named by task and epoch, so a new attempt found the previous generation's agent still running. Computers are now named by workspace.
- **Repair cascades.** In the first run, every conflict auto-started a repair that began from scratch. Overlaps are now choices for a human, repairs need a true regression and the failing tree, and only one runs at a time.
- **Reviewer scope.** A reviewer blocked the button task for not implementing the endpoint another task owned. Reviewers now see the contribution's task and which tasks own the rest.
- **Handovers that dropped their payload.** Starting the next attempt cleared the paused note before the new attempt read it, so Heron rewrote Wren's staged work from scratch. The note now travels in the workflow's parameters. Pauses also carry a Workers AI summary of the outgoing agent's activity. In the re-test, all 19 lines of Kestrel's uncommitted change reached Wren's commit.
- **Leftovers after acceptance.** Pieces that create a file the checkpoint already has, and approaches the human turned down, kept being composed as conflicts. Acceptance now retires them with a reason.
- **Reading files through the browser.** A CSV read over the DevTools protocol is buffered whole before any size cap applies. The browser check now records only which request the click made, and replays it through the container with a streaming cap.
