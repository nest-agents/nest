// The main take: acts 1–5 of docs/VIDEO.md on the Beacon project, performed as the human, recorded.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { click, launch, owner, ORIGIN, sleep } from "./lib.mjs";
import * as A from "./acts.mjs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const OBJ = "beacon-open";
const FEED_V2 = "/incidents.atom is a valid Atom 1.0 feed of incidents opened in the last 30 days, newest first, at most 50 entries: one entry per incident with the service name, when it opened, when it closed (or that it is ongoing) and the error that opened it, and each entry links to the status page. Feed readers can poll it every minute.";

const rec = await launch(DIR, "take");
const { page, beat } = rec;
const state = () => A.api(`/o/${OBJ}`);
const pause = async (ms) => { await sleep(ms); };

/** Settles whatever the inbox holds, the way the run of show says: reasons on screen, a verdict. */
async function settleInbox(s) {
  for (const i of s.inbox.filter((x) => x.status === "open")) {
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
  }
}

try {
  // Sign in first (not part of the cut), then the opening shots.
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await A.signIn(page, owner());
  beat("signed in");

  // Act 1
  await page.goto("https://beacon.nestagents.dev/", { waitUntil: "networkidle" });
  beat("act1 production");
  await page.mouse.move(700, 420, { steps: 30 }); await pause(9000);
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  beat("act1 home");
  await pause(7000);

  // Act 2: project page
  await page.goto(`${ORIGIN}/p/beacon`, { waitUntil: "networkidle" });
  beat("act2 project");
  await pause(4000);
  for (const text of ["How Nest checks it", "How work is decided"]) {
    const h = page.getByText(text).first();
    await h.scrollIntoViewIfNeeded(); await page.mouse.move(600, 500, { steps: 20 }); beat(`show ${text}`); await pause(5000);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await pause(1200);
  await A.addContext(page, {
    kind: "requirement", name: "incident-feed", title: "Incidents are published as an Atom feed",
    body: "/incidents.atom is a valid Atom 1.0 feed of incidents opened in the last 30 days, newest first: one entry per incident with the service name, when it opened, when it closed (or that it is ongoing) and the error that opened it. Feed readers can poll it every minute.",
  });
  beat("requirement added");
  await pause(2500);
  await A.newObjective(page, { id: OBJ, title: "Beacon that other tools can build on", criteria: ["/api/status carries each service's open incident", "An incident feed other tools can subscribe to", "The page says plainly when there have been no incidents"] });
  beat("objective created");
  await pause(2500);
  const tasks = [
    { id: "t_api-incident", title: "Put each service's open incident in /api/status", brief: "Implement the rest of req/api: each service in /api/status carries its open incident (or null) with when it opened and the error. Document the fields in the README.", who: "finch" },
    { id: "t_feed-builder", title: "Atom feed, built as text", brief: "Implement req/incident-feed by rendering the XML yourself in a pure module that escapes every value, with tests.", group: "feed", who: "kestrel" },
    { id: "t_feed-model", title: "Atom feed, from a typed model", brief: "Implement req/incident-feed by building a typed feed model and serializing it in one place, with tests that parse the output back.", group: "feed", who: "wren" },
    { id: "t_empty-state", title: "Say when there have been no incidents", brief: "When no incident opened in the last 7 days, the page says so in one sentence instead of showing nothing.", who: "heron" },
  ];
  for (const t of tasks) { await A.newTask(page, t); beat("task created", { id: t.id }); await pause(1200); }
  for (const t of tasks) { await A.startTask(page, t.id, t.who); beat("task started", { id: t.id, who: t.who }); await pause(1500); }
  writeFileSync(`${DIR}/take.phase`, "agents working\n");

  // Watch the map; open the first contribution; settle the inbox as it fills; wait for a whole feed outcome.
  let s = await A.until(OBJ, (x) => x.contributions.length >= 1, { label: "first contribution", max: 20 * 60_000 });
  beat("first contribution", { cid: s.contributions[0].id, by: s.contributions[0].author });
  await pause(2000);
  await A.inspect(page, s.contributions[0].id);
  beat("inspector");
  await pause(6000);
  const prefer = (x) => {
    const ready = x.candidates.filter((c) => c.status === "ready" && Object.keys(c.choice ?? {}).includes("feed"));
    const model = x.contributions.filter((c) => c.task === "t_feed-model").map((c) => c.id);
    return ready.find((c) => model.includes(c.choice.feed)) ?? ready[0] ?? null;
  };
  const started = Date.now();
  for (;;) {
    s = await state();
    if (s.inbox.some((i) => i.status === "open" && i.kind !== "accept")) {
      // A decision the UI could not take on camera is not the end of the take: it is logged and left.
      await settleInbox(s).catch((e) => beat("inbox step failed", { error: String(e).slice(0, 200) }));
    }
    if (prefer(s) || Date.now() - started > 35 * 60_000) break;
    await sleep(8000);
  }
  const chosen = prefer(s);
  if (!chosen) throw new Error("no feed outcome became ready in 35 minutes");
  beat("feed outcomes ready", { ready: s.candidates.filter((c) => c.status === "ready").map((c) => c.id), chosen: chosen.id });
  await A.tab(page, "outcomes"); await pause(5000);
  await click(page, page.locator(`[data-cand="${chosen.id}"]`).first()); beat("show on map", { kid: chosen.id }); await pause(4000);
  const preview = page.locator("a.btn", { hasText: "Open preview" }).first();
  if (await preview.count()) { await preview.hover(); beat("preview link"); await pause(2500); }
  await A.accept(page, chosen.id, "The typed model keeps one serializer and its tests parse the feed back, so the next change to the feed has one place to go. The text builder is smaller but every new field means another escape to get right.");
  beat("accepted");
  const before = s.head.version;
  s = await A.until(OBJ, (x) => x.head.version > before, { label: "head moved", max: 5 * 60_000 });
  beat("checkpoint", { version: s.head.version });
  await pause(6000);
  const stream = page.locator("#stream"); await stream.scrollIntoViewIfNeeded(); beat("activity log"); await pause(6000);
  for (let i = 0; i < 40; i++) {
    const r = await fetch("https://beacon.nestagents.dev/incidents.atom").catch(() => null);
    if (r && r.status === 200) break;
    await sleep(6000);
  }
  await page.goto("https://beacon.nestagents.dev/incidents.atom", { waitUntil: "load" }).catch(() => undefined);
  beat("production feed"); await pause(8000);
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" }); await pause(3000);

  // Act 3: context that compounds
  await A.proposeVersion(page, "req/incident-feed", FEED_V2);
  beat("requirement v2");
  const v2at = Date.now();
  await pause(15000);
  s = await A.until(OBJ, (x) => x.candidates.some((c) => c.createdAt && new Date(c.createdAt).getTime() > v2at) || x.tasks.some((t) => t.status === "running" && t.baseCommit), { label: "recompose or repair after v2", max: 8 * 60_000 }).catch(() => state());
  beat("ripple settled", { candidates: s.candidates.map((c) => `${c.id}:${c.status}`) });
  await pause(5000);

  // Act 4: agents mode
  await page.goto(`${ORIGIN}/p/beacon`, { waitUntil: "networkidle" });
  const card = page.getByText("How work is decided").first(); await card.scrollIntoViewIfNeeded(); await pause(2500);
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
  s = await A.until(OBJ, (x) => x.head.version > headBefore || x.inbox.some((i) => i.status === "open" && i.kind === "review" && /human may approve|Only a human/i.test(i.reasons ?? "")), { label: "automatic acceptance or a held change", max: 30 * 60_000 }).catch(() => state());
  beat("agents mode result", { head: s.head.version, headBefore, inbox: s.inbox.filter((i) => i.status === "open").map((i) => `${i.kind}:${i.target}`) });
  await stream.scrollIntoViewIfNeeded(); await pause(8000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await pause(2000);

  // Act 5: an outside agent joins through MCP
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
  beat("end");
} catch (e) {
  beat("ERROR", { error: String(e).slice(0, 500) });
  await page.screenshot({ path: `${DIR}/take-error.png` }).catch(() => undefined);
  throw e;
} finally {
  const v = await rec.close();
  console.log("video", v);
}
