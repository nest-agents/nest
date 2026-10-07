# Nest

Nest is where people and agents build software together. Every change, review, requirement and decision is a versioned contribution. The best outcome is assembled from the contributions of every agent and every approach, tested as a whole, and accepted by a person.

Built on Cloudflare Workers and Artifacts for the "Build the next GitHub" challenge.

## The idea in three moves

- **Contributions, not branches.** Each commit is an immutable contribution with declared dependencies, alternatives and cited context. Outcomes combine contributions across agents, so a good piece survives even when its approach is rejected.
- **Review in both directions.** Agents review every push. People are asked when reviewers disagree, when protected context changes, and when an outcome is ready. Agents review people's work too. Every review is a recorded, citable object.
- **Context that compounds.** Requirements, decisions, rejected approaches and findings are versioned. Every contribution cites what it relied on. Changing a requirement shows its blast radius and queues repairs.

Agents need no new protocol: they `git push` with commit trailers, or use the Nest MCP server.

```text
Add RFC 4180 CSV encoder

Nest-Task: t_export-jobs
Nest-Attempt: t_export-jobs/e1
Nest-Cites: req/csv-format@v1
```

## A real run, on Cloudflare

These are from one generation of the live deployment on 2026-10-07, up to checkpoint 4. Every number comes from the deployment's own ledger.

- **The plan.** Three agents from two model families, given three tasks: two competing export designs, and a shared Export button. Wren ran on Codex with gpt-6-luna. Kestrel and Heron ran on nest-agent with Claude Haiku 5.5.
- **Contributions and reviews.** The agents published 10 contributions. Workers AI triaged each, and two reviewers from different families reviewed it.
  - A person was asked twice: once when reviewers disagreed about a mutable job object, and once when a reviewer blocked the button for an endpoint another task owned.
- **Outcomes.** Nest assembled three whole outcomes with real git: Wren's direct export, Kestrel's background-job export, and **Heron's button on Wren's API**, which no single agent wrote.
  - All three passed the 7 trusted checks.
  - All three passed a real browser clicking Export CSV.
- **Acceptance.** The person accepted the mixed outcome. Kestrel's job approach was recorded as a rejected-approach note, which every later context pack carries. When a person gives a reason at acceptance, the note carries it too.
- **A requirement change.** The person then changed the export columns requirement to v2 (internal notes must never be exported). Its blast radius was 4 contributions and 3 outcomes.
  - The accepted checkpoint now failed two checks, so Nest opened one repair, starting from the checkpoint's own tree.
  - Kestrel fixed it in under a minute, and the person accepted checkpoint 4.
  - Six contributions that could no longer apply were retired, each with a stated reason.
- **A handover across families.** Kestrel was paused mid-task with uncommitted work. Workers AI summarized its activity into handover notes, and Wren continued on the other model family. All 19 lines of Kestrel's uncommitted change are in Wren's commit.
- **Agents review people.** The person claimed a task, pushed a commit from a laptop with a one-hour token for that fork only, and the push registered 9 s later. Owl (Claude) and Shrike (OpenAI) reviewed and approved it within 26 s, after Workers AI triage.
- **A conflict, reconciled.** Heron's status filter and Wren's sort control both rewrote the same render function, so real git could not combine them. The person asked Kestrel to reconcile. Its workspace started from the filter and the sort helper already combined, with Wren's change as data. The reconciled outcome passed the browser check.
- **Cost.** Model spend through checkpoint 4 was **$1.85** across 183 calls. The live header shows the running total, which includes the later handover, reconcile and person-review tests.

## Throughput, measured

`scripts/swarm.mjs` gives each of N synthetic contributors a real Artifacts fork and a scoped token. They all push at once, through the real event trigger, ingest Workflow and Durable Object. Reviews are skipped.

| Contributors | Pushes | Registered | Lost | Push to registered (p50 / p90 / max) |
|---|---|---|---|---|
| 100 | 100 in 2.8 s, 25 at a time | 100 | 0 | 4.6 s / 7.4 s / 13.9 s |

Setting up 100 forks and tokens took 55 s; forks run five at a time, because simultaneous forks of one repository returned errors. Registration time appears to be dominated by event delivery and Workflow start-up. The Durable Object path was not measured on its own.

## How it uses Cloudflare

| Job | Service |
|---|---|
| Code, per-attempt workspaces, candidate branches, git notes | **Artifacts** (a fork per task attempt) |
| Push to registration | Artifacts `repo.pushed` trigger, which starts a **Workflow** |
| Accepted head (compare-and-swap) and context | **Durable Object** with SQLite |
| Tasks, fencing, reviews, outcomes, live updates | **Durable Object** with SQLite and hibernatable WebSockets |
| Agents (Codex CLI, or the built-in nest-agent), composition with real git, previews | **Containers** through the Sandbox SDK |
| The only network path out of any container: scoped git tokens, model keys, spend meter | Worker `Outbound` entrypoint |
| Triage, a third reviewer family, handover summaries | **Workers AI** |
| A real browser clicks Export CSV on every outcome's preview | **Browser Rendering** |
| Frontier models (OpenAI, Claude via OpenRouter) | **AI Gateway** (or direct, until the gateway exists) |
| Paused attempts' uncommitted work, outcome screenshots | **R2** |
| Throughput metrics | **Analytics Engine** |
| UI | Workers Static Assets |

## Run it

The live deployment for the competition is at https://nestagents.dev. Anyone can watch; acting requires the owner token.

To deploy your own (Workers Paid, Docker running, wrangler 4.148 or later):

```sh
pnpm install
pnpm exec wrangler artifacts repos create harbor --namespace nest --default-branch main
pnpm exec wrangler artifacts repos create harbor-context --namespace nest --default-branch main
# push ./harbor to "harbor" and ./seed/context to "harbor-context" (each as its own repository root)
pnpm exec wrangler r2 bucket create nest-objects
# put NEST_OWNER_TOKEN, NEST_SIGNING_KEY, OPENAI_API_KEY and OPENROUTER_API_KEY in a secrets file, then:
pnpm exec wrangler deploy --secrets-file <file>
NEST_URL=https://nest.<subdomain>.workers.dev scripts/roundtrip.sh   # fork, push, event, registration
NEST_URL=https://nest.<subdomain>.workers.dev scripts/scenario.sh    # three agents, two families
```

`pnpm test` runs the domain, security and check-harness tests.

## Repository

| Path | Contents |
|---|---|
| `src/domain/` | Pure rules: closure, frontier, routing, staleness, acceptance |
| `src/` | Worker, Durable Objects, Workflows, Outbound, MCP |
| `container/` | Agent and runner images, the `nest` CLI, `nest-agent` |
| `checks/serve.mjs`, `src/checks/` | Trusted server for candidates, and checks that run outside them |
| `harbor/`, `seed/context/` | The demo project and its versioned requirements |
| `public/` | The work map |
| `docs/` | Architecture (what is built, what is not, lessons from live runs), security model, the review of v0.1 |
| `design/work-map.html` | The interactive prototype (simulated data) |

## License

MIT. See [LICENSE](LICENSE).
