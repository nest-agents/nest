// Act 6: the scale run. Starts the 24-task spec through the public API and records the objective page as it
// fills; accepts the first whole outcome that becomes ready, as the human would.
import { spawn } from "node:child_process";
import { click, launch, owner, ORIGIN, sleep } from "./lib.mjs";
import * as A from "./acts.mjs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const OBJ = "remeda-edge-cases-2";
const rec = await launch(DIR, "scale");
const { page, beat } = rec;
try {
  await page.goto(`${ORIGIN}/p/remeda`, { waitUntil: "networkidle" });
  await A.signIn(page, owner());
  beat("signed in");
  const child = spawn("/Users/scott/nest-v1/scripts/many-agents.sh", ["/Users/scott/nest-v1/scripts/remeda-tests-2.json"], { cwd: "/Users/scott/nest-v1", env: { ...process.env, NEST_TOKEN: owner(), NEST_START_GAP: "8" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[many-agents] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[many-agents!] ${d}`));
  beat("many-agents started");
  await A.until(OBJ, () => true, { every: 3000, max: 2 * 60_000, label: "objective exists" }).catch(() => undefined);
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" });
  beat("objective page");
  const t0 = Date.now();
  let accepted = false;
  while (Date.now() - t0 < 32 * 60_000) {
    const s = await A.api(`/o/${OBJ}`);
    const n = s.contributions?.length ?? 0;
    const ready = (s.candidates ?? []).filter((c) => c.status === "ready").sort((a, b) => b.order.length - a.order.length)[0];
    if (!accepted && ready && ready.order.length >= 6 && Date.now() - t0 > 12 * 60_000) {
      beat("whole outcome ready", { kid: ready.id, members: ready.order.length, contributions: n });
      await A.tab(page, "outcomes"); await sleep(4000);
      await click(page, page.locator(`[data-cand="${ready.id}"]`).first()); await sleep(3000);
      await A.accept(page, ready.id, `${ready.order.length} modules' tests extended by four agents, composed as one tree, checks passing.`);
      accepted = true;
      beat("accepted", { kid: ready.id });
    }
    if ((Date.now() - t0) % 120_000 < 15_000) {
      // A glance at the inbox and back to the map every two minutes, like a human watching.
      await A.tab(page, "inbox"); await sleep(5000); await A.tab(page, "outcomes"); await sleep(4000);
    }
    await sleep(15_000);
  }
  const s = await A.api(`/o/${OBJ}`);
  beat("end", { tasks: s.tasks.length, contributions: s.contributions.length, reviews: s.reviews.filter((r) => !r.triage).length, candidates: s.candidates.length, head: s.head.version, spend: s.spend.objectiveMicroUsd / 1e6 });
  child.kill();
} catch (e) {
  beat("ERROR", { error: String(e).slice(0, 400) });
  await page.screenshot({ path: `${DIR}/scale-error.png` }).catch(() => undefined);
} finally {
  const v = await rec.close();
  console.log("video", v);
}
