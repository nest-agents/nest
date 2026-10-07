// Wire-level contracts shared by the Worker, the Durable Objects and the sandbox CLI.
// Agents publish with plain git: a commit plus "Nest-*" trailers is a contribution.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Deterministic JSON: sorted keys, no undefined, finite numbers only. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  throw new Error(`canonical: unsupported ${typeof value}`);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const digestOf = (value: unknown) => sha256Hex(canonical(value));

/** A contribution's id is derived from where its commit lives; the commit hash alone could appear in many forks. */
export async function contributionId(namespace: string, repo: string, commit: string): Promise<string> {
  return `c_${(await sha256Hex(`${namespace}/${repo}@${commit}`)).slice(0, 12)}`;
}

export const SHA1 = /^[0-9a-f]{40}$/;

export type Citation = { item: string; version: number; lines?: [number, number] };

/** "req/export-columns@v2#L3-7" -> { item, version: 2, lines: [3, 7] } */
export function parseCitation(text: string): Citation | null {
  const m = /^([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*)@v(\d+)(?:#L(\d+)(?:-L?(\d+))?)?$/i.exec(text.trim());
  if (!m) return null;
  const version = Number(m[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const item = m[1]!.toLowerCase();
  if (!m[3]) return { item, version };
  const start = Number(m[3]);
  const end = m[4] ? Number(m[4]) : start;
  return start >= 1 && end >= start ? { item, version, lines: [start, end] } : null;
}

export const formatCitation = (c: Citation) =>
  `${c.item}@v${c.version}${c.lines ? `#L${c.lines[0]}${c.lines[1] !== c.lines[0] ? `-${c.lines[1]}` : ""}` : ""}`;

export type Trailers = {
  task?: string;
  attempt?: { task: string; epoch: number };
  requires: string[];
  alternative?: string;
  cites: Citation[];
  assumes: string[];
  supersedes?: string;
  invalid: string[];
};

const LIST = /[\s,]+/;

/**
 * Reads the final trailer block of a commit message. Unknown Nest-* keys and malformed
 * values are reported in `invalid` rather than silently dropped.
 */
export function parseTrailers(message: string): Trailers {
  const out: Trailers = { requires: [], cites: [], assumes: [], invalid: [] };
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]! : "";
  for (const raw of last.split("\n")) {
    const m = /^(Nest-[A-Za-z]+):\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    switch (key) {
      case "nest-task":
        if (/^t_[a-z0-9-]{1,48}$/.test(value)) out.task = value;
        else out.invalid.push(raw);
        break;
      case "nest-attempt": {
        const a = /^(t_[a-z0-9-]{1,48})\/e(\d{1,6})$/.exec(value);
        if (a) out.attempt = { task: a[1]!, epoch: Number(a[2]) };
        else out.invalid.push(raw);
        break;
      }
      case "nest-requires":
        for (const id of value.split(LIST).filter(Boolean)) {
          if (/^c_[0-9a-f]{12}$/.test(id)) out.requires.push(id);
          else out.invalid.push(`Nest-Requires: ${id}`);
        }
        break;
      case "nest-alternative":
        if (/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) out.alternative = value;
        else out.invalid.push(raw);
        break;
      case "nest-cites":
        for (const c of value.split(/,\s*/).filter(Boolean)) {
          const parsed = parseCitation(c);
          if (parsed) out.cites.push(parsed);
          else out.invalid.push(`Nest-Cites: ${c}`);
        }
        break;
      case "nest-assumes":
        if (value) out.assumes.push(value.slice(0, 400));
        break;
      case "nest-supersedes":
        if (/^c_[0-9a-f]{12}$/.test(value)) out.supersedes = value;
        else out.invalid.push(raw);
        break;
      default:
        out.invalid.push(raw);
    }
  }
  out.requires = [...new Set(out.requires)].sort();
  return out;
}

export function subjectLine(message: string): string {
  return (message.split("\n")[0] ?? "").trim().slice(0, 200);
}

export type ParticipantKind = "person" | "agent";
export type Verdict = "approve" | "changes" | "block" | "comment";
export const CHECK_STATUSES = ["PASS", "FAIL", "ERROR", "TIMEOUT", "SKIP"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
