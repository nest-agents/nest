// The export, as a human does it: a real browser (Browser Rendering) opens the candidate's live preview,
// picks a viewer, clicks Export CSV and waits for the file. The file is judged by the same trusted rules
// as the HTTP checks, so the button only passes if clicking it gives that viewer exactly their export.

import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { exportProblems } from "./harbor";

export type ClickCheck = { id: "export-click"; status: "PASS" | "FAIL" | "ERROR"; detail: string };

const VIEWER = "demo-bob";
// Candidate code chooses what it serves, so everything the check buffers is bounded.
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 8;

export async function exportByClick(
  env: Env,
  previewUrl: string,
  columns: string[],
  /** Fetches a candidate path directly from its container (a Worker cannot fetch its own public URL). */
  refetch: (path: string, viewer: string, method: string) => Promise<Response>,
  timeoutMs = 25_000,
): Promise<{ check: ClickCheck; screenshot: Uint8Array | null }> {
  const result = (status: ClickCheck["status"], detail: string): ClickCheck => ({ id: "export-click", status, detail: detail.slice(0, 500) });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 520, deviceScaleFactor: 2 });
    // The browser only tells us which request the click produced. Bodies are never read through the
    // browser (that would buffer whatever the candidate sends); the same request is replayed through the
    // container with a streaming cap, and that file is judged.
    const seen: { url: string; method: string; viewer: string }[] = [];
    page.on("response", (r) => {
      // Preflights carry no file, and a blob: or data: download replays a response already seen.
      if (r.request().method() === "OPTIONS" || !/^https?:/.test(r.url())) return;
      const type = r.headers()["content-type"] ?? "";
      const attachment = /attachment/i.test(r.headers()["content-disposition"] ?? "");
      if ((!type.startsWith("text/csv") && !attachment) || seen.length >= MAX_FILES) return;
      seen.push({ url: r.url(), method: r.request().method(), viewer: r.request().headers()["x-harbor-viewer"] ?? VIEWER });
    });
    await page.goto(previewUrl, { waitUntil: "networkidle0", timeout: 15_000 });
    if (await page.$("#viewer")) await page.select("#viewer", VIEWER);
    await new Promise((r) => setTimeout(r, 400));
    const button = await page.$('[data-action="export"]');
    if (!button) return { check: result("FAIL", 'no element with data-action="export" to click'), screenshot: await shot(page) };
    await button.click();
    const deadline = Date.now() + timeoutMs;
    while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    const prefix = new URL(previewUrl).pathname.replace(/\/$/, "");
    const files: string[] = [];
    for (const u of seen.slice(-2)) {
      const url = new URL(u.url);
      if (!url.pathname.startsWith(prefix) || !["GET", "POST"].includes(u.method)) continue;
      if (u.viewer !== VIEWER) { files.push(""); continue; }
      const res = await refetch(url.pathname.slice(prefix.length) + url.search, VIEWER, u.method);
      if (res.ok) files.push(await readCapped(res, MAX_FILE_BYTES));
      else await res.body?.cancel();
    }
    await new Promise((r) => setTimeout(r, 300));
    const screenshot = await shot(page);
    if (!files.length) return { check: result("FAIL", `clicking Export CSV as ${VIEWER} produced no CSV within ${Math.round(timeoutMs / 1000)} s`), screenshot };
    const p = exportProblems(VIEWER, files.at(-1)!, columns);
    const problems = [...p.columns, ...p.format];
    return {
      check: result(problems.length ? "FAIL" : "PASS", problems.length ? `the file from the button: ${problems.slice(0, 3).join("; ")}` : `clicking Export CSV as ${VIEWER} downloads exactly their issues`),
      screenshot,
    };
  } catch (e) {
    return { check: result("ERROR", `browser: ${String((e as Error)?.message ?? e)}`), screenshot: null };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) { const part = c.subarray(0, all.length - at); all.set(part, at); at += part.length; if (at >= all.length) break; }
  return new TextDecoder().decode(all);
}

/** The page's own content, not the empty viewport around it, so the card shows something readable. */
async function shot(page: Page): Promise<Uint8Array | null> {
  try {
    // A candidate can make its page arbitrarily tall, so the capture is clipped to two screens.
    const el = (await page.$("main")) ?? (await page.$("body"));
    const box = el ? await el.boundingBox() : null;
    const b = box
      ? await page.screenshot({ type: "png", clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 720), height: Math.min(Math.max(box.height, 1), 1040) } })
      : await page.screenshot({ type: "png" });
    return b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  } catch {
    return null;
  }
}
