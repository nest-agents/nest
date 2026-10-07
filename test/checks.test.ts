// The trusted harness must not pre-decide the design: both export styles pass, the baseline fails
// only on export checks, and a requirement change fails both until they are repaired.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "checks/harbor-checks.mjs");
const V1 = ["id", "title", "status", "internal_notes"];
const V2 = ["id", "title", "status"];

const CSV = `
const COLUMNS = __COLUMNS__;
const cell = (v) => { const s = String(v ?? ""); return /[",\\r\\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; };
export const toCsv = (rows) => [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\\r\\n") + "\\r\\n";
`;
const BUTTON = `<div id="actions"><button data-action="export">Export CSV</button></div>`;

const DIRECT = `
import { isViewer, issuesFor } from "./data.ts";
import { PAGE } from "./ui.ts";
import { toCsv } from "./csv.ts";
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
    const viewer = request.headers.get("x-harbor-viewer");
    if (!isViewer(viewer)) return json({ error: "viewer" }, 401);
    if (url.pathname === "/api/issues") return json(issuesFor(viewer).map(({ id, title, status, assignee }) => ({ id, title, status, assignee })));
    if (request.method === "POST" && url.pathname === "/api/exports") return new Response(toCsv(issuesFor(viewer)), { headers: { "content-type": "text/csv; charset=utf-8" } });
    return json({ error: "Not found" }, 404);
  },
};`;

const JOBS = `
import { isViewer, issuesFor } from "./data.ts";
import { PAGE } from "./ui.ts";
import { toCsv } from "./csv.ts";
const jobs = new Map();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
    const viewer = request.headers.get("x-harbor-viewer");
    if (!isViewer(viewer)) return json({ error: "viewer" }, 401);
    if (url.pathname === "/api/issues") return json(issuesFor(viewer).map(({ id, title, status, assignee }) => ({ id, title, status, assignee })));
    if (request.method === "POST" && url.pathname === "/api/exports") {
      const id = crypto.randomUUID();
      jobs.set(id, { viewer, state: "queued" });
      setTimeout(() => jobs.set(id, { viewer, state: "ready", file: toCsv(issuesFor(viewer)) }), 30);
      return json({ id, status_url: "/api/exports/" + id }, 202);
    }
    const m = /^\\/api\\/exports\\/([0-9a-f-]+)(\\/file)?$/.exec(url.pathname);
    const job = m && jobs.get(m[1]);
    if (!job || job.viewer !== viewer) return json({ error: "Not found" }, 404);
    if (m[2]) return job.state === "ready" ? new Response(job.file, { headers: { "content-type": "text/csv" } }) : json({ error: "not ready" }, 409);
    return json({ state: job.state, ...(job.state === "ready" ? { download_url: "/api/exports/" + m[1] + "/file" } : {}) });
  },
};`;

async function candidate(index?: string, columns: string[] = V1) {
  const dir = await mkdtemp(join(tmpdir(), "nest-harbor-"));
  await cp(join(ROOT, "harbor"), dir, { recursive: true });
  if (index) {
    await writeFile(join(dir, "src/index.ts"), index);
    await writeFile(join(dir, "src/csv.ts"), CSV.replace("__COLUMNS__", JSON.stringify(columns)));
    const ui = await readFile(join(dir, "src/ui.ts"), "utf8");
    await writeFile(join(dir, "src/ui.ts"), ui.replace('<div id="actions"></div>', BUTTON));
  }
  return dir;
}

async function check(dir: string, columns: string[]) {
  const dataSha256 = createHash("sha256").update(await readFile(join(ROOT, "harbor/src/data.ts"))).digest("hex");
  const { stdout } = await run("node", [HARNESS, dir, JSON.stringify({ columns, dataSha256 })], { timeout: 30_000 });
  const out = JSON.parse(stdout) as { checks: { id: string; status: string; detail: string }[] };
  return Object.fromEntries(out.checks.map((c) => [c.id, c.status]));
}

const ALL_PASS = { "fixture-integrity": "PASS", "viewer-scope": "PASS", "export-api": "PASS", "export-columns": "PASS", "csv-format": "PASS", "export-ui": "PASS" };

describe("trusted Harbor checks", () => {
  it("fail the unfinished baseline only on export checks", async () => {
    expect(await check(await candidate(), V1)).toEqual({ ...ALL_PASS, "export-api": "FAIL", "export-columns": "FAIL", "csv-format": "FAIL", "export-ui": "FAIL" });
  });
  it("pass a direct export and a background job export alike", async () => {
    expect(await check(await candidate(DIRECT), V1)).toEqual(ALL_PASS);
    expect(await check(await candidate(JOBS), V1)).toEqual(ALL_PASS);
  });
  it("fail both under a new column requirement until they are repaired", async () => {
    expect((await check(await candidate(DIRECT), V2))["export-columns"]).toBe("FAIL");
    expect((await check(await candidate(JOBS), V2))["export-columns"]).toBe("FAIL");
    expect(await check(await candidate(JOBS, V2), V2)).toEqual(ALL_PASS);
  });
  it("catch a changed fixture file", async () => {
    const dir = await candidate(DIRECT);
    await writeFile(join(dir, "src/data.ts"), (await readFile(join(dir, "src/data.ts"), "utf8")) + "\n// tampered\n");
    expect((await check(dir, V1))["fixture-integrity"]).toBe("FAIL");
  });
}, 60_000);
