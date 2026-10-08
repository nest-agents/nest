// A project tells Nest how to work with it in `.nest/project.json`, in its own repository. Nest reads it
// from the accepted checkpoint, never from a candidate, so a contribution cannot change the checks that
// judge it (and `.nest/` is a protected path, so changing the file always reaches a human).

export type CheckSpec = { id: string; run: string; timeoutSeconds: number };

export type ProjectConfig = {
  /** Installs dependencies in a fresh checkout, for example "npm ci". */
  setup: string | null;
  /** Commands that must exit 0. Each is a check on every composed outcome and on the checkpoint itself. */
  checks: CheckSpec[];
  /** Where a candidate branch is served, for example "https://{branch}.previews.example.com/". */
  preview: { url: string; path: string } | null;
  /** The live production URL, served from the project's main branch. */
  production: string | null;
  /** Extra paths that always need a human, added to Nest's own floor. */
  protected: string[];
};

export const CONFIG_PATH = ".nest/project.json";

export const EMPTY_CONFIG: ProjectConfig = { setup: null, checks: [], preview: null, production: null, protected: [] };

export class ConfigError extends Error {}

const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) throw new ConfigError(`${field} must be a non-empty string`);
  if (v.length > max) throw new ConfigError(`${field} is longer than ${max} characters`);
  if (/[\u0000-\u0008\u000b-\u001f]/.test(v)) throw new ConfigError(`${field} contains control characters`);
  return v.trim();
};

const httpsUrl = (v: unknown, field: string): string => {
  const s = text(v, field, 300);
  let u: URL;
  try { u = new URL(s.replace("{branch}", "branch")); } catch { throw new ConfigError(`${field} is not a URL`); }
  if (u.protocol !== "https:") throw new ConfigError(`${field} must use https`);
  return s;
};

/** Parses and validates the file. Unknown fields are ignored; anything malformed is an error, not a guess. */
export function parseProjectConfig(raw: string | null): ProjectConfig {
  if (raw === null) return EMPTY_CONFIG;
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch { throw new ConfigError(`${CONFIG_PATH} is not valid JSON`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new ConfigError(`${CONFIG_PATH} must be a JSON object`);

  const checks: CheckSpec[] = [];
  if (j.checks !== undefined) {
    if (!Array.isArray(j.checks)) throw new ConfigError("checks must be a list");
    if (j.checks.length > 8) throw new ConfigError("at most 8 checks");
    for (const [i, c] of j.checks.entries()) {
      const o = (c ?? {}) as Record<string, unknown>;
      const id = text(o.id, `checks[${i}].id`, 32);
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new ConfigError(`checks[${i}].id must be lowercase letters, digits and hyphens`);
      if (checks.some((x) => x.id === id)) throw new ConfigError(`duplicate check id ${id}`);
      if (["compose", "preview", "config"].includes(id)) throw new ConfigError(`check id ${id} is reserved for Nest's own checks`);
      const t = o.timeoutSeconds === undefined ? 300 : Number(o.timeoutSeconds);
      if (!Number.isInteger(t) || t < 10 || t > 900) throw new ConfigError(`checks[${i}].timeoutSeconds must be 10 to 900`);
      checks.push({ id, run: text(o.run, `checks[${i}].run`, 500), timeoutSeconds: t });
    }
  }

  let preview: ProjectConfig["preview"] = null;
  if (j.preview !== undefined && j.preview !== null) {
    const p = j.preview as Record<string, unknown>;
    const url = httpsUrl(p.url, "preview.url");
    if (!url.includes("{branch}")) throw new ConfigError("preview.url must contain {branch}");
    const path = p.path === undefined ? "/" : text(p.path, "preview.path", 200);
    if (!path.startsWith("/")) throw new ConfigError("preview.path must start with /");
    preview = { url, path };
  }

  const protectedPaths: string[] = [];
  if (j.protected !== undefined) {
    if (!Array.isArray(j.protected)) throw new ConfigError("protected must be a list of paths");
    for (const [i, p] of j.protected.slice(0, 50).entries()) protectedPaths.push(text(p, `protected[${i}]`, 200));
  }

  return {
    setup: j.setup === undefined || j.setup === null ? null : text(j.setup, "setup", 500),
    checks,
    preview,
    production: j.production === undefined || j.production === null ? null : httpsUrl(j.production, "production"),
    protected: protectedPaths,
  };
}

/**
 * The checks an outcome must pass to be accepted: a clean composition, the project's own checks, and its
 * preview deployment if it declares one.
 */
export function requiredChecks(config: Pick<ProjectConfig, "checks" | "preview">): string[] {
  return ["compose", ...config.checks.map((c) => c.id), ...(config.preview ? ["preview"] : [])];
}

/** The preview URL for a branch. Branch names Nest pushes are lowercase letters, digits and hyphens. */
export function previewUrl(config: ProjectConfig, branch: string): string | null {
  if (!config.preview || !/^[a-z0-9-]{1,63}$/.test(branch)) return null;
  const base = config.preview.url.replace("{branch}", branch);
  return new URL(config.preview.path, base).toString();
}
