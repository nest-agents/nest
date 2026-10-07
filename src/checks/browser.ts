// The export, as a person does it: a real browser (Browser Rendering) opens the candidate's live preview,
// picks a viewer, clicks Export CSV and waits for the file. The file is judged by the same trusted rules
// as the HTTP checks, so the button only passes if clicking it gives that viewer exactly their export.

import puppeteer from "@cloudflare/puppeteer";
import { exportProblems } from "./harbor";

export type ClickCheck = { id: "export-click"; status: "PASS" | "FAIL" | "ERROR"; detail: string };

const VIEWER = "demo-bob";

export async function exportByClick(
  env: Env,
  previewUrl: string,
  columns: string[],
  /** Fetches a candidate path directly from its container (a Worker cannot fetch its own public URL). */
  refetch: (path: string, viewer: string) => Promise<Response>,
  timeoutMs = 25_000,
): Promise<{ check: ClickCheck; screenshot: Uint8Array | null }> {
  const result = (status: ClickCheck["status"], detail: string): ClickCheck => ({ id: "export-click", status, detail: detail.slice(0, 500) });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    const files: string[] = [];
    const unread: { url: string; headers: Record<string, string> }[] = [];
    page.on("response", async (r) => {
      // Preflights carry no file, and a blob: or data: download replays a response already seen.
      if (r.request().method() === "OPTIONS" || !/^https?:/.test(r.url())) return;
      const type = r.headers()["content-type"] ?? "";
      const attachment = /attachment/i.test(r.headers()["content-disposition"] ?? "");
      if (!type.startsWith("text/csv") && !attachment) return;
      const body = await r.text().catch(() => "");
      // A navigation that becomes a download has no readable body; fetch it again the same way.
      if (body) files.push(body);
      else unread.push({ url: r.url(), headers: r.request().headers() });
    });
    await page.goto(previewUrl, { waitUntil: "networkidle0", timeout: 15_000 });
    if (await page.$("#viewer")) await page.select("#viewer", VIEWER);
    await new Promise((r) => setTimeout(r, 400));
    const button = await page.$('[data-action="export"]');
    if (!button) return { check: result("FAIL", 'no element with data-action="export" to click'), screenshot: await shot(page) };
    await button.click();
    const deadline = Date.now() + timeoutMs;
    while (!files.length && !unread.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    const prefix = new URL(previewUrl).pathname.replace(/\/$/, "");
    for (const u of unread) {
      const url = new URL(u.url);
      if (!url.pathname.startsWith(prefix)) continue;
      const res = await refetch(url.pathname.slice(prefix.length) + url.search, u.headers["x-harbor-viewer"] ?? VIEWER);
      if (res.ok) files.push(await res.text());
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

async function shot(page: { screenshot(o: { type: "png" }): Promise<unknown> }): Promise<Uint8Array | null> {
  try {
    const b = await page.screenshot({ type: "png" });
    return b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  } catch {
    return null;
  }
}
