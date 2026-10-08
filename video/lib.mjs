// Recording helpers: a dedicated headless Chrome, a visible cursor drawn in the page, a beat log for the cut.
import { chromium } from "playwright";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export const ORIGIN = "https://nestagents.dev";
export const W = 1600, H = 900;

const CURSOR = `
(() => {
  if (window.__nestCursor) return;
  const c = document.createElement("div");
  c.id = "__cursor";
  c.style.cssText = "position:fixed;z-index:2147483647;left:-40px;top:-40px;width:22px;height:30px;pointer-events:none;transition:left .06s linear,top .06s linear;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))";
  c.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 23 L7.5 18 L11 27 L15 25.5 L11.5 17 L19 17 Z" fill="#111316" stroke="#f1f3f5" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const add = () => { if (document.body && !document.getElementById("__cursor")) document.body.appendChild(c); };
  add(); document.addEventListener("DOMContentLoaded", add);
  window.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
  window.addEventListener("mousedown", () => { c.style.transform = "scale(.85)"; }, true);
  window.addEventListener("mouseup", () => { c.style.transform = ""; }, true);
  window.__nestCursor = true;
})();`;

export async function launch(dir, name) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light",
    recordVideo: { dir: `${dir}/${name}`, size: { width: W, height: H } },
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const beatsFile = `${dir}/${name}.beats.jsonl`;
  writeFileSync(beatsFile, "");
  const beat = (label, extra = {}) => {
    const row = { t: (Date.now() - t0) / 1000, at: new Date().toISOString(), label, ...extra };
    appendFileSync(beatsFile, JSON.stringify(row) + "\n");
    console.log(`[${row.t.toFixed(1).padStart(7)}s] ${label}`);
    return row;
  };
  return { browser, ctx, page, beat, t0, async close() { const v = await page.video().path(); await ctx.close(); await browser.close(); return v; } };
}

/** Moves the cursor like a hand would, then clicks. `target` is a Locator. */
export async function click(page, target, { settle = 350, steps = 24 } = {}) {
  // The page re-renders live as agents work, so an element found a moment ago may be gone by the time it
  // is scrolled to or measured; a locator re-resolves, so the move is simply tried again.
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await target.waitFor({ state: "visible", timeout: 30_000 });
      await target.scrollIntoViewIfNeeded({ timeout: 5000 });
      const box = await target.boundingBox();
      if (!box) throw new Error("not attached");
      const x = box.x + Math.min(box.width - 6, Math.max(6, box.width * 0.4)), y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps });
      await page.waitForTimeout(settle);
      await page.mouse.click(x, y);
      return;
    } catch (e) {
      last = e;
      if (!/not attached|detached|not visible|intercepts/i.test(String(e))) throw e;
      await page.waitForTimeout(600);
    }
  }
  throw last;
}

/** Types at a human pace into a Locator that is already focused by click(). */
export async function type(page, target, text, { cps = 28 } = {}) {
  await click(page, target, { settle: 150 });
  await target.fill("");
  await target.pressSequentially(text, { delay: Math.round(1000 / cps) });
}

export const owner = () => readFileSync("/Users/scott/.secrets/nest_owner_token", "utf8").trim();

/** Signs in through the real button and token prompt, like the human does. */
export async function signIn(page) {
  page.once("dialog", (d) => d.accept(owner()));
  await click(page, page.getByRole("button", { name: /^Sign in/ }));
  await page.getByText(/Signed in/).first().waitFor({ timeout: 15_000 });
}

export const api = async (path, init = {}) => {
  const r = await fetch(`${ORIGIN}/api${path}`, { ...init, headers: { authorization: `Bearer ${owner()}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { status: r.status, text }; }
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits, polling the API, until `pred(state)` holds; keeps the page live meanwhile. */
export async function until(objective, pred, { every = 5000, max = 40 * 60_000, label = "" } = {}) {
  const start = Date.now();
  for (;;) {
    const s = await api(`/o/${objective}`);
    if (pred(s)) return s;
    if (Date.now() - start > max) throw new Error(`timed out waiting: ${label}`);
    await sleep(every);
  }
}
