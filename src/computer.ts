// Computer: one container per task attempt (agents) or per candidate (composition, checks, previews).
// Outbound: the only network path out of any container. It adds credentials outside the sandbox, scopes
// git access per repository, meters every model call against the spend cap, and refuses everything else.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { ArtifactsClient } from "./artifacts";
import { taskToken } from "./auth";
import { candidateBranch, candidateRef, contextRepo, parseWorkspaceRepo, projectRepo, registryStub } from "./names";
import type { CheckSpec } from "./projectconfig";
import { estimateCost, gatewayHeaders, isPriced, priceFor, providerTarget } from "./models";
import { receivePackRefs } from "./gitproto";

/**
 * agent: runs a task attempt; pushes only main of its own workspace.
 * runner: composes one candidate, then runs the project's checks on it; pushes only refs/nest/cand/<id> and,
 *         when every contribution in it is approved, the buildable branch cand-<id>; and loses
 *         all git access once candidate code is running.
 * mirror: fast-forwards the project's main after an acceptance; never runs candidate code.
 * context: commits accepted context versions to the context repo; never runs candidate code.
 */
export type ComputerProps = {
  computer: string;
  role: "agent" | "runner" | "mirror" | "context";
  project: string;
  objective: string;
  task?: string;
  epoch?: number;
  workspace?: string;
  candidate?: string;
  /** Runner only: every contribution in the candidate is approved, so its buildable branch may be pushed. */
  publish?: boolean;
};

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST = { NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA };
const REPO_DIR = "/workspace/repo";
const TASK_DIR = "/workspace/task";
const KEEPALIVE_MS = 60_000;
const INACTIVITY_MS = 30 * 60_000;

const RUN_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;
const ALIVE_SCRIPT = `read -r pid boot <"$1" && [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$pid"`;

export type ExecResult = { exitCode: number; stdout: string; stderr: string };
export type AgentState = { state: "none" | "running" | "lost" | "exited"; exitCode?: number; tail?: string };

