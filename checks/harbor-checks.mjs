// Trusted checks for Harbor. Runs inside a network-disabled container against the assembled
// candidate tree. Agents cannot edit this file. It accepts either export design allowed by
// req/export-api: a direct CSV response, or a job with a status URL.
//
//   node harbor-checks.mjs <candidate-dir> '<policy-json>'
//   policy: { "columns": [...], "dataSha256": "<hex>" }

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, policyText] = process.argv.slice(2);
const policy = JSON.parse(policyText ?? "{}");
const startedAt = new Date().toISOString();
const checks = [];
const record = (id, status, detail) => checks.push({ id, status, detail: String(detail).slice(0, 600) });

// Trusted copy of the fixture: who may see what, and the exact field values.
const ISSUES = [
  { id: "H-1", title: "Login page loads slowly", status: "open", internal_notes: "Customer escalated twice", visibleTo: ["demo-alice"] },
  { id: "H-2", title: 'Support "smart quotes" in titles', status: "in_progress", internal_notes: "Blocked on font licence", visibleTo: ["demo-alice"] },
  { id: "H-3", title: "Billing, invoices and receipts", status: "done", internal_notes: "Refund issued, see ticket 4411", visibleTo: ["demo-alice", "demo-bob"] },
  { id: "H-4", title: "Add status filter", status: "open", internal_notes: "Waiting on design", visibleTo: ["demo-bob"] },
  { id: "H-5", title: "Improve keyboard navigation", status: "done", internal_notes: "Shipped in 2.3", visibleTo: ["demo-bob"] },
  { id: "H-6", title: "Two-line title\nsecond line", status: "open", internal_notes: "Imported from legacy tracker", visibleTo: ["demo-bob"] },
];
const VIEWERS = ["demo-alice", "demo-bob"];
const visible = (v) => ISSUES.filter((i) => i.visibleTo.includes(v));

