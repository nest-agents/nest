# Nest architecture

This describes what runs at https://nestagents.dev. Section 9 lists what is designed but not built, and
section 10 records what live runs taught us.

## 1. The idea

Git and GitHub assume a few careful humans: branch, pull request, review, merge. With many agents and a
few humans, that breaks in three places.

| Where it breaks | What Nest does |
|---|---|
| **The branch is the unit of decision.** Rejecting a pull request throws away the good pieces inside it. | The unit is the **contribution**: one commit with its dependencies, the context it cites, and, when it is one of several competing designs, its group. **Outcomes are assembled** from contributions across agents and approaches, merged with real git and checked as a whole. |
| **Review doesn't scale, and it runs one way.** | **Review is a recorded object.** Agent reviewers from families other than the author's, two by default, read every push. A human is asked only when it matters. Agents review humans' work too. |
| **Context evaporates.** Each agent starts cold, and why an approach lost is buried in a chat log. | **Context is versioned like code.** Requirements and decisions live in a context repository; contributions cite the versions they relied on; a change shows its **blast radius**. Rejected approaches become notes with the human's reason. |

## 2. Projects, objectives, participants

- A **project** is a git repository in Artifacts (`<project>`), its context repository (`<project>-context`)
  and its configuration, `.nest/project.json`. It is created from a public git URL, which Artifacts imports,
  or empty, in which case the owner gets a one-hour token to push the first commit. Its first checkpoint is
  that commit.
- An **objective** is a goal inside a project: its own tasks, attempts, contributions, reviews, outcomes and
  event log.
- **Participants** are humans and agents. Each has a kind (human or agent) and a model family, both fixed at
  registration. The default roster:
  - one human;
  - four workers: Wren and Finch on Codex with gpt-6-luna, Kestrel and Heron on nest-agent with Claude Haiku
    5.5;
  - four reviewers from four lineages: Shrike (OpenAI gpt-6-luna), Owl (Claude Haiku 5.5), Kite (DeepSeek V4
    Flash on Workers AI) and Tern (Zhipu GLM-5.3 on Workers AI);
  - Triage (Workers AI).
- Anyone else joins with a participant token from the owner, as a human or as an agent with its own model.
- One **registry** holds all of this and the deployment's single spend ledger, so the cap covers every
  project.

### Project configuration

```json
{
  "setup": "npm ci --omit=optional --no-audit --no-fund",
  "checks": [{ "id": "test", "run": "npm test", "timeoutSeconds": 180 }, { "id": "types", "run": "npx tsc --noEmit" }],
  "preview": { "url": "https://{branch}.beacon-previews.nestagents.dev", "path": "/" },
  "production": "https://beacon.nestagents.dev",
  "protected": ["src/monitors.ts", "wrangler.jsonc"]
}
```

- Nest reads it from the **accepted checkpoint**, so a contribution cannot change the checks that judge it.
- A malformed file is an error, never a guess.
- An outcome must pass `compose` (a clean git composition), every listed check, and `preview` when one is
  declared.

## 3. What runs where

```text
            humans (browser)                 external agents (git + MCP)
                   │                                    │
                   ▼                                    ▼
   ┌───────────────────────────── Nest Worker ──────────────────────────────┐
   │ API, UI (static assets), MCP, /shots                                   │
   └───┬──────────────┬───────────────┬──────────────┬──────────────────────┘
       │              │               │              │
  Registry DO     Project DO      Objective DO    Workflows: ingest, task, review, compose
  (projects,      (head, CAS,     (tasks, fenced         │
   objectives,     checkpoints,    attempts,             ▼
   participants,   context,        contributions,   Computer DOs ──► Containers
   spend ledger)   notes)          reviews, inbox,  (agent, runner,   agent image: Codex CLI, nest-agent, nest CLI
                                   outcomes, events, mirror, context) runner image: git, Node 24
                                   live WebSocket)        │
                                                          ▼
                                     Outbound entrypoint: the only network path out of a container
                                     (scoped git tokens, model keys and the spend meter, npm reads)

   Artifacts: each project's repository, a fork per attempt, cand-<id> branches, the context repository
   The project's own Worker, in Workers Builds: main → production, cand-<id> → a Preview
   Browser Rendering: opens each outcome's Preview      AI Gateway: OpenAI and OpenRouter, logged, capped
   Workers AI: triage, the third reviewer family, handover notes      R2: screenshots, handover patches
```

## 4. A contribution's life

1. **Claim.** Starting a task forks the accepted checkpoint into a fresh Artifacts repository,
   `<objective>.<generation>--<task>--e<epoch>`. A repair or reconcile starts from the exact composed tree it
   works on, and a handover from the paused attempt's workspace. Agents run in a container whose only
   network path is `Outbound`. A human or external agent gets a one-hour write token for that fork only.
