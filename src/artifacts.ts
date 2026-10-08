// Thin, verifying wrapper over the Artifacts binding. Everything Nest asserts about a commit is read
// back from Artifacts itself: parents, tree, changed paths and file modes.

import { SHA1 } from "./protocol";

export type RepoRef = { name: string; remote: string };
export type CommitFacts = {
  commit: string;
  parents: string[];
  tree: string;
  message: string;
  author: string;
  timestamp?: string;
};
export type ChangedPath = { path: string; mode: string; change: "add" | "modify" | "delete" };


export class ArtifactsClient {
  constructor(private readonly binding: Artifacts) {}

  async ensureRepo(name: string, description: string): Promise<RepoRef> {
    try {
      using repo = await this.binding.get(name);
      const info = await repo.info();
      return { name, remote: info.remote };
    } catch {
      const created = await this.binding.create(name, { description, setDefaultBranch: "main" });
      return { name, remote: created.remote };
    }
  }

  /** Fork with retries on readiness only; the fork itself is issued once. */
  async fork(source: string, target: string, description: string): Promise<RepoRef> {
    using repo = await this.binding.get(source);
    const forked = await repo.fork(target, { description, defaultBranchOnly: true, readOnly: false });
    for (let i = 0; i < 40; i++) {
      try {
        using ready = await this.binding.get(target);
        const info = await ready.info();
        return { name: target, remote: info.remote ?? forked.remote };
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`fork ${target} did not become ready`);
  }

  async token(repoName: string, scope: "read" | "write", ttlSeconds: number): Promise<{ secret: string; expiresAt: string; id: string }> {
    using repo = await this.binding.get(repoName);
    const t = await repo.createToken(scope, Math.max(60, Math.min(ttlSeconds, 3600)));
    // Tokens look like "<secret>?expires=<unix>"; git wants only the secret part.
    return { secret: t.plaintext.split("?expires=")[0]!, expiresAt: t.expiresAt, id: t.id };
  }

  async revoke(repoName: string, tokenOrId: string): Promise<boolean> {
    using repo = await this.binding.get(repoName);
    return repo.revokeToken(tokenOrId);
  }

  async head(repoName: string, ref = "main"): Promise<string | null> {
    using repo = await this.binding.get(repoName);
    const log = await repo.log({ ref, limit: 1 });
    return log[0]?.hash ?? null;
  }

  async commit(repoName: string, sha: string): Promise<CommitFacts | null> {
    if (!SHA1.test(sha)) return null;
    using repo = await this.binding.get(repoName);
    const c = await repo.readCommit(sha);
    if (!c) return null;
    return {
      commit: c.hash,
      parents: c.parents,
      tree: c.treeHash,
      message: c.message,
      author: `${c.author.name} <${c.author.email}>`,
      timestamp: new Date(c.authoredAt * 1000).toISOString(),
    };
  }

  /** First-parent history from `ref`, newest first, stopping at (and excluding) any commit in `stop`. */
  async newCommits(repoName: string, ref: string, stop: Set<string>, max = 50): Promise<string[]> {
    using repo = await this.binding.get(repoName);
    const out: string[] = [];
    for (const c of await repo.log({ ref, limit: max })) {
      if (stop.has(c.hash)) break;
      out.push(c.hash);
    }
    return out;
  }

  /** Exact git paths changed between two trees, recursing only into subtrees that differ. */
  async diffTrees(repoName: string, before: string | null, after: string): Promise<{ paths: ChangedPath[]; special: boolean }> {
    using repo = await this.binding.get(repoName);
    const paths: ChangedPath[] = [];
    let special = false;
    const read = async (hash: string | null) => {
      if (!hash) return new Map<string, ArtifactsTreeEntry>();
      const entries = (await repo.readTree(hash)) ?? [];
      return new Map(entries.map((e) => [e.name, e]));
    };
    const walk = async (a: string | null, b: string | null, prefix: string, depth: number) => {
      if (depth > 32) throw new Error("tree too deep");
      const [left, right] = await Promise.all([read(a), read(b)]);
      for (const name of new Set([...left.keys(), ...right.keys()])) {
        const l = left.get(name);
        const r = right.get(name);
        if (l && r && l.hash === r.hash && l.mode === r.mode) continue;
        const path = prefix + name;
        // A symlink or submodule on either side is special, including one that replaces a directory.
        for (const e of [l, r]) if (e && (e.type === "symlink" || e.type === "gitlink")) special = true;
        const isTree = (e?: ArtifactsTreeEntry) => !!e && e.type === "tree";
        if (isTree(l) || isTree(r)) {
          await walk(isTree(l) ? l!.hash : null, isTree(r) ? r!.hash : null, `${path}/`, depth + 1);
          if (l && !isTree(l)) paths.push({ path, mode: l.mode, change: "delete" });
          if (r && !isTree(r)) paths.push({ path, mode: r.mode, change: "add" });
          continue;
        }
        const entry = (r ?? l)!;
        const mode = entry.mode;
        paths.push({ path, mode, change: !l ? "add" : !r ? "delete" : "modify" });
        if (paths.length > 2000) throw new Error("too many changed paths");
      }
    };
    await walk(before, after, "", 0);
    paths.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return { paths, special };
  }

  async readText(repoName: string, ref: string, path: string, maxBytes = 2_000_000): Promise<string | null> {
    using repo = await this.binding.get(repoName);
    const blob = await repo.readFile({ ref, path });
    if (!blob) return null;
    if (blob.size > maxBytes) throw new Error(`${path} exceeds ${maxBytes} bytes`);
    return await blob.text();
  }

  async listFiles(repoName: string, commit: string, limit = 5000): Promise<{ path: string; hash: string; mode: string }[]> {
    using repo = await this.binding.get(repoName);
    const c = await repo.readCommit(commit);
    if (!c) return [];
    const root = c.treeHash;
    const out: { path: string; hash: string; mode: string }[] = [];
    const walk = async (hash: string, prefix: string) => {
      for (const e of (await repo.readTree(hash)) ?? []) {
        const path = prefix + e.name;
        if (e.type === "tree") await walk(e.hash, `${path}/`);
        else out.push({ path, hash: e.hash, mode: e.mode });
        if (out.length > limit) throw new Error("repository too large to list");
      }
    };
    await walk(root, "");
    return out;
  }
}
