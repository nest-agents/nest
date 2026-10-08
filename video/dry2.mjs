// Second half of the mechanics check, on the objective the first dry run created: start, inspect, review, accept.
import { launch, owner, ORIGIN } from "./lib.mjs";
import * as A from "./acts.mjs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const OBJ = process.argv[2];
if (!OBJ) throw new Error("objective id required");
const rec = await launch(DIR, "dry2");
const { page, beat } = rec;
try {
  await page.goto(`${ORIGIN}/o/${OBJ}`, { waitUntil: "networkidle" });
  await A.signIn(page, owner());
  beat("signed in");
  await A.startTask(page, "t_median", "kestrel");
  beat("task started");
  const s1 = await A.until(OBJ, (s) => s.contributions.length >= 1, { label: "first contribution", max: 15 * 60_000 });
  const cid = s1.contributions[0].id;
  beat("contribution landed", { cid });
  await A.inspect(page, cid);
  beat("inspector open");
  await A.sleep(3000);
  const s2 = await A.until(OBJ, (s) => s.inbox.some((i) => i.status === "open") || s.candidates.some((c) => c.status === "ready"), { label: "inbox or ready", max: 15 * 60_000 });
  const open = s2.inbox.find((i) => i.status === "open" && i.kind === "review");
  if (open) {
    await A.review(page, open.target, "approve", "Dry run: the tests are additive and pass.");
    beat("reviewed as human", { target: open.target });
  }
  const s3 = await A.until(OBJ, (s) => s.candidates.some((c) => c.status === "ready"), { label: "ready outcome", max: 15 * 60_000 });
  const kid = s3.candidates.find((c) => c.status === "ready").id;
  beat("outcome ready", { kid });
  await A.tab(page, "outcomes");
  await A.sleep(3000);
  await A.accept(page, kid, "Dry run: accepting the only outcome.");
  beat("accepted");
  await A.until(OBJ, (s) => s.head.version > s3.head.version, { label: "head moved", max: 3 * 60_000 });
  beat("head moved");
  await A.sleep(4000);
  console.log("activity:", await A.activity(page));
} catch (e) {
  beat("ERROR", { error: String(e).slice(0, 400) });
  await page.screenshot({ path: `${DIR}/dry2-error.png` }).catch(() => undefined);
  throw e;
} finally {
  const v = await rec.close();
  console.log("video", v);
}
