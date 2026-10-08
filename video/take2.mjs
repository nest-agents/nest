// Second reel: from the outcomes of act 2 (already ready on beacon-open) through acts 3, 4 and 5.
import { chmodSync, writeFileSync } from "node:fs";
import { click, launch, owner, ORIGIN, sleep } from "./lib.mjs";
import * as A from "./acts.mjs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const OBJ = "beacon-open";
const FEED_V2 = "/incidents.atom is a valid Atom 1.0 feed of incidents opened in the last 30 days, newest first, at most 50 entries: one entry per incident with the service name, when it opened, when it closed (or that it is ongoing) and the error that opened it, and each entry links to the status page. Feed readers can poll it every minute.";

const rec = await launch(DIR, "take2");
const { page, beat } = rec;
const state = () => A.api(`/o/${OBJ}`);
const pause = (ms) => sleep(ms);

async function settleInbox(s) {
  for (const i of s.inbox.filter((x) => x.status === "open")) {
    try {
      if (i.kind === "review") {
        const c = s.contributions.find((x) => x.id === i.target);
        const reasons = (Array.isArray(i.reasons) ? i.reasons : JSON.parse(i.reasons || "[]")).join("; ");
        const guard = /tripwire|Unusual|symlink|could not be read|budget/i.test(reasons);
        const blocked = /blocked it/i.test(reasons);
        const verdict = guard ? "block" : blocked ? "changes" : "approve";
        const why = guard ? "A guard fired; this needs a closer look than a demo allows."
          : blocked ? "A reviewer found a real defect; please address it and publish again."
          : `Read it: ${reasons.toLowerCase()}. The change is what the task asked for.`;
        await A.review(page, i.target, verdict, why);
        beat(`review ${verdict}`, { cid: i.target, title: c?.title, reasons });
        await pause(2500);
      } else if (i.kind === "conflict") {
        await A.tab(page, "inbox");
        await click(page, page.locator(`[data-reconcile="${i.target}"]`).first());
        const form = page.locator("#rc");
        if (await form.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) await click(page, form.locator("button[type=submit]"));
        beat("reconcile with an agent", { kid: i.target });
        await pause(2500);
      }
    } catch (e) {
      beat("inbox step failed", { kind: i.kind, error: String(e).slice(0, 160) });
    }
  }
}

