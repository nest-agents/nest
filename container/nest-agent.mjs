// nest-agent: a small coding agent for Nest computers. It speaks the OpenAI-compatible chat API with
// tool calls, so any gateway-routed model can drive it. Credentials are added outside the container.
//
//   node nest-agent.mjs <prompt-file>
//   env: NEST_MODEL_URL, NEST_MODEL, NEST_MAX_TURNS (default 40)

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MODEL_URL = process.env.NEST_MODEL_URL;
const MODEL = process.env.NEST_MODEL;
const MAX_TURNS = Number(process.env.NEST_MAX_TURNS ?? 40);
const emit = (type, data = {}) => process.stdout.write(JSON.stringify({ type, at: new Date().toISOString(), ...data }) + "\n");

function inRepo(p) {
  const full = resolve(ROOT, String(p ?? "."));
  const rel = relative(ROOT, full);
  if (rel.startsWith("..") || rel.includes("\0")) throw new Error(`path ${p} is outside the repository`);
  return full;
}

function sh(command, timeoutMs = 120_000) {
  return new Promise((done) => {
    execFile("bash", ["-lc", command], { cwd: ROOT, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      done({ code, out: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.slice(-12_000) });
    });
  });
}

const tools = [
  { name: "list_files", description: "List files in the repository (tracked and new).", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_file", description: "Read a file. Optionally a 1-based inclusive line range.", parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"], additionalProperties: false } },
  { name: "write_file", description: "Create or overwrite a file with the complete new content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "replace_in_file", description: "Replace one exact, unique occurrence of old_text with new_text.", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"], additionalProperties: false } },
  { name: "run", description: "Run a bash command in the repository (tests, git, nest CLI). 120 s limit.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } },
  { name: "finish", description: "Stop. Call only after your work is committed and published with `nest publish`.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } },
];

async function call(name, args) {
  switch (name) {
    case "list_files": return (await sh("git ls-files --cached --others --exclude-standard")).out;
    case "read_file": {
      const text = await readFile(inRepo(args.path), "utf8");
      if (!args.start_line) return text.slice(0, 60_000);
      const lines = text.split("\n");
      return lines.slice(Math.max(0, args.start_line - 1), args.end_line ?? lines.length).join("\n");
    }
    case "write_file": {
      const full = inRepo(args.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, String(args.content));
      return `wrote ${args.path} (${String(args.content).length} bytes)`;
    }
    case "replace_in_file": {
      const full = inRepo(args.path);
      const text = await readFile(full, "utf8");
      const count = text.split(args.old_text).length - 1;
      if (count !== 1) return `error: old_text occurs ${count} times in ${args.path}; it must occur exactly once`;
      await writeFile(full, text.replace(args.old_text, args.new_text));
      return `replaced in ${args.path}`;
    }
    case "run": {
      const r = await sh(String(args.command));
      return `exit ${r.code}\n${r.out}`;
    }
    default: return `error: unknown tool ${name}`;
  }
}

async function model(messages) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(MODEL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto", max_tokens: 8000, usage: { include: true } }),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    emit("model_error", { status: res.status, body: text.slice(0, 500) });
    if (res.status === 429 && /spend cap/i.test(text)) throw new Error("spend cap reached");
    if (res.status < 500 && res.status !== 429) throw new Error(`model returned ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error("model unavailable after retries");
}

const prompt = await readFile(process.argv[2], "utf8");
const messages = [
  { role: "system", content: "You are a careful senior engineer working inside a git repository through tools. Make real changes, run the tests, commit with the requested trailers and publish. Be concise in text; let tool calls do the work." },
  { role: "user", content: prompt },
];
emit("start", { model: MODEL, maxTurns: MAX_TURNS });
let finished = false;
for (let turn = 1; turn <= MAX_TURNS && !finished; turn++) {
  const reply = await model(messages);
  const msg = reply.choices?.[0]?.message;
  if (!msg) { emit("error", { message: "empty reply" }); break; }
  messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
  if (msg.content) emit("say", { turn, text: String(msg.content).slice(0, 1000) });
  if (reply.usage) emit("usage", { turn, input: reply.usage.prompt_tokens, output: reply.usage.completion_tokens });
  if (!msg.tool_calls?.length) {
    messages.push({ role: "user", content: "Continue with tools. When your work is committed and published, call finish." });
    continue;
  }
  for (const tc of msg.tool_calls) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* malformed arguments become an error result */ }
    if (tc.function.name === "finish") {
      emit("finish", { turn, summary: String(args.summary ?? "").slice(0, 2000) });
      messages.push({ role: "tool", tool_call_id: tc.id, content: "ok" });
      finished = true;
      break;
    }
    let result;
    try { result = await call(tc.function.name, args); } catch (e) { result = `error: ${e.message}`; }
    const detail = tc.function.name === "run" ? String(args.command ?? "") : String(args.path ?? "");
    emit("tool", { turn, name: tc.function.name, detail: detail.slice(0, 200), result: String(result).slice(0, 300) });
    messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 20_000) });
  }
}
if (!finished) emit("stop", { reason: "turn limit" });
process.exit(finished ? 0 : 3);