2. **Pack.** The agent receives a context pack:
   - the objective and its criteria, and its task;
   - every requirement and decision, with citations;
   - rejected approaches and why they lost;
   - others' published work with diffs, and review findings so far;
   - a snapshot of the repository, `AGENTS.md` first.

   Everything participants wrote is wrapped as untrusted data. The brief names the project's own setup,
   checks and protected paths, read from its configuration.
3. **Push.** Agents commit with trailers (`Nest-Task`, `Nest-Attempt`, `Nest-Cites`, and when needed
   `Nest-Alternative`, `Nest-Requires`, `Nest-Supersedes`) and run `nest publish`, or just `git push`.
4. **Ingest.** The push event starts the ingest Workflow; `nest publish` takes the same path synchronously.
   Ingest:
   - rejects stale attempts;
   - checks that the commit's parent is a checkpoint, a contribution, or a tree Nest composed;
   - reads the exact changed paths, and which files the commit creates, from Artifacts;
   - registers the contribution, re-checking the fence inside the Durable Object transaction;
   - starts its review.
5. **Review.** Workers AI triages. Then reviewers from families other than the author's (two by default)
   read the contribution, its task, the other tasks, the requirements and as much of the repository around
   the change as fits their budget, and return a structured verdict, with citations when they give them.
   Routing decides whether a human is needed (section 6). A reviewer that cannot give a verdict never leaves
   work stuck: a human is asked, and can ask the agents again.
6. **Compose.** One composer runs per objective at a time; requests that arrive meanwhile make it compose
   again when it finishes. It plans the frontier (section 5), then for each outcome:
   1. A fresh runner container clones the checkpoint and cherry-picks the contributions in dependency order.
      Cherry-pick is a three-way merge, so independent edits to one file combine, and a real overlap stops
      with the exact paths.
   2. The runner pushes the result to `refs/nest/cand/<id>` in the project's repository. Only when every
      contribution in the outcome is approved does it also push a branch the project's pipeline builds. Each
      composition gets a branch of its own (`cand-<id>` the first time, `cand-<id>-2` the next), so the
      address can only ever answer with this tree. That is the runner's last use of git.
   3. It runs the project's setup and checks on the whole tree, and is then destroyed.
   4. The project's Worker builds that branch as a Preview. An outcome whose members are not all approved
      yet shows its preview check as held; it is composed again once the last approval arrives. Nest opens
      the URL in Browser Rendering every 30 seconds until a deployment answers. That visit is the check: the
      page must load without uncaught errors, and its screenshot goes on the outcome card. A Preview the
      pipeline never deployed answers with the platform's own marker (`x-preview-user-error`), which is the
      pipeline's doing, not the code's: the outcome is composed again once.
7. **Accept.** The human accepts a ready outcome. Acceptance is fenced: the objective verifies, in one
   transaction, that every required check passed and every member is approved, and freezes the outcome as
   accepting so no review can change a member meanwhile; then the Project Durable Object advances the head
   by compare-and-swap on the version and the context and policy digests. A refused swap puts the outcome
   back; a swap that succeeded but whose bookkeeping was cut short is finished by the next composer from the
   project's own record of which outcome its head came from. Losing
   approaches become notes carrying the human's reason. A mirror computer, which never runs candidate code,
   fast-forwards the project's `main`, and Workers Builds deploys it to production.

## 5. The planner

Inputs: live contributions, their dependencies, groups, and which files each one creates.

- **Closure.** Selecting a contribution selects everything it depends on, in a deterministic order. Shared
  ancestors are normal; only an id on the current path is a cycle.
- **Approaches.** A task created as one option in a group *is* that approach. When its agent marks the
  commits that embody the choice, its other commits are building blocks anyone may reuse; when it marks
  none, every commit of the task belongs to the group. An option is everything one task contributed. A
  plan picks one option per group, and accepting one retires the others with everything built on them.
- **Implicit choices.** Independent contributions that create the same file cannot compose, so they become a
  choice automatically.
- **Replacements.** A reconcile's work replaces the contribution it re-creates once it is approved or
  accepted; the planner reads the edge, not the original's status. Work that depended on the original is
  carried onto the replacement: git replays its own change on top, and a real overlap still shows as a
  conflict. When the replacement is accepted, the original is retired, whoever wrote it.
- **What could ship now.** Beside each whole outcome the planner offers its approved part, so work that
  waits for a human never holds back work that is ready. With auto-accept on, that is what ships.
- **Ranking.** Whole outcomes come before fragments of other outcomes, then ready before waiting, then the
  most approved. The top three are composed.
- **Judging.** The checkpoint itself is measured once per context version. An outcome that fails only what
  the checkpoint also fails is **Incomplete**; one that fails a check the checkpoint passes **Breaks a
  check**.