try {
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" });
  await A.signIn(page, owner());
  beat("signed in");
  await pause(2500);
  let s = await state();
  const prefer = (x) => {
    const ready = x.candidates.filter((c) => c.status === "ready" && Object.keys(c.choice ?? {}).includes("feed"));
    const model = x.contributions.filter((c) => c.task === "t_feed-model").map((c) => c.id);
    return ready.find((c) => model.includes(c.choice.feed)) ?? ready[0] ?? null;
  };
  const chosen = prefer(s);
  if (!chosen) throw new Error("no feed outcome is ready");
  beat("feed outcomes ready", { ready: s.candidates.filter((c) => c.status === "ready").map((c) => `${c.id}:${c.order.length}`), chosen: chosen.id });
  await A.tab(page, "outcomes"); await pause(6000);
  const other = s.candidates.find((c) => c.status === "ready" && c.id !== chosen.id && Object.keys(c.choice ?? {}).includes("feed"));
  if (other) { await click(page, page.locator(`[data-cand="${other.id}"]`).first()); beat("show on map (other)", { kid: other.id }); await pause(4000); }
  await click(page, page.locator(`[data-cand="${chosen.id}"]`).first()); beat("show on map", { kid: chosen.id }); await pause(4000);
  const preview = page.locator("a.btn", { hasText: "Open preview" }).first();
  if (await preview.count()) { await preview.hover(); beat("preview link"); await pause(2500); }
  await A.accept(page, chosen.id, "The typed model keeps one serializer and its tests parse the feed back, so the next change to the feed has one place to go. The text builder is smaller but every new field means another escape to get right.");
  beat("accepted");
  const before = s.head.version;
  s = await A.until(OBJ, (x) => x.head.version > before, { label: "head moved", max: 5 * 60_000 });
  beat("checkpoint", { version: s.head.version });
  await pause(6000);
  const rejected = page.locator("text=Rejected approaches").first();
  if (await rejected.count()) { await rejected.scrollIntoViewIfNeeded(); await page.mouse.move(150, 700, { steps: 20 }); beat("rejected approaches"); await pause(5000); }
  const stream = page.locator("#stream"); await stream.scrollIntoViewIfNeeded(); await page.mouse.move(700, 800, { steps: 20 }); beat("activity log"); await pause(7000);
  for (let i = 0; i < 40; i++) {
    const r = await fetch("https://beacon.nestagents.dev/incidents.atom").catch(() => null);
    if (r && r.status === 200) break;
    await sleep(6000);
  }
  await page.goto("https://beacon.nestagents.dev/incidents.atom", { waitUntil: "load" }).catch(() => undefined);
  beat("production feed"); await pause(8000);
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" }); await pause(3000);

  // Act 3
  await A.proposeVersion(page, "req/incident-feed", FEED_V2);
  beat("requirement v2");
  const v2at = Date.now();
  await pause(15000);
  s = await A.until(OBJ, (x) => x.candidates.some((c) => c.createdAt && new Date(c.createdAt).getTime() > v2at) || x.tasks.some((t) => t.status === "running" && t.baseCommit), { label: "recompose or repair after v2", max: 8 * 60_000 }).catch(() => state());
  beat("ripple settled", { candidates: s.candidates.map((c) => `${c.id}:${c.status}`) });
  await pause(5000);

  // Act 4
  await page.goto(`${ORIGIN}/p/beacon`, { waitUntil: "networkidle" });
  const card = page.getByText("How work is decided").first(); await card.scrollIntoViewIfNeeded(); await page.mouse.move(500, 600, { steps: 20 }); await pause(2500);
  await A.setPolicy(page, { agents: true, auto: true });
  beat("policy agents+auto");
  await pause(4000);
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" }); await pause(2500);
  const more = [
    { id: "t_feed-limit", title: "Cap the feed at 50 entries", brief: "req/incident-feed version 2 caps the feed at 50 entries, newest first. Implement the cap with a test that proves the 51st incident is left out.", who: "kestrel" },
    { id: "t_badge-link", title: "The badge links to the status page", brief: "Each service badge image is wrapped so a click on it opens the status page; the README's badge snippet shows the link form.", who: "heron" },
  ];
  for (const t of more) { await A.newTask(page, t); beat("task created", { id: t.id }); await pause(1000); }
  const headBefore = (await state()).head.version;
  for (const t of more) { await A.startTask(page, t.id, t.who); beat("task started", { id: t.id, who: t.who }); await pause(1200); }
  s = await A.until(OBJ, (x) => x.head.version > headBefore || x.inbox.some((i) => i.status === "open" && i.kind === "review" && /human may approve|Only a human/i.test((Array.isArray(i.reasons) ? i.reasons.join(" ") : i.reasons) ?? "")), { label: "automatic acceptance or a held change", max: 30 * 60_000 }).catch(() => state());
  beat("agents mode result", { head: s.head.version, headBefore, inbox: s.inbox.filter((i) => i.status === "open").map((i) => `${i.kind}:${i.target}`) });
  await stream.scrollIntoViewIfNeeded(); await page.mouse.move(700, 800, { steps: 20 }); await pause(8000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await pause(2000);

  // Act 5
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" }); await pause(2000);
  const token = await A.invite(page, { id: "codex-laptop", name: "Codex (laptop)", family: "openai", model: "gpt-6-luna" });
  if (!token) throw new Error("no token shown");
  writeFileSync(`${DIR}/act5.token`, token + "\n"); chmodSync(`${DIR}/act5.token`, 0o600);
  beat("invited");
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" }); await pause(2000);
  await A.newTask(page, { id: "t_feed-docs", title: "Document the incident feed in the README", brief: "Add a README section for /incidents.atom: what it is, how often to poll, and one example entry. Cite req/incident-feed." });
  beat("act5 task created");
  writeFileSync(`${DIR}/act5.ready`, new Date().toISOString() + "\n");
  s = await A.until(OBJ, (x) => x.contributions.some((c) => c.author === "codex-laptop"), { label: "the outside agent's push", max: 25 * 60_000 });
  const outside = s.contributions.find((c) => c.author === "codex-laptop");
  beat("outside agent pushed", { cid: outside.id });
  await pause(3000);
  await A.inspect(page, outside.id); beat("outside agent inspector"); await pause(4000);
  s = await A.until(OBJ, (x) => x.reviews.filter((r) => r.target === outside.id && !r.triage).length >= 2 || x.contributions.find((c) => c.id === outside.id)?.status !== "proposed", { label: "reviews of the outside push", max: 10 * 60_000 }).catch(() => state());
  beat("outside agent reviewed", { reviews: s.reviews.filter((r) => r.target === outside.id).map((r) => `${r.reviewer}:${r.verdict}`) });
  await pause(6000);
  await A.tab(page, "inbox"); await pause(3000);
  // Anything still waiting for a human is settled on camera, so the objective ends clean.
  s = await state();
  if (s.inbox.some((i) => i.status === "open" && i.kind !== "accept")) await settleInbox(s);
  beat("end");
} catch (e) {
  beat("ERROR", { error: String(e).slice(0, 500) });
  await page.screenshot({ path: `${DIR}/take2-error.png` }).catch(() => undefined);
  throw e;
} finally {
  const v = await rec.close();
  console.log("video", v);
}
