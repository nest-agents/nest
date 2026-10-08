# How the demo video was made

Nothing in the video is staged. A Playwright script performed every human step of `docs/VIDEO.md` through
the real UI at https://nestagents.dev, in a dedicated headless Chrome that recorded itself, while the agents,
reviewers, composer, previews and deploys ran for real. Each step wrote a timestamped beat; the cut is made
from those beats.

| File | What it does |
|---|---|
| `lib.mjs` | A recording browser (1600×900, a drawn cursor), a beat log, the owner's sign-in, API helpers. |
| `acts.mjs` | The human's steps, as the UI offers them: add to context, new objective, new task, start, review, accept, propose a version, change the policy, invite. |
| `take.mjs`, `take2.mjs`, `take3.mjs` | Acts 1–5 on the Beacon project. The first reel stopped on a live re-render (fixed in `lib.mjs`); the second resumed at the outcomes; the third reconciled the route commit that conflicted after acceptance and showed the feed live. |
| `act5.sh`, `act5-watch.sh` | Act 5: Codex on the laptop joins through MCP as the participant the UI just invited, recorded with asciinema; tokens and this laptop's hook chatter are scrubbed before rendering. The headless recording kept no timing (the output arrived in one burst), so the same output is paced evenly for reading over 75 seconds. |
| `scale.mjs`, `scale2.mjs` | Act 6: starts `scripts/remeda-tests-2.json` and films the objective page; accepts the first whole outcome. |
| `captions.mjs`, `cut.mjs`, `finalize.mjs`, `plan-final.json` | Overlays rendered by the browser with the product's typography, the cut (beats → segments, waits at 8–32× with a badge), the numbers of the scale act read from its own beats. |
| `dry.mjs`, `dry2.mjs` | The mechanics check on a throwaway objective that found the empty-map overlay swallowing the Start click. |
| `after.sh` | Beacon back to human mode, the invited agent's token revoked. |

Run with `VIDEO_DIR` set to a working directory, `playwright` installed (`npm i playwright`, Chrome present),
`asciinema`, `agg` and `ffmpeg` on the path, and the owner token at `~/.secrets/nest_owner_token`.

## The narrated cut

`plan-voiced.json` is the script: a lead-in of cards (`cards.mjs`: the wordmark, the four ideas, how it
works), every act with a short on-screen caption and a narration line, the Cloudflare stack named service by
service, and a close. `cut2.mjs` speaks each narration line with OpenAI text-to-speech (`gpt-4o-mini-tts`,
voice `nova`), holds a segment at least as long as its line, and muxes the audio; `finalize2.mjs` fills in
the scale act's numbers from the scale reel's own beats and renders `nest-demo-voiced.mp4` (9:26).
