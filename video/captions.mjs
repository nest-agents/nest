// Renders each segment's overlay (title card, caption bar, speed badge) as a transparent 1920×1080 PNG with
// the product's own typography, so the cut needs only ffmpeg's overlay filter.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [planPath, outDir] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const css = `
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1920px; height: 1080px; background: transparent; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #f1f3f5; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(17,19,22,.88); padding: 26px 64px 30px; font-size: 31px; line-height: 1.32; letter-spacing: -.005em; max-width: 1920px; }
  .bar p { max-width: 1680px; }
  .bar.top { bottom: auto; top: 0; padding-top: 30px; }
  .badge { position: absolute; top: 34px; right: 48px; background: #1833eb; color: #f1f3f5; font-weight: 700; font-size: 30px; padding: 8px 16px; border-radius: 4px; letter-spacing: .02em; }
  .card { position: absolute; inset: 0; background: rgba(17,19,22,.84); padding: 0 96px; display: flex; flex-direction: column; justify-content: center; }
  .card h1 { font-size: 84px; letter-spacing: -.035em; font-weight: 700; line-height: 1; }
  .card h1 span { color: #8e9cff; }
  .card p { margin-top: 22px; font-size: 32px; color: #c9cdd6; max-width: 1200px; line-height: 1.3; }
  .card .k { font-family: "SF Mono", Menlo, monospace; font-size: 15px; letter-spacing: .14em; text-transform: uppercase; color: #8e9cff; margin-bottom: 22px; }
`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const files = [];
for (const [i, seg] of plan.segments.entries()) {
  const parts = [];
  if (seg.caption) parts.push(`<div class="bar${seg.position === "top" ? " top" : ""}"><p>${esc(seg.caption)}</p></div>`);
  if ((seg.speed ?? 1) > 1) parts.push(`<div class="badge">${esc(seg.speed)}×</div>`);
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${parts.join("")}</body></html>`);
  const bar = `${outDir}/seg${String(i).padStart(2, "0")}-bar.png`;
  await page.screenshot({ path: bar, omitBackground: true, type: "png" });
  let card = null;
  if (seg.title) {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="card"><div class="k">${esc(seg.kicker ?? "Nest")}</div><h1>${esc(seg.title)}<span>.</span></h1>${seg.subtitle ? `<p>${esc(seg.subtitle)}</p>` : ""}</div></body></html>`);
    card = `${outDir}/seg${String(i).padStart(2, "0")}-card.png`;
    await page.screenshot({ path: card, omitBackground: true, type: "png" });
  }
  files.push({ bar, card });
}
await browser.close();
writeFileSync(`${outDir}/index.json`, JSON.stringify(files, null, 2));
console.log("overlays", files.length);