/** Strict RFC 4180 parser: CRLF record separators, quoted fields, doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') {
      if (field !== "") throw new Error(`quote inside unquoted field at offset ${i}`);
      quoted = true; i++; continue;
    }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") {
      if (text[i + 1] !== "\n") throw new Error(`bare CR at offset ${i}`);
      row.push(field); rows.push(row); row = []; field = ""; i += 2; continue;
    }
    if (ch === "\n") throw new Error(`bare LF record separator at offset ${i}`);
    field += ch; i++;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let app;
  try {
    const data = await readFile(join(dir, "src/data.ts"));
    const digest = createHash("sha256").update(data).digest("hex");
    record("fixture-integrity", digest === policy.dataSha256 ? "PASS" : "FAIL",
      digest === policy.dataSha256 ? "src/data.ts unchanged" : `src/data.ts changed (sha256 ${digest.slice(0, 12)})`);
    app = (await import(pathToFileURL(join(dir, "src/index.ts")).href)).default;
    if (typeof app?.fetch !== "function") throw new Error("src/index.ts must default-export { fetch }");
  } catch (e) {
    for (const id of ["fixture-integrity", "viewer-scope", "export-api", "export-columns", "csv-format", "export-ui"])
      if (!checks.some((c) => c.id === id)) record(id, "ERROR", `candidate failed to load: ${e.message}`);
    return;
  }
  const call = (path, viewer, method = "GET") =>
    app.fetch(new Request(new URL(path, "https://harbor.check"), { method, headers: viewer ? { "x-harbor-viewer": viewer } : {} }));

  // viewer-scope
  try {
    const problems = [];
    for (const v of VIEWERS) {
      const res = await call("/api/issues", v);
      const ids = (await res.json()).map((i) => i.id);
      const want = visible(v).map((i) => i.id);
      if (JSON.stringify(ids) !== JSON.stringify(want)) problems.push(`${v} saw ${ids.join(",")}; expected ${want.join(",")}`);
    }
    record("viewer-scope", problems.length ? "FAIL" : "PASS", problems.join("; ") || "each viewer sees exactly their issues");
  } catch (e) { record("viewer-scope", "ERROR", e.message); }

  // export-api: obtain each viewer's file through either allowed shape, and forbid cross-viewer reads.
  const files = {};
  try {
    const problems = [];
    for (const v of VIEWERS) {
      const res = await call("/api/exports", v, "POST");
      const type = res.headers.get("content-type") ?? "";
      if (res.status === 200 && type.startsWith("text/csv")) { files[v] = await res.text(); continue; }
      if (res.status !== 202) { problems.push(`${v}: POST /api/exports returned ${res.status} ${type}`); continue; }
      const job = await res.json();
      if (typeof job?.status_url !== "string" || typeof job?.id !== "string") { problems.push(`${v}: 202 body lacks id/status_url`); continue; }
      const other = VIEWERS.find((x) => x !== v);
      const peek = await call(job.status_url, other);
      if (peek.status < 400) problems.push(`${other} could read ${v}'s job status (${peek.status})`);
      let state, download;
      for (let n = 0; n < 100; n++) {
        const s = await call(job.status_url, v);
        if (s.status !== 200) { state = `http ${s.status}`; break; }
        const body = await s.json();
        state = body.state;
        if (state === "ready") { download = body.download_url; break; }
        if (state === "failed") break;
        await sleep(50);
      }
      if (state !== "ready" || typeof download !== "string") { problems.push(`${v}: job ended as ${state}`); continue; }
      const theft = await call(download, other);
      if (theft.status < 400) problems.push(`${other} could download ${v}'s export (${theft.status})`);
      const file = await call(download, v);
      if (file.status !== 200 || !(file.headers.get("content-type") ?? "").startsWith("text/csv")) {
        problems.push(`${v}: download returned ${file.status} ${file.headers.get("content-type")}`);
        continue;
      }
      files[v] = await file.text();
    }
    record("export-api", problems.length ? "FAIL" : "PASS", problems.join("; ") || "both viewers exported through the documented contract");
  } catch (e) { record("export-api", "ERROR", e.message); }

  // export-columns and csv-format operate on whatever files were obtained.
  const columns = policy.columns ?? [];
  const colProblems = [], fmtProblems = [];
  for (const v of VIEWERS) {
    const text = files[v];
    if (text === undefined) { colProblems.push(`${v}: no export file`); fmtProblems.push(`${v}: no export file`); continue; }
    let rows;
    try { rows = parseCsv(text); } catch (e) { fmtProblems.push(`${v}: ${e.message}`); continue; }
    const [header, ...body] = rows;
    if (JSON.stringify(header) !== JSON.stringify(columns)) colProblems.push(`${v}: header ${JSON.stringify(header)}; expected ${JSON.stringify(columns)}`);
    const want = visible(v);
    if (body.length !== want.length) colProblems.push(`${v}: ${body.length} rows; expected ${want.length}`);
    for (const [k, issue] of want.entries()) {
      const r = body[k];
      if (!r) break;
      for (const [c, name] of columns.entries())
        if (r[c] !== String(issue[name])) fmtProblems.push(`${v} ${issue.id}.${name}: ${JSON.stringify(r[c])} != ${JSON.stringify(issue[name])}`);
    }
    if (!columns.includes("internal_notes"))
      for (const i of ISSUES) if (text.includes(i.internal_notes)) colProblems.push(`${v}: export leaks internal_notes of ${i.id}`);
  }
  record("export-columns", colProblems.length ? "FAIL" : "PASS", colProblems.join("; ") || `columns ${columns.join(",")}`);
  record("csv-format", fmtProblems.length ? "FAIL" : "PASS", fmtProblems.slice(0, 6).join("; ") || "RFC 4180 with exact field values");

  // export-ui
  try {
    const html = await (await call("/")).text();
    const ok = /data-action=["']export["']/.test(html) && /Export CSV/.test(html);
    record("export-ui", ok ? "PASS" : "FAIL", ok ? "page has the Export CSV button" : 'no element with data-action="export" labelled Export CSV');
  } catch (e) { record("export-ui", "ERROR", e.message); }
}

const deadline = setTimeout(() => {
  for (const id of ["fixture-integrity", "viewer-scope", "export-api", "export-columns", "csv-format", "export-ui"])
    if (!checks.some((c) => c.id === id)) record(id, "TIMEOUT", "check suite exceeded 20 s");
  finish();
}, 20_000);
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  process.stdout.write(JSON.stringify({ checks, startedAt, finishedAt: new Date().toISOString() }) + "\n");
  process.exit(0);
}
main().then(finish, (e) => { record("harness", "ERROR", e.message); finish(); });
