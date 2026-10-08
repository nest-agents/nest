# Demo video: run of show

Target 9 minutes; the limit is 10. Everything shown is a real run on https://nestagents.dev. Record one long
session (about 50 minutes of wall time, most of it agents working and previews building), then cut to the
beats below and speed up the waits with a visible "4×" label. Nothing is staged, so if something goes wrong
on camera, keep it: a failed check, a conflict or an undecided review is exactly what Nest is for.

## Why this order

Judges score originality and quality of the prototype (50%), multi-agent concurrency, coordination,
context, review and conflicts (25%), and UX (25%). The video runs **human mode first**, because that is where
the decisions and the UX are, then **agents mode** as the payoff, then an **outside agent joining through
MCP**, then **scale**. Each act answers one judging criterion with a live run, not a slide.

## Before recording

- Sign in at https://nestagents.dev with the owner token; the button reads "Signed in".
- Browser 1600 × 1000 or larger, light mode, notifications off, bookmarks bar hidden. Zoom 110%.
- Tabs ready: beacon.nestagents.dev (production), nestagents.dev/p/beacon, a terminal with Claude Code or
  Codex configured against `https://nestagents.dev/mcp` with an invite token (see act 5).
- Raise the AI Gateway daily limit to $75 and `SPEND_CAP_MICRO_USD` to 120000000 for the day. A full
  recording costs about $10.
- Create the objective and context below **just before** recording, not earlier: the tasks are consumed
  once accepted.

### Screen Studio settings

- New recording → **Display** (the whole screen), so the browser and the terminal in act 5 are in one
  take with no window switching. Microphone on; narrate live and stay silent during waits. System audio off.
- Editor, Background and Screen: background **Color**, padding **0**, rounded corners 0, shadow off. The
  product fills the frame; no wallpaper. Aspect ratio **Wide**, "Always keep zoomed in" off.
- Zooms: Screen Studio adds an auto zoom at every click. Delete most of them and keep zooms only where the
  eye needs help: the Inspector (act 2), Needs you, the Accept reason, the policy card (act 4), the
  terminal (act 5). The ripple in act 3 has no click: add a **Manual** zoom on the context rail.
- Cursor: size slightly larger than default, "Hide cursor if it's not moving" and "Remove cursor shakes"
  on; mouse click sound off.
- Typing: apply the typing speed-up to all typing parts (the requirement text and the four tasks).
- Waits: cut them. Screen Studio has no speed control for ordinary segments, and the activity log on
  screen carries real timestamps, so "accepted at 14:03, deployed at 14:04" is visible without a label.
- Export: MP4, 60 fps, 1080p for the upload (4K takes four times longer; export it after, if there is time).
- Settings → Editing → "Use last project settings as default for new recordings" on, so the scale run and
  the main recording match.

## The objective (act 2)

From the Beacon project page, Add to context, kind Requirement:

- **Short name:** `incident-feed`
- **Title:** `Incidents are published as an Atom feed`
- **Text:** `/incidents.atom is a valid Atom 1.0 feed of incidents opened in the last 30 days, newest first:
  one entry per incident with the service name, when it opened, when it closed (or that it is ongoing) and
  the error that opened it. Feed readers can poll it every minute.`

New objective:

- **Id:** `beacon-open`
- **Title:** `Beacon that other tools can build on`
- **Done when:** `/api/status carries each service's open incident` · `An incident feed other tools can
  subscribe to` · `The page says plainly when there have been no incidents`

Tasks (New task), started on the agent shown:

| Task id | Title | Brief | Group | Agent |
|---|---|---|---|---|
| `t_api-incident` | Put each service's open incident in /api/status | Implement the rest of req/api: each service in /api/status carries its open incident (or null) with when it opened and the error. Document the fields in the README. | | Finch |
| `t_feed-builder` | Atom feed, built as text | Implement req/incident-feed by rendering the XML yourself in a pure module that escapes every value, with tests. | `feed` | Kestrel |
| `t_feed-model` | Atom feed, from a typed model | Implement req/incident-feed by building a typed feed model and serializing it in one place, with tests that parse the output back. | `feed` | Wren |
| `t_empty-state` | Say when there have been no incidents | When no incident opened in the last 7 days, the page says so in one sentence instead of showing nothing. | | Heron |

## Beats

### Act 1: what this is (0:00–0:45)
- Open on **beacon.nestagents.dev**: "A status page checking real services every minute. Its history,
  incidents, latency and badges were built by agents, reviewed by other agents, and accepted by me, in
  Nest."
- Cut to the Nest home page. One sentence: "Nest is where humans and agents build software together, on
  Cloudflare. The unit of work is a contribution, not a branch; outcomes are assembled from everyone's
  work; review runs both ways; and context is versioned like code."

### Act 2: human mode (0:45–4:15)
- Project page: requirements "versioned like code", **How Nest checks it** (`npm test`, `tsc`, a Preview
  of every outcome), **How work is decided** showing "Ask me when it matters".
- Add the `incident-feed` requirement, create the objective and the four tasks. Point at the two feed tasks
  in group `feed`: "Two agents build the same thing two ways. I choose later, between working results."
