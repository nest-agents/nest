// Trusted checks for Harbor. This module runs in the Nest Worker (or a test process), never next to
// candidate code: it only sees HTTP responses from the candidate's isolated server, so the candidate
// cannot forge a verdict. It accepts either export design allowed by req/export-api.

export type CheckResult = { id: string; status: "PASS" | "FAIL" | "ERROR" | "TIMEOUT"; detail: string };
export type Call = (path: string, viewer: string | null, method?: string) => Promise<Response>;
export type HarborPolicy = { columns: string[]; dataSha256: string };

export const HARBOR_CHECKS = ["fixture-integrity", "viewer-scope", "export-api", "export-columns", "csv-format", "export-ui"] as const;

// Trusted copy of the fixture: who may see what, and the exact field values.
const ISSUES = [
  { id: "H-1", title: "Login page loads slowly", status: "open", internal_notes: "Customer escalated twice", visibleTo: ["demo-alice"] },
  { id: "H-2", title: 'Support "smart quotes" in titles', status: "in_progress", internal_notes: "Blocked on font licence", visibleTo: ["demo-alice"] },
  { id: "H-3", title: "Billing, invoices and receipts", status: "done", internal_notes: "Refund issued, see ticket 4411", visibleTo: ["demo-alice", "demo-bob"] },
  { id: "H-4", title: "Add status filter", status: "open", internal_notes: "Waiting on design", visibleTo: ["demo-bob"] },
  { id: "H-5", title: "Improve keyboard navigation", status: "done", internal_notes: "Shipped in 2.3", visibleTo: ["demo-bob"] },
  { id: "H-6", title: "Two-line title\nsecond line", status: "open", internal_notes: "Imported from legacy tracker", visibleTo: ["demo-bob"] },
] as const;
const VIEWERS = ["demo-alice", "demo-bob"] as const;
const visible = (v: string) => ISSUES.filter((i) => (i.visibleTo as readonly string[]).includes(v));

/** Strict RFC 4180: CRLF record separators, quoted fields, doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: unknown) => String(s).slice(0, 600);

/**
 * @param actualDataSha256 sha256 of src/data.ts read from the candidate's git tree by trusted code.
 */
export async function runHarborChecks(call: Call, policy: HarborPolicy, actualDataSha256: string, budgetMs = 20_000): Promise<CheckResult[]> {
  const results = new Map<string, CheckResult>();
  const record = (id: string, status: CheckResult["status"], detail: unknown) => results.set(id, { id, status, detail: short(detail) });
  const deadline = Date.now() + budgetMs;

  record("fixture-integrity", actualDataSha256 === policy.dataSha256 ? "PASS" : "FAIL",
    actualDataSha256 === policy.dataSha256 ? "src/data.ts unchanged" : `src/data.ts changed (sha256 ${actualDataSha256.slice(0, 12)})`);

  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("TIMEOUT");
    return await Promise.race([fn(), sleep(left).then(() => { throw new Error("TIMEOUT"); })]);
  };
  const fail = (id: string, e: unknown) => record(id, e instanceof Error && e.message === "TIMEOUT" ? "TIMEOUT" : "ERROR", e instanceof Error ? e.message : e);

  try {
    await timed(async () => {
      const problems: string[] = [];
      for (const v of VIEWERS) {
        const res = await call("/api/issues", v);
        const body = (await res.json()) as { id: string }[];
        const ids = Array.isArray(body) ? body.map((i) => i.id) : [];
        const want = visible(v).map((i) => i.id);
        if (JSON.stringify(ids) !== JSON.stringify(want)) problems.push(`${v} saw ${ids.join(",")}; expected ${want.join(",")}`);
      }
      record("viewer-scope", problems.length ? "FAIL" : "PASS", problems.join("; ") || "each viewer sees exactly their issues");
    });
  } catch (e) { fail("viewer-scope", e); }

  const files: Record<string, string> = {};
  try {
    await timed(async () => {
      const problems: string[] = [];
      for (const v of VIEWERS) {
        const other = VIEWERS.find((x) => x !== v)!;
        const res = await call("/api/exports", v, "POST");
        const type = res.headers.get("content-type") ?? "";
        if (res.status === 200 && type.startsWith("text/csv")) { files[v] = await res.text(); continue; }
        if (res.status !== 202) { problems.push(`${v}: POST /api/exports returned ${res.status} ${type}`); continue; }
        const job = (await res.json()) as { id?: unknown; status_url?: unknown };
        if (typeof job?.status_url !== "string" || typeof job?.id !== "string" || !job.status_url.startsWith("/")) {
          problems.push(`${v}: 202 body lacks id or a same-origin status_url`);
          continue;
        }
        const peek = await call(job.status_url, other);
        if (peek.status < 400) problems.push(`${other} could read ${v}'s job status (${peek.status})`);
        let state: unknown;
        let download: unknown;
        for (let n = 0; n < 200; n++) {
          const s = await call(job.status_url, v);
          if (s.status !== 200) { state = `http ${s.status}`; break; }
          const body = (await s.json()) as { state?: unknown; download_url?: unknown };
          state = body.state;
          if (state === "ready") { download = body.download_url; break; }
          if (state === "failed") break;
          await sleep(50);
        }
        if (state !== "ready" || typeof download !== "string" || !download.startsWith("/")) { problems.push(`${v}: job ended as ${String(state)}`); continue; }
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
    });
  } catch (e) { fail("export-api", e); }

  const columns = policy.columns;
  const colProblems: string[] = [];
  const fmtProblems: string[] = [];
  for (const v of VIEWERS) {
    const text = files[v];
    if (text === undefined) { colProblems.push(`${v}: no export file`); fmtProblems.push(`${v}: no export file`); continue; }
    let rows: string[][];
    try { rows = parseCsv(text); } catch (e) { fmtProblems.push(`${v}: ${(e as Error).message}`); continue; }
    const [header, ...body] = rows;
    if (JSON.stringify(header) !== JSON.stringify(columns)) colProblems.push(`${v}: header ${JSON.stringify(header)}; expected ${JSON.stringify(columns)}`);
    const want = visible(v);
    if (body.length !== want.length) colProblems.push(`${v}: ${body.length} rows; expected ${want.length}`);
    want.forEach((issue, k) => {
      const r = body[k];
      if (!r) return;
      columns.forEach((name, c) => {
        const expected = String((issue as Record<string, unknown>)[name] ?? "");
        if (r[c] !== expected) fmtProblems.push(`${v} ${issue.id}.${name}: ${JSON.stringify(r[c])} != ${JSON.stringify(expected)}`);
      });
    });
    if (!columns.includes("internal_notes"))
      for (const i of ISSUES) if (text.includes(i.internal_notes)) colProblems.push(`${v}: export leaks internal_notes of ${i.id}`);
  }
  record("export-columns", colProblems.length ? "FAIL" : "PASS", colProblems.join("; ") || `columns ${columns.join(",")}`);
  record("csv-format", fmtProblems.length ? "FAIL" : "PASS", fmtProblems.slice(0, 6).join("; ") || "RFC 4180 with exact field values");

  try {
    await timed(async () => {
      const html = await (await call("/", null)).text();
      const ok = /data-action=["']export["']/.test(html) && /Export CSV/.test(html);
      record("export-ui", ok ? "PASS" : "FAIL", ok ? "page has the Export CSV button" : 'no element with data-action="export" labelled Export CSV');
    });
  } catch (e) { fail("export-ui", e); }

  return HARBOR_CHECKS.map((id) => results.get(id) ?? { id, status: "ERROR", detail: "check did not run" });
}
