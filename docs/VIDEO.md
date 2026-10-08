# Demo video: run of show

The target is 8 minutes; the rules allow 5 to 10. Everything below runs live on the deployment. Each beat names the screen, the action, and one or two spoken lines. Beats are timed, so they are numbered.

## Before recording

1. Run `scripts/scenario.sh --reset`. This rewinds both repositories to their recorded seeds; the spend ledger survives. Wait until the three agents finish (about 4 minutes) and outcomes are composed.
2. Keep two windows ready: the work map, signed in as the owner, and a terminal with a clone of a fork (for beat 3).
3. Keep the models as configured (gpt-6-luna, Claude Haiku 5.5, gpt-oss-120b). They are fast, so the waiting is short. A full rehearsal costs about $2.

## Beats

| # | Time | Screen | Action | Say |
|---|---|---|---|---|
| 1 | 0:00 | Work map, live | Let pushes land | "GitHub's unit is the branch. Nest's unit is the contribution. Three agents, two model families, each in its own Artifacts fork, pushing right now." |
| 2 | 0:40 | Activity log, then a contribution in the Inspector | Click a node | "A push fires an Artifacts event, a Workflow registers it in a Durable Object, and two reviewers from the families that didn't write it read it, with the repository around the change." |
| 3 | 1:30 | Terminal, then the work map | Claim a task as the human, `git push` | "Humans are contributors too. I push from my laptop with a token for my fork only. Claude and GPT review my work like anyone else's." |
| 4 | 2:20 | Needs you | Settle one disagreement with a sentence | "I'm asked only when it matters: reviewers disagree, a guard fires, or an outcome is ready." |
| 5 | 3:00 | Outcomes | Open the mixed outcome and its preview; click Export CSV | "Nest assembled whole outcomes with real git. This one is Heron's button on Kestrel's API, and no single agent wrote it. Seven trusted checks run outside the candidate, and a real browser clicked Export." |
| 6 | 4:10 | Accept dialog, then History | Accept with a reason | "Acceptance is a compare-and-swap on the head. My reason becomes context: every later agent reads why the direct approach lost." |
| 7 | 4:50 | Context panel | Change export columns to v2 | "Requirements are versioned like code. This change has a blast radius, and the accepted checkpoint now fails two checks." |
| 8 | 5:20 | Work map | Watch the repair start from the head's own tree, get reviewed and become ready; accept | "One repair, starting from the exact failing tree. No cascade." |
| 9 | 6:20 | A conflict card | Reconcile with an agent | "When real git can't combine two changes, it's my call: keep one, or have an agent re-create one on top of the other." |
| 10 | 7:00 | Terminal output | Show the swarm numbers | "A hundred contributors pushing at once to real forks: all registered, none lost, median 4.6 seconds." |
| 11 | 7:30 | Architecture table | Close | "Workers, Artifacts, Durable Objects, Workflows, Containers, Workers AI, Browser Rendering, R2. Open source; deploy your own." |

## Fallbacks

- If an agent stalls, Stop it and hand the task over. A handover across model families is itself a beat worth showing.
- If no reviewer disagreement happens naturally, beat 4 uses whichever question is in the inbox.
- Keep the recorded 2026-10-07 run (README) as the source for any number spoken aloud.
