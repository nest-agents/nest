// A real browser (Browser Rendering) opens a candidate's preview deployment the way a human would: it
// loads the page, waits for the network to settle, and records the HTTP status, uncaught page errors and
// console errors, plus a screenshot for the outcome card. It judges only what the browser observed.

import puppeteer, { type Page } from "@cloudflare/puppeteer";

export type SmokeResult = { id: "preview"; status: "PASS" | "FAIL" | "ERROR"; detail: string };

const MAX_ERRORS = 5;

export async function smokeCheck(env: Env, url: string, timeoutMs = 25_000): Promise<{ check: SmokeResult; screenshot: Uint8Array | null }> {
  const result = (status: SmokeResult["status"], detail: string): SmokeResult => ({ id: "preview", status, detail: detail.slice(0, 600) });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 2 });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => { if (pageErrors.length < MAX_ERRORS) pageErrors.push(String((e as Error)?.message ?? e).slice(0, 200)); });
    page.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < MAX_ERRORS) consoleErrors.push(m.text().slice(0, 200)); });
    const response = await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs });
    const status = response?.status() ?? 0;
    await new Promise((r) => setTimeout(r, 300));
    const screenshot = await shot(page);
    if (status === 0 || status >= 400) return { check: result("FAIL", `the preview answered HTTP ${status || "nothing"}`), screenshot };
    if (pageErrors.length) return { check: result("FAIL", `uncaught errors on the page: ${pageErrors.join("; ")}`), screenshot };
    return {
      check: result("PASS", `loads with HTTP ${status}${consoleErrors.length ? `; console errors: ${consoleErrors.join("; ")}` : ", no errors"}`),
      screenshot,
    };
  } catch (e) {
    return { check: result("ERROR", `browser: ${String((e as Error)?.message ?? e)}`), screenshot: null };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/** The page's own content, clipped to two screens, since a page can make itself arbitrarily tall. */
async function shot(page: Page): Promise<Uint8Array | null> {
  try {
    const el = (await page.$("main")) ?? (await page.$("body"));
    const box = el ? await el.boundingBox() : null;
    const b = box
      ? await page.screenshot({ type: "png", clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 1100), height: Math.min(Math.max(box.height, 1), 1520) } })
      : await page.screenshot({ type: "png" });
    return b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  } catch {
    return null;
  }
}
