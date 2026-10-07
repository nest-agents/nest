// Throughput swarm: N synthetic contributors push real commits to their own Artifacts forks at once.
// Every push goes through the real Artifacts event trigger, ingest Workflow and Durable Object.
//
//   NEST_URL=https://nest.<subdomain>.workers.dev node scripts/swarm.mjs <count> [concurrency]
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const URL_ = process.env.NEST_URL;
const COUNT = Number(process.argv[2] ?? 50);
const CONCURRENCY = Number(process.argv[3] ?? 25);
const NAME = `swarm-${Date.now().toString(36)}`;
const TOKEN = (await readFile(join(homedir(), ".secrets/nest_owner_token"), "utf8")).trim();
const api = async (path, init = {}) => {
  const res = await fetch(`${URL_}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

console.log(`preparing ${COUNT} contributors in ${NAME}`);
const t0 = Date.now();
const contributors = [];
let base = null;
for (let offset = 0; offset < COUNT; offset += 25) {
  const r = await api("/api/admin/swarm", { method: "POST", body: JSON.stringify({ name: NAME, count: Math.min(25, COUNT - offset), offset }) });
  base = r.base;
  contributors.push(...r.contributors);
}
console.log(`  ${contributors.length} real forks and scoped tokens in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const dir = await mkdtemp(join(tmpdir(), "nest-swarm-"));
const git = (args, opts = {}) => run("git", args, { cwd: dir, maxBuffer: 16 * 1024 * 1024, ...opts });
const first = contributors[0];
await git(["-c", `http.extraHeader=Authorization: Bearer ${first.token}`, "clone", "-q", first.remote, "."]);
const baseTree = (await git(["rev-parse", `${base}^{tree}`])).stdout.trim();
const env = { ...process.env, GIT_INDEX_FILE: join(dir, ".git/swarm-index"), GIT_AUTHOR_NAME: "Swarm", GIT_AUTHOR_EMAIL: "swarm@nest.invalid", GIT_COMMITTER_NAME: "Swarm", GIT_COMMITTER_EMAIL: "swarm@nest.invalid" };
for (const c of contributors) {
  await git(["read-tree", baseTree], { env });
  const blob = (await run("bash", ["-c", `printf '%s\\n' "$1" | git hash-object -w --stdin`, "_", `contribution from ${c.task}`], { cwd: dir })).stdout.trim();
  await git(["update-index", "--add", "--cacheinfo", `100644,${blob},swarm/${c.task}.md`], { env });
  const tree = (await git(["write-tree"], { env })).stdout.trim();
  const msg = `Swarm contribution ${c.task}\n\nNest-Task: ${c.task}\nNest-Attempt: ${c.task}/e${c.epoch}`;
  c.commit = (await git(["commit-tree", tree, "-p", base, "-m", msg], { env })).stdout.trim();
}
console.log(`  ${contributors.length} commits built locally`);

const pushStart = Date.now();
let next = 0;
const failures = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < contributors.length) {
    const c = contributors[next++];
    try {
      await git(["-c", `http.extraHeader=Authorization: Bearer ${c.token}`, "push", "-q", c.remote, `${c.commit}:refs/heads/main`]);
      c.pushedAt = Date.now();
    } catch (e) {
      failures.push({ task: c.task, error: String(e.stderr ?? e).slice(0, 200) });
    }
  }
}));
const pushEnd = Date.now();
console.log(`  ${contributors.length - failures.length} pushes in ${((pushEnd - pushStart) / 1000).toFixed(1)} s with concurrency ${CONCURRENCY}${failures.length ? `, ${failures.length} failed` : ""}`);

const byTask = new Map(contributors.map((c) => [c.task, c]));
let regs = [];
const deadline = Date.now() + 6 * 60_000;
while (Date.now() < deadline) {
  regs = await api(`/api/admin/swarm/${NAME}`);
  if (regs.length >= contributors.length - failures.length) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const lat = regs.map((r) => Date.parse(r.createdAt) - (byTask.get(r.task)?.pushedAt ?? pushEnd)).filter(Number.isFinite).sort((a, b) => a - b);
const q = (p) => (lat.length ? (lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] / 1000).toFixed(1) : "-");
const firstReg = Math.min(...regs.map((r) => Date.parse(r.createdAt)));
const lastReg = Math.max(...regs.map((r) => Date.parse(r.createdAt)));
const summary = {
  objective: NAME, contributors: contributors.length, pushed: contributors.length - failures.length, registered: regs.length,
  lost: contributors.length - failures.length - regs.length,
  pushSeconds: +((pushEnd - pushStart) / 1000).toFixed(1),
  pushToRegistered: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
  registrationsPerSecond: regs.length > 1 ? +(regs.length / ((lastReg - firstReg) / 1000)).toFixed(1) : null,
  failures: failures.slice(0, 5),
};
console.log(JSON.stringify(summary, null, 2));
await rm(dir, { recursive: true, force: true });
