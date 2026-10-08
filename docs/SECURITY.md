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
| Agent reviewers | Advice that routing weighs | Shipping code. Acceptance needs passing checks, and a human unless the human has set the project's policy to let agents accept |
| A project's checks | As much as the project's own test suite, like any CI | Anything beyond pass or fail; their output is untrusted text |
| Text from participants and from check output | Data to read | Instructions |

## Boundaries and what they stop

**`Outbound` is the only network path out of a container.** Containers start with Internet access off, and
every HTTP and HTTPS request is intercepted.

- **Git.** Only git's three smart-HTTP request shapes are allowed, with exact methods and content types.
  Each computer role may update only its own refs, checked in the receive-pack pkt-lines:
  - agents: their workspace's `main`;
  - runners: `refs/nest/cand/<id>` in their project's repository, and the buildable branch `cand-<id>` only
    when every contribution in the outcome is approved (decided by Nest before the runner starts, and part
    of the props `Outbound` checks);
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
  - The output budget is clamped in the request body, and fields that would bill input the body does not
    show (`previous_response_id`, `conversation`, `store`) are removed, so each reservation is a true upper
    bound of what the body can cost. Gateway control headers (`cf-aig-*`) are Nest's own; an agent's are
    dropped.
  - Settlement reads only the provider's structured usage object, so model-written text cannot lower a
    recorded cost. (Nest's own reviewer calls, made from the Worker, estimate from text when a provider
    omits usage.)
  - Prices are OpenAI's and OpenRouter's list prices per model; a wrong row is corrected by a visible
    negative ledger entry, never by editing history (see ARCHITECTURE.md §10).

**Configuration comes from the accepted checkpoint.** Setup, checks, preview URL and protected paths are read
from `.nest/project.json` at the head, never from the outcome being judged. `.nest/` is always a protected
path, so changing how a project is checked always reaches a human.

**Check results are as trustworthy as the project's tests.** The checks run the project's own commands on
the whole composed tree, in a fresh container that is destroyed afterwards. A contribution that also changes
a test can weaken that test; that is why tests are reviewed like code, and why protected paths exist.
Check output is untrusted: it is shown escaped, and when it reaches an agent in a repair brief it is wrapped
in a random data boundary.

**Unreviewed code never reaches a build.** A project's pipeline (Workers Builds) builds every branch, and a
build installs dependencies and holds a token that can deploy Workers. So every composed outcome is kept at
`refs/nest/cand/<id>`, which no pipeline builds, and its `cand-<id>` branch is pushed only once every
contribution in it is approved. Anything that decides how a project is installed, built or deployed
(`package.json`, every lockfile, `.npmrc` and other package-manager configuration, Wrangler configuration,
`.nest/`) is always a protected path, so a change that could run code in a build needs a human's approval
before any build sees it, unless the human hands dependency and build changes to agents in the policy
(`humanPaths`); `.nest/` can never be handed over. A project adds its own build inputs, such as
Dockerfiles, to `protected`.

**Previews are the project's own deployments.** Nest no longer serves candidate code on its own origin. Each
outcome is a Preview of the project's Worker at the HTTPS address the project's configuration names for the
branch. Preview settings must use Preview-only resources and no production secrets; Durable Object storage
is separate per Preview automatically. Browser Rendering opens the Preview in a browser that holds no Nest
credentials and judges only what the browser saw: the HTTP status and uncaught page errors. It does not
verify which commit answered: a branch composed again reuses its address, and an older deployment that is
still up can answer the first visit.

**Identity is derived, never declared.**
- A review's reviewer kind and model family come from the participant registry, and both are immutable once
  registered.
- Authors never count as reviewers of their own work.
- Task tokens are HMAC-signed per attempt and objective generation.
- Participant tokens are HMAC-signed per participant revision. Rotating a participant revokes every
  participant token issued before. An attempt that participant already started keeps its task token and
  its one-hour fork token until it ends; stop the attempt to cut those off.
- A session cookie acts only from Nest's own origin: an unsafe request whose `Origin` is not this Worker's
  is treated as signed out, so a page on a sibling hostname (a Preview) cannot post with the owner's cookie.

**Fencing is enforced twice.**
- Pausing or stopping ends the attempt; the next start of the task is a new epoch.
- Ingest rejects commits from a stale attempt, and the Objective Durable Object re-checks inside the
  registration transaction.
- Workspace names, workflow ids, computers and tokens carry the objective's random generation, so nothing
  can map onto another objective's work.

**Contributors can only retire their own work.** `Nest-Supersedes` names a contribution the same author
wrote and that is not yet accepted. Only a reconcile a human started may replace someone else's work, and
only once reviewers approve it.

**Letting agents decide is a human's explicit, versioned choice.** With `decider: "agents"` and `autoAccept`,
work can reach production with no human looking at it. That is what the setting is for, so its limits are
built in rather than configurable:
- agents deciding alone need at least two independent families, unanimous and confident; a split brings in
  one more family before anything is approved, and any block decides at once;
- `.nest/`, guard hits and changes reviewers could not fully see always need a human;
- dependency and build changes stay with a human unless the human narrows `humanPaths`, which the UI labels
  as able to run code in a build that can deploy Workers;
- auto-accept never chooses between competing approaches or overlapping work, and moves the head by the
  same compare-and-swap, with the same checks, as a human.

