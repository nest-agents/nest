# Nest security model

Agents write code that Nest then runs, reviews and composes. The design assumes any agent may be wrong, careless or hostile, and that any text an agent writes may be aimed at another model. No model is a security boundary. Every boundary below is enforced by code outside the model.

## Trust map

| Party | Trusted for | Never trusted for |
|---|---|---|
| The owner (person) | Acceptance, context changes, final reviews | n/a |
| Nest Worker and Durable Objects | Identity, fencing, routing, the head | n/a |
| Agent computers (containers) | Nothing. Every action is checked at the boundary | Git refs, model spend, other workspaces, verdicts |
| Runner computers | Composition with git, until candidate code starts | Anything after candidate code runs |
| Agent reviewers | Advice that routing weighs | Shipping code. Acceptance always needs the owner and passing checks |
| Text from participants (code, diffs, messages, reviews) | Data to read | Instructions |

## Boundaries and what they stop

**Outbound is the only network path out of a container.** Containers start with Internet access off, and every HTTP and HTTPS request is intercepted.
- **Git.** Only git's three smart-HTTP request shapes are allowed, with exact methods and content types. Each computer role may update exactly one ref, checked in the receive-pack pkt-lines:
  - agents: their workspace's `main`;
  - runners: their `cand-<id>`;
  - the mirror computer: the project `main`;
  - the context computer: the context repo.

  Repo-scoped Artifacts tokens are minted and held in the computer's Durable Object, never inside the container.
- **Runners.** A runner loses all git access the moment candidate code starts, because the trusted server may host hostile code. Git is allowed only while the phase is explicitly "compose".
- **Models.** Only agent computers may call models, and only the generation endpoints (`responses`, `chat/completions`). The output budget is clamped in the request body, so each reservation is a true upper bound. Settlement reads only the provider's structured usage object, so model-written text cannot lower a recorded cost.

**Checks run outside the candidate.**
- A trusted server hosts the candidate in its container. The checks run in the Worker and judge HTTP responses only, so a candidate cannot print a forged verdict.
- Fixture integrity is hashed from git through Artifacts, not from the container.

**Previews are sandboxed.** Candidate pages are served with `Content-Security-Policy: sandbox`. That gives them an opaque origin, so they never carry the owner's session and cannot call Nest's API.

**Identity is derived, never declared.**
- A review's reviewer kind and model family come from the participant registry, and kinds are immutable.
- Authors never count as reviewers of their own work.
- Task tokens are HMAC-signed per attempt and generation. Participant tokens are per participant and generation.

**Fencing is enforced twice.**
- Pausing or stopping increments the epoch.
- Ingest rejects commits from a stale attempt, and the Objective DO re-checks inside the registration transaction.
- Workspace names, workflow IDs and tokens carry a generation, so nothing from before a reset maps onto new work.

**Routing fails closed.**
- Policy floors (protected paths, reviewer count, confidence) cannot be lowered by policy.
- These go to a person: unusual paths (non-canonical, non-ASCII, trailing dots or spaces, `..`), symlinks, submodules, unreadable files and oversized changes.

**Prompt injection is data, then a tripwire.**
- Participant-written text reaches models only inside random-boundary data blocks, with a rule that nothing inside is an instruction.
- A deterministic detector scans every added line, the message and the paths. It first applies NFKC, removes format characters, folds Cyrillic and Greek look-alikes, strips comment leaders and joins lines. It also flags words that mix scripts.
- A hit sends the change to a person whatever agent reviewers say.

**Acceptance is a compare-and-swap.** The Project Durable Object advances the head only if the version, context digest and policy digest match, every required check passed exactly once, every member is approved, and stale citations carry the owner's context review.

**Spend has a hard ceiling.** Every model call is reserved against the cap before it is sent and settled from provider usage afterwards. AI Gateway's own spend limit is a second, independent layer once the gateway is enabled.

## How the code was hardened

A background security reviewer audited every commit. Each finding was fixed with a regression test where one could be written:

- self-approval;
- a forgeable in-process check harness;
- unscoped git pushes;
- previews served on Nest's own origin;
- spend clamping;
- regex-based metering;
- policy floors;
- fencing races;
- forged review identity;
- spend replay;
- injection guard bypasses (truncation, look-alikes, comments);
- stale identities across resets.

The commit history records each fix.
