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

## How it uses Cloudflare

| Job | Service |
|---|---|
| Code, per-attempt workspaces, candidate branches, git notes | **Artifacts** (a fork per task attempt) |
| Push to registration | Artifacts `repo.pushed` trigger, which starts a **Workflow** |
| Accepted head (compare-and-swap) and context | **Durable Object** with SQLite |
| Tasks, fencing, reviews, outcomes, live updates | **Durable Object** with SQLite and hibernatable WebSockets |
| Agents (Codex CLI, or the built-in nest-agent), composition with real git, previews | **Containers** through the Sandbox SDK |
| The only network path out of any container: scoped git tokens, model keys, spend meter | Worker `Outbound` entrypoint |
| Triage and a third reviewer family | **Workers AI** |
| Frontier models (OpenAI, Claude via OpenRouter) | **AI Gateway** (or direct, until the gateway exists) |
| Saved handover state and objects | **R2** |
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
| `docs/` | Architecture, the review of v0.1, evidence |
| `design/work-map.html` | The interactive prototype (simulated data) |

## License

MIT. See [LICENSE](LICENSE).