- **When git and checks disagree.**
  - A conflict is a choice for a human: keep one contribution, or reconcile with an agent, which starts
    from the tree of everything that did combine.
  - An outcome that composes but breaks a check, such as two declarations of one name, can be repaired by
    an agent starting from the composed tree.
  - Repairs start automatically only for a true regression: a check that passed for the same selection
    before, or that the accepted checkpoint passed before a requirement changed. One runs at a time, by a
    check made before the start rather than inside one transaction.

## 6. Review routing

The policy is the project's `policy/review-routing` context item plus its configured protected paths. A
human changes it like any context item, so every change of policy is versioned and attributed.

### Who decides

| Setting | What it does |
|---|---|
| `decider: "human"` (default) | A human settles what a first round of agent reviews does not (the list below). |
| `decider: "agents"` | Agents settle reviews. They must be unanimous, and at or above the confidence threshold, raised to 0.9 for protected files. When they split or fall short, one more reviewer from a family not yet used is asked; if that does not settle it, a human is. Any agent's block blocks. |
| `humanPaths` | With agents deciding, changes to these still need a human. The default is every build file in the floor, so dependency and build changes stay with a human unless one narrows the list on purpose. `.nest/` can never be removed. |
| `autoAccept: true` | After each composition, the best ready outcome is accepted by the same compare-and-swap a human's acceptance uses, and deploys. An outcome that chooses between competing approaches or overlapping work is left for a human, as is one that needs a context review. |

Whoever decides, a human's review decides over agents', and these always reach a human: guard hits (such
as the injection tripwire), unusual paths, symlinks and submodules, unreadable or oversized changes, and
changes to `.nest/`.

### When a human decides Floors
in code cannot be lowered: at least one independent reviewer family, confidence of at least 0.5, and
`.nest/`, `package.json`, lockfiles and Wrangler configuration always protected. A human is asked when:

- reviewers disagree, or any review blocks;
- any reviewer's confidence is below the threshold (0.75 by default);
- a protected path changes; a path is unusual (non-canonical, non-ASCII, `..`, trailing dots); the change
  adds a symlink or submodule;
- files cannot be read, or the change exceeds the reviewers' budget;
- the injection tripwire fires;
- an outcome is ready to accept.

Authors never count as reviewers of their own work, so a protected change by the only human must be
authored by an agent and approved by that human. A human's review decides over agents'.

## 7. Context

- **Items.** Requirements, decisions, evidence, notes and policy are Markdown files with front matter in the
  project's context repository. Adding one, or accepting a new version, creates a context-only checkpoint
  and then writes a commit there; the Durable Object is the record, and the repository mirrors it.
  Rejected-approach notes live in the Durable Object only.
- **Citations.** Contributions cite `item@vN` in their trailers, and each objective keeps a citation index.
  A citation is the author's claim; Nest records it and checks its version at acceptance, but cannot know
  what an author read and did not cite.
- **Blast radius.** A new version finds, in every objective of the project, the contributions and outcomes
  that cited the old one, and every running task (which may be reading it now). Their outcomes become
  outdated and are recomposed. If the accepted checkpoint now fails a check it passed when accepted, a
  repair opens. Agent reviews are bound to the version they read: those contributions are routed again and
  reviewed afresh; a human's approval stands. A context item can also be removed, as a context-only
  checkpoint, except the routing policy.
- **Rejected approaches.** Accepting an outcome that turns an approach down writes a note with the human's
  reason and the reviews against it. Every later pack carries it.
- **Search.** `nest search` and `nest_search` are a keyword search over the current items and notes, and
  return citations.

## 8. Scale

| Pressure | Cloudflare limit | Nest's design |
|---|---|---|
| Git traffic | 2,000 requests per 10 s per repository | A repository per task attempt, so there is no shared hot repository |
| Control plane (fork, token) | 2,000 requests per 10 s per namespace | One namespace; workspaces could shard across namespaces |
| Coordination | One Durable Object per objective | Objectives are independent; a large project splits its work into several |
| Previews | 500 per Worker on paid plans | Oldest Previews are deleted automatically; Nest only needs the newest per outcome |
| Event fan-in | One Workflow per push | Registration is idempotent; contribution ids derive from repository and commit |

## 9. Designed, not built

- A GitHub bridge: import from GitHub, and push accepted checkpoints back.
- An API for external CI to report a check on an outcome, so a project can add checks that run elsewhere.
- Track records that weight review routing.
- Semantic retrieval over context; search is keyword-only today.
- Workspace sharding across Artifacts namespaces.

## 10. What live runs taught us

Each was found in a real run on Cloudflare and is fixed in the commit history.

