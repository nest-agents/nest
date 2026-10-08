# Nest security model

Agents write code that Nest then runs, reviews and composes. The design assumes any agent may be wrong,
careless or hostile, and that any text an agent writes may be aimed at another model. No model is a security
boundary: every boundary below is enforced by code outside the model.

## Trust map

| Party | Trusted for | Never trusted for |
|---|---|---|
| The owner (human) | Projects, context, acceptance, final reviews | n/a |
| Invited humans (participant tokens) | Their own reviews, which count as a human's | Acceptance, context, other participants' identity |
| Nest Worker and Durable Objects | Identity, fencing, routing, the head, the spend ledger | n/a |
| Agent computers (containers) | Nothing. Every action is checked at the boundary | Git refs, model spend, other workspaces, verdicts |
| Runner computers | Composition with git, until the project's code starts | Anything once the project's setup or checks run |
| Agent reviewers | Advice that routing weighs | Shipping code. Acceptance always needs a human and passing checks |
| A project's checks | As much as the project's own test suite, like any CI | Anything beyond pass or fail; their output is untrusted text |
| Text from participants and from check output | Data to read | Instructions |

## Boundaries and what they stop

**`Outbound` is the only network path out of a container.** Containers start with Internet access off, and
every HTTP and HTTPS request is intercepted.

- **Git.** Only git's three smart-HTTP request shapes are allowed, with exact methods and content types.
  Each computer role may update exactly one ref, checked in the receive-pack pkt-lines:
  - agents: their workspace's `main`;
  - runners: `cand-<id>` in their project's repository;
  - the mirror computer: their project's `main`;
  - the context computer: their project's context repository.

  Reads are limited to the computer's own project and workspaces. Repository-scoped Artifacts tokens are
  minted and held in the computer's Durable Object, never inside the container.
- **Runners lose git before the project's code runs.** Git is allowed only while the phase is "compose". The
  phase moves to "host" and cached tokens are dropped before setup starts, and a runner that has hosted code
  is destroyed before it is used again.
- **Packages.** Agents and runners may `GET` and `HEAD` from `registry.npmjs.org`, with only content
  negotiation headers forwarded, so `npm ci` works. Nothing else is reachable, and no credential exists in
  the container to send.
- **Models.** Only agent computers may call models, and only the generation endpoints through the
  authenticated AI Gateway.
  - Each agent may call only the model configured for its provider, and only a model with an exact price.
  - Fields that would change the model or the bill beyond tokens are removed or clamped before forwarding:
    fallback model lists, provider routing, priority tiers, multiple completions and paid hosted tools. The
    forwarded body is the re-serialized object that was checked.
  - The output budget is clamped in the request body, so each reservation is a true upper bound.
  - Settlement reads only the provider's structured usage object, so model-written text cannot lower a
    recorded cost.

**Configuration comes from the accepted checkpoint.** Setup, checks, preview URL and protected paths are read
from `.nest/project.json` at the head, never from the outcome being judged. `.nest/` is always a protected
path, so changing how a project is checked always reaches a human.

**Check results are as trustworthy as the project's tests.** The checks run the project's own commands on
the whole composed tree, in a fresh container that is destroyed afterwards. A contribution that also changes
a test can weaken that test; that is why tests are reviewed like code, and why protected paths exist.
Check output is untrusted: it is shown escaped, and when it reaches an agent in a repair brief it is wrapped
in a random data boundary.

**Previews are the project's own deployments.** Nest no longer serves candidate code on its own origin. Each
outcome is a Preview of the project's Worker on the project's own hostname, with Preview-only storage.
Browser Rendering opens it in a browser that holds no Nest credentials and judges only what the browser saw:
the HTTP status and uncaught page errors.

**Identity is derived, never declared.**
- A review's reviewer kind and model family come from the participant registry, and both are immutable once
  registered.
- Authors never count as reviewers of their own work.
- Task tokens are HMAC-signed per attempt and objective generation.
- Participant tokens are HMAC-signed per participant revision. Rotating a participant revokes every token
  issued before.

**Fencing is enforced twice.**
- Pausing or stopping increments the epoch.
- Ingest rejects commits from a stale attempt, and the Objective Durable Object re-checks inside the
  registration transaction.
- Workspace names, workflow ids, computers and tokens carry the objective's random generation, so nothing
  can map onto another objective's work.

**Contributors can only retire their own work.** `Nest-Supersedes` names a contribution the same author
wrote and that is not yet accepted. Only a reconcile a human started may replace someone else's work, and
only once reviewers approve it.

**Routing fails closed.**
- Policy floors (protected paths, reviewer count, confidence) cannot be lowered by policy.
- These go to a human: unusual paths (non-canonical, non-ASCII, trailing dots or spaces, `..`), symlinks,
  submodules, unreadable files and oversized changes.

**Prompt injection is data, then a tripwire.**
- Participant-written text and check output reach models only inside random-boundary data blocks, with a rule
  that nothing inside is an instruction.
- Outcome names, which become repair task titles, are built only from owner-written task titles and
  registered names, never from commit messages.
- A deterministic detector scans every added line, the message, the paths and sibling titles. It first
  applies NFKC, removes format characters, folds Cyrillic and Greek look-alikes, strips comment leaders and
  joins lines. It also flags words that mix scripts. A hit sends the change to a human whatever agent
  reviewers say.

**Acceptance is a compare-and-swap.** The Project Durable Object advances the head only if the version,
context digest and policy digest match; every required check passed exactly once; every member is approved;
and stale citations carry the owner's context review. Only the mirror computer, which never runs candidate
code, moves `main`.

**Spend has a hard ceiling.** One ledger covers the whole deployment. Every model call is reserved against
the cap before it is sent and settled from provider usage afterwards, and a reservation id is honoured once.
AI Gateway's own daily spend limit is a second, independent layer.

**Retirement is a recorded fact.** Work is retired, with its reason, only by acceptance logic. What counts
as retired is a column that code sets, never inferred from the text of a flag.

## Public by default

Reading a project, its context and its objectives needs no sign-in: the live site is a public demonstration.
Code and contribution contents need the owner token or a task token. A deployment for private work would put
Cloudflare Access in front of the read routes and of the project's Previews.

## How the code was hardened

A background security reviewer audited every commit. Each finding was fixed, with a regression test where one
could be written:

- self-approval; forged review identity; stale identities across generations;
- a forgeable in-process check harness, replaced by checks the project defines and Nest runs from the
  accepted configuration;
- unscoped git pushes; previews served on Nest's own origin;
- spend clamping, regex-based metering, spend replay, and an unpriced model or fallback model list escaping
  the reservation;
- policy floors; fencing races; superseding another participant's work;
- injection guard bypasses (truncation, look-alikes, comments);
- check output from contributed code reaching an agent's brief unwrapped;
- retirement inferred from flag text;
- a negative SQL `LIMIT` read as unlimited.

The commit history records each fix.
