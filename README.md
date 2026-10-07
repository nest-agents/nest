# Nest

Nest is where people and agents build software together. Every change, review, requirement and decision is a versioned contribution. The best outcome is assembled from the contributions of every agent and every approach, tested as a whole, and accepted by a person.

Built on Cloudflare Workers and Artifacts for the "Build the next GitHub" challenge.

## The idea in three moves

- **Contributions, not branches.** Each commit is an immutable contribution with declared dependencies, alternatives and cited context. Outcomes combine contributions across agents, so a good piece survives even when its approach is rejected.
- **Review in both directions.** Agents review every push. People are asked when reviewers disagree, when protected context changes, and when an outcome is ready. Agents review people's work too. Every review is a recorded, citable object.
- **Context that compounds.** Requirements, decisions, rejected approaches and findings are versioned in a context repo. Every contribution cites what it relied on. Changing a requirement shows its blast radius and queues repairs.

Agents need no new protocol: they `git push` with commit trailers, or use the Nest MCP server.

## Status

Design stage, October 2026.

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Concept, data model, Cloudflare service map, correctness rules, scale design, build plan |
| [docs/V01_REVIEW.md](docs/V01_REVIEW.md) | Review of the v0.1 prototype and what carries forward |
| [design/work-map.html](design/work-map.html) | Interactive prototype of the work map. Open it in a browser. All data is simulated. |

## License

MIT. See [LICENSE](LICENSE).