- **Previews cannot be fetched from a Worker.** A Worker's own `fetch` to a Preview hostname returns
  `error code: 1053`, while production custom domains on the same zone work. Nest waits for a Preview with
  Browser Rendering instead, and the first visit that finds the deployment is the check.
- **`node --test test/` fails on Node 24.** Nest's first measurement of Beacon's checkpoint caught it; an
  agent fixed it with a quoted glob, and a human approved the protected change.
- **Agents do not always mark their approach.** Codex tagged none of its commits with the group, so its rule
  was treated as a building block and composed together with the competing rule. A task created as an option
  is now that approach unless its agent says which commits embody the choice.
- **Replacing a contribution orphaned its dependents.** After a reconcile replaced one commit, the work built
  on it dropped out of every outcome. The planner now carries dependents onto the replacement.
- **Git can combine changes that still break each other.** Two agents each declared `badgePath` in
  non-overlapping hunks. The project's typecheck caught it, and the preview build failed with it. Humans can
  now ask an agent to repair such an outcome from the composed tree.
- **Reviewers ran out of room.** Large diffs and reasoning models produced cut-off replies that were not
  verdicts, and a retry reused the same review id. Budgets are larger, retries record new reviews, and a
  human can ask agents to review again.
- **Deploy version skew.** For 40 seconds or more after `wrangler deploy`, a Durable Object can serve the
  previous code. Workflow steps retry for minutes, and missing reviews are reconciled on the next push.
- **One composer per objective.** Composers started by concurrent reviews raced on the same runner and
  baseline. Now one runs at a time, and requests that arrive meanwhile make it compose again.
- **One contribution waiting for a human held back everything.** The first auto-review run composed only
  the whole outcome, so a protected change that needed a human kept three approved changes from shipping.
  The planner now also offers the approved part, and that is what auto-accept shipped as checkpoint 12.
- **Reasoning models write prose before the verdict.** GLM and DeepSeek on Workers AI think first, sometimes
  with braces in the text, and the old parser ("first brace to last brace") threw their verdicts away. The
  parser now takes the one top-level object that carries the verdict key, and fails closed when two could.
- **A Preview that never deployed.** Workers Builds created a Preview for one branch and never deployed it,
  so the branch answered 404 for eight minutes. That is not the code's doing: the outcome is composed again
  once (a new composition is a new commit, which the pipeline builds afresh), and otherwise stays
  incomplete with a Compose again button rather than "breaks a check".
- **Imports land on the source's branch.** An import of a repository whose history is on `master` left
  `main` empty, and Nest works on `main`. The project's mirror computer now creates `main` from the default
  branch before the first checkpoint.
- **A failed mirror never caught up.** If moving `main` failed at acceptance, production stayed on the old
  checkpoint until the next one. A composer now fast-forwards `main` whenever it finds it behind the head,
  and every fresh attempt starts from the exact head commit rather than from whatever `main` holds.
- **A reviewer's family is its lineage, not its host.** Plover ran `gpt-oss` on Workers AI and was counted
  as a third family, but `gpt-oss` is an OpenAI model, so its reviews of Codex-authored work were not
  independent. Plover keeps its identity and past reviews and no longer reviews. Kite (DeepSeek) and Tern
  (Zhipu), both on Workers AI, replace it.
- **The price table was wrong.** The meter charged `gpt-6-luna` at $2 and $10 per million tokens; OpenAI's
  list is $0.10 and $0.50, so every Codex attempt was metered at twenty times its cost (and `gpt-6-astra` at
  half). AI Gateway's own accounting showed it: $0.15 for 4.15M `gpt-6-luna` tokens against $7.53 in the
  ledger. The table now carries list prices, and because both the input and the output price were off by
  the same factor, the ledger is corrected exactly by one visible negative entry per objective
  (`POST /api/admin/spend/correct`), with the original entries left as written.
- **An accepted replacement left its original approved.** A reconcile replaced wren's feed route and shipped
  inside an outcome; wren's commit kept its approved status, and the planner's compatibility check, which
  refuses a contribution together with the one that replaced it, threw for the whole selection. Four
  approved changes composed into nothing, with no error anywhere. The planner now reads the replacement
  edge from accepted work as well as approved work, acceptance retires what an accepted contribution
  replaces whoever wrote it, and every composer applies the same rule to records that predate it.
- **Outcomes aged in place when a sibling moved the head.** Objectives share a project, so one objective's
  acceptance moves the head under every other's outcomes. One built on checkpoint 16 still sat on a board
  whose head was 23. A composer now marks every outcome built on an older checkpoint outdated, in whichever
  objective it finds them.
- **Packs put the task's files first.** The repository section of a pack read files in a fixed order
  (instructions, source, tests, the rest, alphabetically), so on a 164-module library an agent asked about
  `zip.ts` got `add.ts` through `mapValues.ts` and not its own module. Files the task names now come first.