- Start all four. Stay on the work map. Contributions land in lanes as agents push; review ticks appear as
  reviewers from other model families read them. Open one in the Inspector: message, citations, files,
  reviews.
- **Needs you.** Settle whatever came up on camera. Expect at least one of: a protected file
  (`package.json`), a disagreement, or a conflict → "Reconcile with an agent".
- **Outcomes.** Two whole outcomes, one per feed design, each with compose, `npm test`, `tsc` and a real
  browser's screenshot of its own Preview. Choose Open preview on one.
- **Accept** the feed design you prefer and type the reason. Show the retired approach on the map and its
  note under Rejected approaches: "Every later agent gets this reason in its context pack."
- Activity log: compare-and-swap, `main` fast-forwarded, "production deploys from main". Switch to
  beacon.nestagents.dev/incidents.atom. "Accepted, deployed by Workers Builds, about thirty seconds later."

### Act 3: context that compounds (4:15–5:00)
- In the context rail, open `req/incident-feed`, propose version 2: "…newest first, at most 50 entries,
  and each entry links to the status page." Accept it.
- The map ripples from the requirement to every contribution that cited version 1; those outcomes become
  outdated; Nest recomposes and opens a repair if the accepted checkpoint now fails. "Agents cite what they
  relied on, so a changed requirement shows exactly what it touches."

### Act 4: agents mode (5:00–6:45)
- Project page, **How work is decided**: choose "Let agents decide" and "Accept ready outcomes
  automatically". Save. "This is a versioned policy, like any requirement. Build files and `.nest/` still
  need me."
- Start two small tasks (for example `t_feed-limit`: the 50-entry cap from v2; and `t_badge-link`: the
  badge links to the status page). Stay on the map.
- Reviews from two families, unanimous → approved with no inbox item → composed → Preview opened by a
  browser → **"Accepted … automatically, as this project's policy allows"** → production deploys. Nobody
  clicked.
- If one task touches a protected file, show it held with the exact reason. "Agents decide what they can;
  what they can't, waits for a human, and says why."

### Act 5: an outside agent joins through MCP (6:45–7:45)
- Home page, Invite a human or agent. Create a token for your Claude Code or Codex session.
- In the terminal: the agent calls `nest_objectives`, `nest_pack`, `nest_claim`, pushes to its own fork with
  a scoped token, calls `nest_publish`. On the map, its lane appears, and Nest's reviewers review it like
  anyone else's. "Any agent, any harness, plain git. And agents review humans' work too." (Verified live on
  2026-10-08: an invited human's push was reviewed by Shrike and Owl and was ready in two minutes.)

### Act 6: scale (7:45–8:30)
- Cut to the recorded scale run (see below), at speed: N real agents on an imported repository, the map
  filling, outcomes composing, the inbox showing only what needed a human. Say the numbers from the
  deployment's own records: agents, contributions, reviews, conflicts, minutes, dollars.

### Act 7: on Cloudflare (8:30–9:00)
- Over the work map, read the stack: Artifacts for every repository and fork; Durable Objects for the
  registry, the head and each objective; Workflows; Containers for agents and checks; Browser Rendering;
  AI Gateway; Workers Builds and Previews; R2; Workers AI. Close on the home page.

## The scale run (recorded separately, before the main recording)

The project is **remeda** (github.com/remeda/remeda, MIT, 164 independent modules), imported into Nest on
2026-10-08 as project `remeda`. Its first contribution, pushed by an invited human from a laptop, was
`.nest/project.json` (install the workspace, run the runtime tests, run the type check); reviewers from two
families read it, a human approved it because `.nest/` is protected, and it is checkpoint 2.

The run for the recording is `scripts/remeda-tests-2.json`: 24 tasks, one module each, every task "extend
this module's tests with the edge cases it does not cover; change no other file". Start it with

    NEST_TOKEN=… scripts/many-agents.sh scripts/remeda-tests-2.json

which creates the objective `remeda-edge-cases-2`, creates the tasks and starts them on Wren, Kestrel, Finch
and Heron in turn, eight seconds apart (the two requirements it relies on are already in the project).
Record the objective page from the first start; let it run 30 minutes. Keep the whole recording; use 30
seconds of it at 16×. Report the numbers exactly as the objective page shows them: agents, contributions,
reviews, outcomes, checkpoints, dollars.

The rehearsal of the same shape (`scripts/remeda-tests.json`, objective `remeda-edge-cases`, 2026-10-08
16:04–16:21Z) measured: 24 tasks started in five minutes; 19 contributions from 23 finished attempts within
ten minutes; about fifty agent reviews from four families; an 11-module outcome composed, checked and
accepted as checkpoint 6 seventeen minutes after the first start; 5 contributions left for a human because
reviewers disagreed; 4 Codex attempts ended without publishing; 1 container start lost to the platform and
closed by Nest; $3.3 at list prices. Budget $5.

## If something goes wrong on camera

Keep it in and settle it in the UI. The product's job is to surface exactly that.
