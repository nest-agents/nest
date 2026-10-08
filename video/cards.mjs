// Full-frame cards (the lead-in, the stack, the close) rendered as 1920×1080 PNGs in the product's own
// typography: paper, ink, one blue. Usage: node cards.mjs plan.json outDir
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [planPath, outDir] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const css = `
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1920px; height: 1080px; background: #f1f3f5; color: #111316; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .dark { background: #111316; color: #f1f3f5; }
  .page { position: absolute; inset: 0; padding: 120px 140px; display: flex; flex-direction: column; }
  .k { font-family: "SF Mono", Menlo, monospace; font-size: 18px; letter-spacing: .16em; text-transform: uppercase; color: #1833eb; }
  .dark .k { color: #8e9cff; }
  .wordmark { font-size: 200px; letter-spacing: .14em; font-weight: 500; line-height: 1; margin-top: 170px; }
  .wordmark small { display: block; font-size: 26px; letter-spacing: .32em; font-weight: 400; margin-top: 26px; color: #4b5058; }
  .dark .wordmark small { color: #9aa0ab; }
  .tag { margin-top: 70px; font-size: 44px; letter-spacing: -.02em; max-width: 1400px; line-height: 1.2; }
  .tag b { color: #1833eb; font-weight: 500; }
  .dark .tag b { color: #8e9cff; }
  h1 { font-size: 92px; letter-spacing: -.035em; font-weight: 700; line-height: 1.02; margin-top: 28px; max-width: 1500px; }
  h1 span { color: #1833eb; } .dark h1 span { color: #8e9cff; }
  .rows { margin-top: 64px; display: grid; gap: 0; border-top: 1px solid #111316; }
  .dark .rows { border-color: #f1f3f5; }
  .row { display: grid; grid-template-columns: 90px 520px 1fr; gap: 40px; padding: 30px 0; border-bottom: 1px solid #c9cdd6; align-items: baseline; }
  .dark .row { border-color: #2a2f38; }
  .row .n { font-family: "SF Mono", Menlo, monospace; font-size: 20px; color: #1833eb; } .dark .row .n { color: #8e9cff; }
  .row .t { font-size: 38px; font-weight: 500; letter-spacing: -.02em; }
  .row .d { font-size: 28px; color: #4b5058; line-height: 1.35; } .dark .row .d { color: #b6bbc6; }
  .grid { margin-top: 56px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px 64px; }
  .svc { display: grid; grid-template-columns: 330px 1fr; gap: 24px; padding: 16px 0; border-bottom: 1px solid #2a2f38; align-items: baseline; }
  .svc .t { font-size: 30px; font-weight: 500; letter-spacing: -.01em; }
  .svc .d { font-size: 22px; color: #b6bbc6; line-height: 1.3; }
  .foot { margin-top: auto; display: flex; justify-content: space-between; font-family: "SF Mono", Menlo, monospace; font-size: 18px; letter-spacing: .08em; color: #4b5058; }
  .dark .foot { color: #9aa0ab; }
  .big { font-size: 72px; letter-spacing: -.03em; font-weight: 700; line-height: 1.08; margin-top: 60px; max-width: 1500px; }
  .big span { color: #8e9cff; }
  .url { margin-top: 40px; font-family: "SF Mono", Menlo, monospace; font-size: 34px; color: #8e9cff; line-height: 1.6; }
`;
const render = (c) => {
  const dark = c.dark ? " dark" : "";
  if (c.kind === "logo") return `<div class="page${dark}"><div class="k">${esc(c.kicker ?? "Build the next GitHub")}</div><div class="wordmark">NEST<small>AGENTS AND HUMANS</small></div><div class="tag">${c.tag}</div><div class="foot"><span>nestagents.dev</span><span>${esc(c.foot ?? "")}</span></div></div>`;
  if (c.kind === "rows") return `<div class="page${dark}"><div class="k">${esc(c.kicker ?? "")}</div><h1>${c.title}</h1><div class="rows">${c.rows.map((r, i) => `<div class="row"><div class="n">${String(i + 1).padStart(2, "0")}</div><div class="t">${esc(r[0])}</div><div class="d">${esc(r[1])}</div></div>`).join("")}</div><div class="foot"><span>nestagents.dev</span><span>${esc(c.foot ?? "")}</span></div></div>`;
  if (c.kind === "stack") return `<div class="page${dark}"><div class="k">${esc(c.kicker ?? "")}</div><h1>${c.title}</h1><div class="grid">${c.services.map((s) => `<div class="svc"><div class="t">${esc(s[0])}</div><div class="d">${esc(s[1])}</div></div>`).join("")}</div><div class="foot"><span>nestagents.dev</span><span>${esc(c.foot ?? "")}</span></div></div>`;
  if (c.kind === "close") return `<div class="page${dark}"><div class="k">${esc(c.kicker ?? "")}</div><div class="big">${c.title}</div><div class="url">${c.lines.map(esc).join("<br>")}</div><div class="foot"><span>${esc(c.foot ?? "")}</span><span></span></div></div>`;
  throw new Error(`unknown card ${c.kind}`);
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const files = {};
for (const [i, seg] of plan.segments.entries()) {
  if (!seg.card) continue;
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${render(seg.card)}</body></html>`);
  const file = `${outDir}/card${String(i).padStart(2, "0")}.png`;
  await page.screenshot({ path: file, type: "png" });
  files[i] = file;
}
await browser.close();
writeFileSync(`${outDir}/index.json`, JSON.stringify(files, null, 2));
console.log("cards", Object.keys(files).length);
