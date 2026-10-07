// Minimal unified diff for review prompts and the UI. Line-based LCS, three lines of context.

export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return "";
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  const header = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n`;
  if (a.length * b.length > 4_000_000) return `${header}@@ file too large to diff (${a.length} -> ${b.length} lines) @@\n`;
  const n = a.length, m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
  const ops: { t: " " | "-" | "+"; s: string; ai: number; bi: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: " ", s: a[i]!, ai: i, bi: j }); i++; j++; }
    else if (j < m && (i === n || dp[i * (m + 1) + j + 1]! >= dp[(i + 1) * (m + 1) + j]!)) { ops.push({ t: "+", s: b[j]!, ai: i, bi: j }); j++; }
    else { ops.push({ t: "-", s: a[i]!, ai: i, bi: j }); i++; }
  }
  const out: string[] = [header];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.t === " ") k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= context * 2) {
      quiet = ops[end]!.t === " " ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end - Math.max(0, quiet - context));
    const slice = ops.slice(start, end);
    const aStart = slice[0]!.ai + 1, bStart = slice[0]!.bi + 1;
    const aLen = slice.filter((o) => o.t !== "+").length, bLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@\n${slice.map((o) => `${o.t}${o.s}`).join("\n")}\n`);
    k = end;
  }
  return out.join("");
}