export class Computer extends DurableObject<Env> {
  private readonly container: Container;
  private readonly files: Files;
  private setup: Promise<void> | undefined;
  private tokens = new Map<string, { secret: string; expires: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("container binding missing");
    this.container = ctx.container;
    this.files = new Files(this.container);
    if (this.container.running) void ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(INACTIVITY_MS));
  }

  private props(): ComputerProps {
    const p = this.ctx.storage.kv.get<ComputerProps>("props");
    if (!p) throw new Error("computer not configured");
    return p;
  }

  private async start(): Promise<void> {
    if (this.setup && this.container.running) return this.setup;
    this.setup = (async () => {
      const props = this.props();
      if (!this.container.running) {
        this.container.start({
          image: props.role === "agent" ? this.container.images.agent : this.container.images.runner,
          instance: props.role === "agent" ? "standard-2" : "standard-1",
          enableInternet: false,
          labels: { role: props.role, task: props.task ?? "-" },
        });
      }
      const outbound = this.ctx.exports.Outbound({ props });
      await this.container.interceptAllOutboundHttp(outbound);
      await this.container.interceptOutboundHttps("*", outbound);
      await this.container.setInactivityTimeout(INACTIVITY_MS);
    })().catch(async (e) => {
      this.setup = undefined;
      await this.container.destroy().catch(() => undefined);
      throw e;
    });
    return this.setup;
  }

  async exec(cmd: string[], cwd = "/workspace", env: Record<string, string> = {}, timeoutSeconds = 120): Promise<ExecResult> {
    await this.start();
    const p = await this.container.exec(["timeout", "--kill-after=5", String(timeoutSeconds), ...cmd], { cwd, env: { ...TRUST, HOME: "/root", ...env } });
    const out = await p.output();
    const d = new TextDecoder();
    return { exitCode: out.exitCode, stdout: d.decode(out.stdout).slice(-200_000), stderr: d.decode(out.stderr).slice(-50_000) };
  }

  configure(props: ComputerProps): void {
    this.ctx.storage.kv.put("props", props);
  }

  /** Runs a command with `input` on stdin, so untrusted text never becomes part of a shell string. */
  async execWithInput(cmd: string[], input: string, cwd = "/workspace", timeoutSeconds = 120): Promise<ExecResult> {
    await this.start();
    const p = await this.container.exec(["timeout", "--kill-after=5", String(timeoutSeconds), ...cmd], {
      cwd, env: { ...TRUST, HOME: "/root" }, stdin: new Response(input).body!,
    });
    const out = await p.output();
    const d = new TextDecoder();
    return { exitCode: out.exitCode, stdout: d.decode(out.stdout).slice(-50_000), stderr: d.decode(out.stderr).slice(-20_000) };
  }

  private async sh(script: string, cwd = REPO_DIR, timeoutSeconds = 120): Promise<ExecResult> {
    return this.exec(["bash", "-lc", script], cwd, {}, timeoutSeconds);
  }

  /** "host" once candidate code may be running in this container; git access ends there. */
  phase(): "compose" | "host" | "unset" {
    return this.ctx.storage.kv.get<"compose" | "host">("phase") ?? "unset";
  }

  /** Git credentials, cached per repository inside this Durable Object, never inside the container. */
  async gitToken(repo: string, scope: "read" | "write"): Promise<string> {
    const key = `${scope}:${repo}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 60_000) return cached.secret;
    const t = await new ArtifactsClient(this.env.ARTIFACTS).token(repo, scope, 900);
    this.tokens.set(key, { secret: t.secret, expires: Date.now() + 840_000 });
    return t.secret;
  }

  // ---------- agent workspaces ----------

  async prepareAgent(props: ComputerProps, remote: string, identity: { name: string; email: string }): Promise<ExecResult> {
    this.ctx.storage.kv.put("props", props);
    await this.start();
    await this.files.mkdir(TASK_DIR, { recursive: true }).catch(() => undefined);
    const clone = await this.exec(["git", "clone", "--quiet", remote, REPO_DIR]);
    if (clone.exitCode !== 0) return clone;
    return this.sh(
      `git config user.name ${q(identity.name)} && git config user.email ${q(identity.email)} && git remote set-url origin ${q(remote)} && git config push.default current`,
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.start();
    await this.files.writeFile(path, content);
  }

  async startAgent(command: string[], env: Record<string, string>): Promise<"started" | "busy"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.start();
      if ((await this.agentState()).state === "running") return "busy";
      await this.files.remove(TASK_DIR, { recursive: true, force: true }).catch(() => undefined);
      await this.files.mkdir(TASK_DIR, { recursive: true });
      await this.container.exec(["/bin/sh", "-c", RUN_SCRIPT, "agent", TASK_DIR, ...command], {
        cwd: REPO_DIR, env: { ...TRUST, HOME: "/root", ...env }, stdout: "ignore", stderr: "ignore",
      });
      this.ctx.storage.kv.put("agent", "started");
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
      return "started";
    });
  }

  async agentState(): Promise<AgentState> {
    if (!this.container.running) return { state: this.ctx.storage.kv.get("agent") ? "lost" : "none" };
    const code = await this.readText(`${TASK_DIR}/exit-code`);
    const tail = async () => ((await this.readText(`${TASK_DIR}/stderr.log`)) ?? "").slice(-1500);
    if (code !== undefined) return { state: "exited", exitCode: Number.parseInt(code, 10), tail: await tail() };
    const pid = await this.readText(`${TASK_DIR}/pid`);
    if (pid === undefined) return { state: this.ctx.storage.kv.get("agent") ? "running" : "none" };
    const probe = await this.container.exec(["/bin/sh", "-c", ALIVE_SCRIPT, "probe", `${TASK_DIR}/pid`]);
    if ((await probe.output()).exitCode === 0) return { state: "running" };
    const late = await this.readText(`${TASK_DIR}/exit-code`);
    return late !== undefined ? { state: "exited", exitCode: Number.parseInt(late, 10), tail: await tail() } : { state: "lost" };
  }

  async agentOutput(maxBytes = 400_000): Promise<string> {
    return ((await this.readText(`${TASK_DIR}/stdout.log`)) ?? "").slice(-maxBytes);
  }

  /** Stop the agent at once and capture uncommitted work as a patch for whoever resumes. */
  async stopAgent(): Promise<{ uncommitted: string; head: string }> {
    if (!this.container.running) return { uncommitted: "", head: "" };
    await this.sh(`pkill -KILL -f "codex|nest-agent" || true`, "/", 15);
    const diff = await this.sh("git add -A && git diff --cached --binary", REPO_DIR, 30);
    const head = await this.sh("git rev-parse HEAD", REPO_DIR, 15);
    return { uncommitted: diff.stdout.slice(0, 500_000), head: head.stdout.trim() };
  }

  async alarm(): Promise<void> {
    if (!this.container.running) return;
    if ((await this.agentState()).state === "running") await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    else this.ctx.storage.kv.delete("agent");
  }

  async destroy(reason: string): Promise<void> {
    this.tokens.clear();
    this.ctx.storage.kv.delete("phase");
    if (this.container.running) await this.container.destroy(reason);
  }

  // ---------- candidates: composition, checks, previews ----------

  /**
   * Composes a candidate with real git: clone the project at the base commit, then cherry-pick each
   * contribution's commit in dependency order. Cherry-pick merges three ways against the commit's own
   * parent, so independent edits to one file combine and true overlaps stop with exact paths.
   */
  async compose(props: ComputerProps, base: { remote: string; commit: string }, picks: { id: string; remote: string; commit: string }[], branch: string, publish: boolean): Promise<{ ok: true; commit: string; tree: string; published: boolean } | { ok: false; at: string; paths: string[]; detail: string; partial?: string }> {
    const host = `https://${this.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.ARTIFACTS_NAMESPACE}/`;
    const sha = /^[0-9a-f]{40}$/;
    if (!/^cand-[a-z0-9-]{4,64}$/.test(branch) || !props.candidate || branch !== candidateBranch(props.candidate)) throw new Error("invalid candidate branch");
    if (publish !== !!props.publish) throw new Error("publish must match the computer's props");
    const keep = candidateRef(props.candidate);
    for (const r of [base.remote, ...picks.map((p) => p.remote)]) if (!r.startsWith(host) || !/^[A-Za-z0-9._\/:-]+$/.test(r)) throw new Error(`invalid remote ${r}`);
    for (const c of [base.commit, ...picks.map((p) => p.commit)]) if (!sha.test(c)) throw new Error(`invalid commit ${c}`);
    if (this.phase() === "host") {
      // A container that has hosted candidate code is never trusted with git again.
      await this.destroy("recompose in a fresh container");
      this.setup = undefined;
    }
    this.ctx.storage.kv.put("phase", "compose");
    this.ctx.storage.kv.put("props", props);
    await this.start();
    await this.sh(`rm -rf ${REPO_DIR}`, "/workspace");
    const clone = await this.exec(["git", "clone", "--quiet", base.remote, REPO_DIR]);
    if (clone.exitCode !== 0) return { ok: false, at: "clone", paths: [], detail: clone.stderr.slice(-2000) };
    const reset = await this.sh(`git checkout --quiet -B ${q(branch)} ${q(base.commit)} && git config user.name "Nest composer" && git config user.email composer@nest.invalid`);
    if (reset.exitCode !== 0) return { ok: false, at: "base", paths: [], detail: reset.stderr.slice(-2000) };
    for (const p of picks) {
      const fetched = await this.sh(`git fetch --quiet ${q(p.remote)} ${q(p.commit)}`, REPO_DIR, 120);
      if (fetched.exitCode !== 0) return { ok: false, at: p.id, paths: [], detail: `fetch failed: ${fetched.stderr.slice(-1500)}` };
      const picked = await this.sh(`git cherry-pick -x --allow-empty --keep-redundant-commits ${q(p.commit)}`);
      if (picked.exitCode !== 0) {
        const conflicted = await this.sh("git diff --name-only --diff-filter=U");
        await this.sh("git cherry-pick --abort || true");
        // Keep everything that did combine, so a reconcile task can start from exactly this tree.
        const partial = await this.sh(`git push --quiet --force origin HEAD:${keep} && git rev-parse HEAD`, REPO_DIR, 120);
        return {
          ok: false, at: p.id, paths: conflicted.stdout.split("\n").filter(Boolean), detail: (picked.stderr || picked.stdout).slice(-2000),
          partial: partial.exitCode === 0 ? partial.stdout.trim().split("\n").at(-1) : undefined,
        };
      }
    }
    const head = await this.sh("git rev-parse HEAD && git rev-parse HEAD^{tree}");
    const [commit, tree] = head.stdout.trim().split("\n");
    const push = await this.sh(`git push --quiet --force origin HEAD:${keep}`, REPO_DIR, 120);
    if (push.exitCode !== 0) return { ok: false, at: "push", paths: [], detail: push.stderr.slice(-2000) };
    if (publish) {
      const pub = await this.sh(`git push --quiet --force origin HEAD:refs/heads/${branch}`, REPO_DIR, 120);
      if (pub.exitCode !== 0) return { ok: false, at: "push", paths: [], detail: pub.stderr.slice(-2000) };
    }
    return { ok: true, commit: commit!, tree: tree!, published: publish };
  }

  /**
   * Runs the project's own setup and checks on the composed tree. From here on candidate code runs in
   * this container, so git access ends first: the checks' results are as trustworthy as the project's own
   * test suite, which is the trust any CI has. The commands come from the accepted checkpoint's config.
   */
  async runChecks(setup: string | null, checks: CheckSpec[]): Promise<{ id: string; status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR"; detail: string; seconds: number }[]> {
    this.ctx.storage.kv.put("phase", "host");
    this.tokens.clear();
    const env = { CI: "true", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
    const run = async (command: string, timeoutSeconds: number) => {
      const started = Date.now();
      const r = await this.exec(["bash", "-lc", command], REPO_DIR, env, timeoutSeconds).catch((e) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
      const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-25).join("\n").slice(-2500);
      return { exitCode: r.exitCode, tail, seconds: Math.round((Date.now() - started) / 1000) };
    };
    const out: { id: string; status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR"; detail: string; seconds: number }[] = [];
    if (setup) {
      const s = await run(setup, 600);
      if (s.exitCode !== 0) {
        const status = s.exitCode === 124 ? "TIMEOUT" : "ERROR";
        return checks.map((c) => ({ id: c.id, status, detail: `setup (${setup}) failed: ${s.tail}`, seconds: 0 }));
      }
    }
    for (const c of checks) {
      const r = await run(c.run, c.timeoutSeconds);
      out.push({ id: c.id, status: r.exitCode === 0 ? "PASS" : r.exitCode === 124 ? "TIMEOUT" : "FAIL", detail: r.exitCode === 0 ? `${c.run} passed in ${r.seconds} s` : r.tail || `${c.run} exited ${r.exitCode}`, seconds: r.seconds });
    }
    return out;
  }

  private async readText(path: string): Promise<string | undefined> {
    try {
      return await (await this.files.readFile(path)).text();
    } catch (e) {
      if (SandboxFileError.is(e) && e.code === "ENOENT") return undefined;
      throw e;
    }
  }
}

const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/** Every container request lands here. Props identify which computer, role and attempt is asking. */
export class Outbound extends WorkerEntrypoint<Env, ComputerProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const props = this.ctx.props;
    if (url.hostname === "nest.internal") return this.nest(request, url, props);
    if (url.protocol !== "https:") return deny(`${url.hostname} is reachable only over HTTPS`);
    if (url.hostname === `${this.env.ACCOUNT_ID}.artifacts.cloudflare.net`) return this.git(request, url, props);
    if (url.hostname === "registry.npmjs.org") return this.packages(request, url, props);
    if (url.hostname === "gateway.ai.cloudflare.com" && url.pathname.startsWith(`/v1/${this.env.ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/`)) return this.model(request, url, props);
    return deny(`${url.hostname} is not reachable from a Nest computer`);
  }

  private async git(request: Request, url: URL, props: ComputerProps): Promise<Response> {
    const m = /^\/git\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m || m[1] !== this.env.ARTIFACTS_NAMESPACE) return deny("not a git smart-HTTP request for this namespace");
    const repo = m[2]!;
    const endpoint = m[3]!;
    const service = url.searchParams.get("service");
    // Exactly three request shapes exist in smart HTTP; anything else is refused.
    const shape =
      endpoint === "info/refs" && request.method === "GET" && (service === "git-upload-pack" || service === "git-receive-pack") ? (service === "git-receive-pack" ? "advertise-push" : "advertise-fetch")
      : endpoint === "git-upload-pack" && request.method === "POST" && request.headers.get("content-type") === "application/x-git-upload-pack-request" ? "fetch"
      : endpoint === "git-receive-pack" && request.method === "POST" && request.headers.get("content-type") === "application/x-git-receive-pack-request" ? "push"
      : null;
    if (!shape) return deny("unsupported git request");
    const pushing = shape === "push" || shape === "advertise-push";
    // Workspaces are readable only within the computer's own objective.
    const parsed = parseWorkspaceRepo(repo);
    const ws = parsed && parsed.objective === props.objective ? parsed : null;
    const isProject = repo === projectRepo(props.project);
    const isContext = repo === contextRepo(props.project);
    const computer = this.env.COMPUTERS.getByName(props.computer);

    // Which repositories this computer may read, and the single ref it may update.
    let readable: boolean;
    let pushRef: { repo: string; refs: string[] } | null;
    switch (props.role) {
      case "agent":
        readable = isProject || !!ws;
        pushRef = props.workspace ? { repo: props.workspace, refs: ["refs/heads/main"] } : null;
        break;
      case "runner":
        // Git only while explicitly composing; hosting, or any unknown state, has no git access.
        if ((await computer.phase()) !== "compose") return deny("this computer has no git access outside composition");
        readable = isProject || !!ws;
        // Whether the buildable branch may be pushed was decided by Nest before composing; Outbound allows
        // exactly this candidate's two refs.
        pushRef = props.candidate ? { repo: projectRepo(props.project), refs: [candidateRef(props.candidate), ...(props.publish ? [`refs/heads/${candidateBranch(props.candidate)}`] : [])] } : null;
        break;
      case "mirror":
        readable = isProject;
        pushRef = { repo: projectRepo(props.project), refs: ["refs/heads/main"] };
        break;
      case "context":
        readable = isContext;
        pushRef = { repo: contextRepo(props.project), refs: ["refs/heads/main"] };
        break;
    }
    if (!pushing && !readable) return deny(`${repo} is not readable from this computer`);
    if (pushing && (!pushRef || pushRef.repo !== repo)) return deny(`push to ${repo} is not allowed from this computer`);

    let body: ArrayBuffer | undefined;
    if (shape === "push") {
      // The receive-pack request begins with pkt-lines "<old> <new> <ref>"; every ref must be the allowed one.
      body = await request.arrayBuffer();
      const refs = receivePackRefs(new Uint8Array(body));
      if (!refs.length || refs.some((r) => !pushRef!.refs.includes(r))) return deny(`only ${pushRef!.refs.join(" or ")} may be updated from this computer (got ${refs.join(", ") || "none"})`);
    }
    const secret = await computer.gitToken(repo, pushing ? "write" : "read");
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${secret}`);
    return fetch(new Request(url, { method: request.method, headers, body: body ?? (request.method === "GET" ? undefined : request.body) }));
  }

  /**
   * Public packages from the npm registry, read-only, so a project's setup can install its dependencies.
   * Agents and runners only; nothing is sent there but GET requests without credentials.
   */
  private async packages(request: Request, url: URL, props: ComputerProps): Promise<Response> {
    if (props.role !== "agent" && props.role !== "runner") return deny("only agent and runner computers may install packages");
    if (request.method !== "GET" && request.method !== "HEAD") return deny("the package registry is read-only from Nest computers");
    const headers = new Headers();
    for (const h of ["accept", "accept-encoding", "user-agent", "npm-command", "if-none-match"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    return fetch(new Request(url, { method: request.method, headers }));
  }

  private async model(request: Request, url: URL, props: ComputerProps): Promise<Response> {
    if (props.role !== "agent") return deny("only agent computers may call models");
    const segments = url.pathname.split("/");
    const provider = segments[4] ?? "";
    const rest = segments.slice(5).join("/");
    // Only the metered generation endpoints: no files, batches, images, audio or fine-tuning.
    const ALLOWED: Record<string, string[]> = { openai: ["responses", "chat/completions"], openrouter: ["v1/chat/completions", "chat/completions"] };
    if (!ALLOWED[provider]?.includes(rest) || request.method !== "POST") return deny(`${provider}/${rest} is not an allowed model endpoint`);
    const target = providerTarget(this.env, provider, rest);
    const key = provider === "openai" ? this.env.OPENAI_API_KEY : this.env.OPENROUTER_API_KEY;
    if (!target) return deny(`provider ${provider} is not enabled`);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(await request.text()) as Record<string, unknown>; } catch { return deny("model requests must be JSON"); }
    const model = String(parsed.model ?? "unknown");
    // Agents may call only the model configured for their provider, and only a priced one.
    const configured = provider === "openai" ? this.env.AGENT_MODEL_OPENAI : this.env.AGENT_MODEL_ANTHROPIC;
    if (model !== configured || !isPriced(model)) return deny(`model ${model} is not allowed for agents`);
    // Clamp the output budget in the request itself, so the reservation below is a true upper bound.
    const CAP = 32_000;
    const field = rest === "responses" ? "max_output_tokens" : provider === "openai" ? "max_completion_tokens" : "max_tokens";
    const requested = Number(parsed[field] ?? parsed.max_tokens ?? parsed.max_completion_tokens ?? CAP);
    const maxOut = Math.max(1, Math.min(Number.isFinite(requested) ? requested : CAP, CAP));
    delete parsed.max_tokens;
    delete parsed.max_completion_tokens;
    delete parsed.max_output_tokens;
    parsed[field] = maxOut;
    // Fields that change which model runs or what it costs beyond tokens: fallback model lists and routing
    // (OpenRouter), priority tiers, several completions, and paid hosted tools. The forwarded body is this
    // re-serialized object, so what was checked is exactly what is sent.
    for (const k of ["models", "route", "provider", "plugins", "transforms", "service_tier", "background", "web_search_options"]) delete parsed[k];
    if (parsed.n !== undefined) parsed.n = 1;
    if (Array.isArray(parsed.tools)) {
      const PAID = /^(web_search|web_search_preview|file_search|code_interpreter|image_generation|computer_use|computer_use_preview|mcp)/;
      parsed.tools = (parsed.tools as { type?: unknown }[]).filter((t) => !PAID.test(String(t?.type ?? "")));
    }
    const bodyText = JSON.stringify(parsed);
    const ledger = registryStub(this.env);
    const reservation = `${props.computer}-${crypto.randomUUID()}`;
    const estimate = estimateCost(model, Math.ceil(bodyText.length / 3), maxOut);
    const allowed = await ledger.reserveSpend(reservation, props.objective, props.task ?? null, model, estimate, Number(this.env.SPEND_CAP_MICRO_USD));
    if (!allowed) return new Response(JSON.stringify({ error: { message: "Nest spend cap reached" } }), { status: 429, headers: { "content-type": "application/json" } });
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    if (key) headers.set("authorization", `Bearer ${key}`);
    headers.set("cf-aig-metadata", JSON.stringify({ objective: props.objective, task: props.task ?? "-", computer: props.computer }));
    headers.delete("cf-aig-authorization");
    for (const [k, v] of Object.entries(gatewayHeaders(this.env))) headers.set(k, v);
    headers.delete("host");
    headers.set("content-type", "application/json");
    const upstream = await fetch(new Request(target, { method: "POST", headers, body: bodyText }));
    if (!upstream.body) return upstream;
    // Settle with the provider's reported usage when it appears in the stream; otherwise the estimate stands.
    const [toClient, toMeter] = upstream.body.tee();
    this.ctx.waitUntil(meter(toMeter, model).then((actual) => (actual === null ? undefined : ledger.settleSpend(reservation, actual))));
    return new Response(toClient, { status: upstream.status, headers: upstream.headers });
  }

  private async nest(request: Request, url: URL, props: ComputerProps): Promise<Response> {
    if (props.role !== "agent" || !props.task || props.epoch === undefined) return deny("only agent computers can call Nest");
    const allowed = /^\/api\/(pack|search|publish|contributions(\/[a-z0-9_]+)?|note)$/.test(url.pathname);
    if (!allowed) return deny(`${url.pathname} is not available to agents`);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    const ws = props.workspace ? parseWorkspaceRepo(props.workspace) : null;
    if (!ws) return deny("this computer has no workspace");
    headers.set("x-nest-task", await taskToken(this.env, props.objective, ws.generation, props.task, props.epoch));
    const inner = new Request(new URL(`${url.pathname}${url.search}`, "https://nest.internal"), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
    const { default: worker } = await import("./index");
    return worker.fetch(inner, this.env, this.ctx as unknown as ExecutionContext);
  }
}

const deny = (message: string) => new Response(`${message}\n`, { status: 403 });

/**
 * Reads the provider's structured usage report from a model response, streamed (SSE) or not. Only the
 * provider's usage object counts: text the model writes can never lower the recorded cost. Returns null
 * when no usage object appears, and the reservation (an upper bound) then stands.
 */
async function meter(stream: ReadableStream<Uint8Array>, model: string): Promise<number | null> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let whole = "";
  let usage: { input: number; output: number } | null = null;
  const take = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const u = (o.usage ?? (o.response as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
    if (!u || typeof u !== "object") return;
    const input = Number(u.input_tokens ?? u.prompt_tokens);
    const output = Number(u.output_tokens ?? u.completion_tokens);
    if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0) usage = { input, output };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    if (whole.length < 4_000_000) whole += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try { take(JSON.parse(data)); } catch { /* not a JSON event */ }
    }
  }
  if (!usage) {
    try { take(JSON.parse(whole)); } catch { /* streamed, or not JSON */ }
  }
  if (!usage) return null;
  const { input, output } = usage as { input: number; output: number };
  const p = priceFor(model);
  return Math.round(input * p.inPerToken + output * p.outPerToken);
}
