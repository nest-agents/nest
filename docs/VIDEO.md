# Demo video: run of show

Target 8 to 9 minutes; the limit is 10. Everything shown is a real run on https://nestagents.dev. A run
takes about 40 minutes of wall time, mostly agents working and previews building. Record the whole session,
then cut to the beats below and speed up the waits (label them "4× speed").

## Before recording

- Sign in at https://nestagents.dev with the owner token. The Sign in button turns into "Signed in".
- Browser at 1600 × 1000 or larger, light mode, notifications off. Zoom to 110% if text looks small.
- Open three tabs:
  1. https://beacon.nestagents.dev (production);
  2. https://nestagents.dev/p/beacon;
  3. the new objective, once created.
- Check spend in the header. A run costs about $6.

## The objective to run

Create it from the project page (New objective):

- **Id:** `beacon-open`
- **Title:** `Beacon that other tools can build on`
- **Done when:**
  - `/api/status carries each service's uptime and open incident`
  - `An incident feed other tools can subscribe to`
  - `The page says plainly when there have been no incidents`

Add one requirement first (Add to context, kind Requirement):

- **Short name:** `incident-feed`
- **Title:** `Incidents are published as an Atom feed`
- **Text:** `/incidents.atom is a valid Atom 1.0 feed of incidents opened in the last 30 days, newest first: one
  entry per incident with the service name, when it opened, when it closed (or that it is ongoing) and the
  error that opened it. Feed readers can poll it every minute.`

Then create these tasks (New task), and start each on the agent shown:

| Task id | Title | Brief (outcome, not steps) | Group | Agent |
|---|---|---|---|---|
| `t_api` | Put uptime and incidents in /api/status | Implement req/api: each service carries its 24-hour uptime and its open incident if any. Document the fields in the README. | | Finch |
| `t_feed-builder` | Atom feed, built as text | Implement req/incident-feed by rendering the XML yourself in a pure module, escaping every value. | `feed` | Kestrel |
| `t_feed-library` | Atom feed, from a typed model | Implement req/incident-feed by building a typed feed model, then serializing it in one place, with tests that parse the output. | `feed` | Wren |
| `t_empty-state` | Say when there have been no incidents | When no incident opened in the last 7 days, the page says so in a sentence. | | Heron |

## Beats

1. **0:00 – 0:40. What Nest is.**
   - Show Beacon in production: "This is Beacon, an uptime monitor checking real services every minute. Its
     history, incidents and badges were built by agents in Nest."
   - Cut to the Nest home page: "Nest is where humans and agents build software together on Cloudflare."
2. **0:40 – 1:30. A project.**
   - Open Beacon's project page and point at three things:
     - the requirements, "versioned like code";
     - How Nest checks it, `npm test`, `tsc` and a Preview of every branch, read from `.nest/project.json`;
     - the checkpoint history.
   - Say: "The repository lives in Cloudflare Artifacts. Accepted work deploys through Workers Builds."
3. **1:30 – 2:15. A human sets the direction.**
   - Add the `incident-feed` requirement and create the objective and the four tasks.
   - Point at the two feed tasks in group `feed`: "Two agents will build the same thing two different ways.
     I'll choose later, between working results."
4. **2:15 – 3:30. Four agents at once.**
   - Start the four tasks and stay on the work map.
   - Contributions arrive in each lane as agents push, with review ticks under each node as two reviewers from
     other model families read them: Owl (Claude), Shrike (OpenAI), Kite (DeepSeek), and Tern (GLM) when
     they need a fourth opinion.
   - Open one contribution in the Inspector: its message, what it cites, its files, its reviews.
5. **3:30 – 4:30. Only what needs a human reaches a human.**
   - Open Needs you, where whatever came up waits: typically a protected file (`package.json`), a low-confidence
     review, or a conflict.
   - Settle it on camera, either with "Approve" and a sentence, or with "Reconcile with an agent" on a conflict.
6. **4:30 – 6:00. Whole outcomes, checked as a whole.**
   - Open Outcomes. Each card is a combination of everyone's work, cherry-picked with real git onto the
     checkpoint.
   - Show its checks: compose, `npm test`, `tsc`, and preview.
   - Show the screenshot of what a real browser saw on that outcome's own Preview deployment, and choose Open
     preview.
   - If an outcome says "Breaks a check", show the failing output and Repair with an agent.
7. **6:00 – 7:00. Context that compounds.**
   - In the context rail, open `req/incident-feed` and propose version 2: "...newest first, at most 50 entries."
   - Accept it. The map ripples from the requirement to every contribution that cited version 1, those
     outcomes become outdated, and Nest recomposes.
   - Say: "Agents cite what they relied on, so a changed requirement shows exactly what it touches."
8. **7:00 – 8:00. A decision, kept.**
   - Accept the outcome with the feed approach you prefer, and type the reason.
   - Show the retired approach in the map and its note under Rejected approaches: "Every later agent gets
     this reason in its context pack."
   - The activity log shows the compare-and-swap and Beacon's `main` fast-forwarding.
9. **8:00 – 8:40. It shipped.**
   - Switch to Beacon production and open `/incidents.atom` and `/api/status`.
   - Say: "Accepted, deployed by Workers Builds, about thirty seconds later."
10. **8:40 – 9:15. On Cloudflare.**
    - Over the work map, read the stack: Artifacts for every repository and fork; Durable Objects for the
      registry, the head and each objective; Workflows; Containers for agents and checks; Browser Rendering;
      AI Gateway; Workers Builds and Previews; R2; Workers AI.
    - Close on the home page.

## If something goes wrong on camera

That is the product working: keep it in. A failed check, a conflict or an undecided review is exactly what
Nest exists to surface. Settle it in the UI and carry on.
