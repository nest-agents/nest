// Scale, second reel: the whole outcome of the 24-agent run becomes ready and is accepted as the human.
import { click, launch, owner, ORIGIN, sleep } from "./lib.mjs";
import * as A from "./acts.mjs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const OBJ = "remeda-edge-cases-2";
const rec = await launch(DIR, "scale2");
const { page, beat } = rec;
try {
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" });
  await A.signIn(page, owner());
  beat("signed in");
  await sleep(4000);
  const s = await A.until(OBJ, (x) => x.candidates.some((c) => c.status === "ready" && c.order.length >= 8), { label: "a whole outcome ready", max: 30 * 60_000 });
  const ready = s.candidates.filter((c) => c.status === "ready").sort((a, b) => b.order.length - a.order.length)[0];
  beat("whole outcome ready", { kid: ready.id, members: ready.order.length, contributions: s.contributions.length });
  await A.tab(page, "outcomes"); await sleep(5000);
  await click(page, page.locator(`[data-cand="${ready.id}"]`).first()); beat("show on map", { kid: ready.id }); await sleep(5000);
  const before = s.head.version;
  await A.accept(page, ready.id, `${ready.order.length} modules' tests extended by four agents, composed as one tree with real git; the runtime tests and the type check pass on the whole.`);
  beat("accepted", { kid: ready.id });
  const s2 = await A.until(OBJ, (x) => x.head.version > before, { label: "head moved", max: 5 * 60_000 }).catch(() => s);
  beat("checkpoint", { version: s2.head.version });
  await sleep(8000);
  const stream = page.locator("#stream"); await stream.scrollIntoViewIfNeeded(); await page.mouse.move(700, 760, { steps: 20 }); beat("activity log"); await sleep(6000);
  const f = await A.api(`/o/${OBJ}`);
  beat("end", { tasks: f.tasks.length, contributions: f.contributions.length, reviews: f.reviews.filter((r) => !r.triage).length, candidates: f.candidates.length, head: f.head.version, accepted: f.contributions.filter((c) => c.status === "accepted").length, spend: f.spend.objectiveMicroUsd / 1e6 });
} catch (e) {
  beat("ERROR", { error: String(e).slice(0, 400) });
  await page.screenshot({ path: `${DIR}/scale2-error.png` }).catch(() => undefined);
} finally {
  const v = await rec.close();
  console.log("video", v);
}
