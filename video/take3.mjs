// Third reel: the route commit conflicted with the accepted tree; reconcile with an agent, accept, and show
// the feed live on production.
import { click, launch, owner, ORIGIN, sleep } from "./lib.mjs";
import * as A from "./acts.mjs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const OBJ = "beacon-open";
const rec = await launch(DIR, "take3");
const { page, beat } = rec;
const state = () => A.api(`/o/${OBJ}`);
const feedLive = async () => { const r = await fetch("https://beacon.nestagents.dev/incidents.atom").catch(() => null); return !!r && r.status === 200; };

async function settle(s) {
  for (const i of s.inbox.filter((x) => x.status === "open")) {
    try {
      if (i.kind === "conflict") {
        // The conflict's card, with its Reconcile button, is the outcome's card under Outcomes.
        await A.tab(page, "outcomes");
        await click(page, page.locator(`[data-cand="${i.target}"]`).first()).catch(() => undefined);
        await sleep(1500);
        await click(page, page.locator(`[data-reconcile="${i.target}"]`).first());
        const form = page.locator("#rc");
        if (await form.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) await click(page, form.locator("button[type=submit]"));
        beat("reconcile with an agent", { kid: i.target });
        await sleep(3000);
      } else if (i.kind === "review") {
        const reasons = (Array.isArray(i.reasons) ? i.reasons : JSON.parse(i.reasons || "[]")).join("; ");
        const verdict = /tripwire|Unusual|symlink|could not be read/i.test(reasons) ? "block" : "approve";
        await A.review(page, i.target, verdict, verdict === "approve" ? `Read it: ${reasons.toLowerCase()}. The change is what the task asked for.` : "A guard fired; this needs a closer look than a demo allows.");
        beat(`review ${verdict}`, { cid: i.target, reasons });
        await sleep(2500);
      }
    } catch (e) { beat("inbox step failed", { kind: i.kind, error: String(e).slice(0, 160) }); }
  }
}

try {
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" });
  await A.signIn(page, owner());
  beat("signed in");
  await A.tab(page, "inbox"); await sleep(4000);
  const t0 = Date.now();
  let s = await state();
  while (!(await feedLive()) && Date.now() - t0 < 40 * 60_000) {
    s = await state();
    if (s.inbox.some((i) => i.status === "open" && i.kind !== "accept")) await settle(s);
    const ready = s.candidates.filter((c) => c.status === "ready").sort((a, b) => b.order.length - a.order.length)[0];
    if (ready) {
      await A.tab(page, "outcomes"); await sleep(4000);
      await click(page, page.locator(`[data-cand="${ready.id}"]`).first()); beat("show on map", { kid: ready.id, members: ready.order.length }); await sleep(3000);
      const before = s.head.version;
      await A.accept(page, ready.id, "The reconciled route serves the typed model's feed; the checks and the Preview pass.");
      beat("accepted");
      s = await A.until(OBJ, (x) => x.head.version > before, { label: "head moved", max: 5 * 60_000 }).catch(() => state());
      beat("checkpoint", { version: s.head.version });
      await sleep(5000);
    }
    await sleep(10_000);
  }
  if (await feedLive()) {
    await page.goto("https://beacon.nestagents.dev/incidents.atom", { waitUntil: "load" });
    beat("production feed"); await sleep(9000);
    await page.goto("https://beacon.nestagents.dev/", { waitUntil: "networkidle" });
    beat("production page"); await sleep(6000);
  } else {
    beat("feed not live", { inbox: s.inbox.filter((i) => i.status === "open").map((i) => `${i.kind}:${i.target}`), candidates: s.candidates.map((c) => `${c.id}:${c.status}`) });
  }
  beat("end");
} catch (e) {
  beat("ERROR", { error: String(e).slice(0, 500) });
  await page.screenshot({ path: `${DIR}/take3-error.png` }).catch(() => undefined);
} finally {
  const v = await rec.close();
  console.log("video", v);
}