Model families are counted by lineage: two models trained by the same company are one family, wherever they
run, and a review is weighed by its reviewer's family as the roster knows it now, so a model that was once
misfiled (gpt-oss on Workers AI, counted as its host) is corrected for its past reviews too.

**Routing fails closed.**
- Policy floors (protected paths, reviewer count, confidence) cannot be lowered by policy.
- A protected rule ending in `/` is a directory, a rule with a `/` inside is one exact path, and a rule
  without one names that file anywhere in the tree, because a nested `package.json` or `.npmrc` also decides
  what an install runs.
- These go to a human: unusual paths (non-canonical, non-ASCII, trailing dots or spaces, `..`), symlinks,
  submodules, unreadable files and oversized changes.

**A verdict is one object, or none.** A reviewer's reply is parsed for the single top-level JSON object that
carries the verdict key. Code fences are only markers, so an object outside a fence counts like one inside;
an object nested in text that is not JSON is not top-level; and malformed fields are read as absent. A
reply with two such objects, which is what an injected verdict quoted in the reviewer's prose would
produce, is no verdict at all, and the contribution goes on to another reviewer or a human.

**Prompt injection is data, then a tripwire.**
- Participant-written text and check output reach models only inside random-boundary data blocks, with a rule
  that nothing inside is an instruction. Rejected-approach notes, which quote titles and review summaries,
  are wrapped the same way. A paused agent's notes reach its successor's brief labelled as data, without a
  boundary.
- Outcome names, which become repair task titles, are built only from owner-written task titles and
  registered names, never from commit messages.
- A deterministic detector scans every added line (up to four million characters of diff; a diff that could
  not be computed is itself a reason for a human), the message, the paths and sibling titles. It first
  applies NFKC, removes format characters, folds Cyrillic and Greek look-alikes, strips comment leaders and
  joins lines. It also flags words that mix scripts. A hit sends the change to a human whatever agent
  reviewers say.

**Acceptance is a compare-and-swap.** Acceptance first verifies that every required check passed exactly
once, every member is approved and stale citations carry the owner's context review; then the Project
Durable Object advances the head only if the version, context digest and policy digest still match. Only
the mirror computer, which never runs candidate code, moves `main`.

**Spend has a hard ceiling.** One ledger covers the whole deployment. Every model call is reserved against
the cap before it is sent and settled from provider usage afterwards, and a reservation id is honoured once.
AI Gateway's own daily spend limit is a second, independent layer.

**Retirement is a recorded fact.** Work is retired, with its reason, only by acceptance logic. What counts
as retired is a column that code sets, never inferred from the text of a flag.

## Public by default

Reading a project, its context and its objectives needs no sign-in: the live site is a public demonstration,
and an objective's snapshot includes contribution titles, messages and reviews. Repository contents and
diffs need the owner token, a task token, or a participant token (through the MCP pack and search tools).
A deployment for private work would put Cloudflare Access in front of the read routes and of the project's
Previews.

## Known limitations

Found by a read-only review on 2026-10-08 and not yet fixed; each is a narrow window or an operator path,
and none is hidden by the text above.

- **Eligibility and the head swap are two steps.** A review that turns to a block between acceptance's
  check and the Project Durable Object's compare-and-swap is not seen by the swap.
- **Acceptance after the swap is not resumable.** If the request dies between advancing the head and
  marking the candidate accepted, the candidate stays ready against a head it no longer matches; the owner
  resolves it by composing again.
- **Reviews are not bound to context versions.** An approval given against `req/x@v1` still counts after
  `req/x@v2`; the blast radius recomposes the outcome but does not ask for a fresh review.
- **Mirror catch-up depends on the next composition.** A `main` that failed to move is fast-forwarded by the
  next composer, not by a queue of its own; a context-only checkpoint in between does not trigger it.
- **A Preview answered by an older deployment** of the same branch can satisfy the browser visit (above).
- **An undeployed Preview and an application error look alike** to the browser (both answer 4xx/5xx), so
  an outcome whose Preview answers 500 is composed again once rather than marked as breaking a check.
- **Manual forks start from the fork's `main`**, which is the head in every normal case; the managed agent
  workflow resets to the exact commit, the manual path does not.
- **Two automatic repairs can start together** if two regressions are detected at the same moment.
- **Rotation does not stop running attempts** (above).

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
- unreviewed compositions pushed to a branch the project's pipeline builds;
- retirement inferred from flag text;
- a negative SQL `LIMIT` read as unlimited.

A second, read-only review of the whole source (Codex, 2026-10-08) found twenty-three issues. Fixed the
same day: cookie requests from sibling hostnames (CSRF); verdicts quoted in fences or nested in non-JSON;
a reviewer's malformed `findings` aborting the review; agents setting Gateway control headers; server-side
context billed outside the reservation; a directory replaced by a symlink escaping the special-entry flag;
a failed configuration read dropping protected paths; a composer renewal losing a queued composition; one
family satisfying agents-only review; a misfiled reviewer family counting as independent; rejected-approach
notes reaching models unwrapped; unreadable or uncomputable diffs passing as reviewed; paused patches of two
objectives sharing one key; the approved part of an outcome losing its competing-group marker; and the
price table. The rest are listed under known limitations.

The commit history records each fix.
