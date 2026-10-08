// Nest UI: projects at /, a project's context and checks at /p/<project>, and an objective's live work
// map at /o/<objective>. Every string from agents (titles, messages, reviews) is escaped before it
// reaches the DOM.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const short = (id) => String(id).replace(/^c_/, "").slice(0, 4);

/** Which page this is. Pages are ordinary links; each load renders one view. */
const R = (() => {
  const o = /^\/o\/([a-z][a-z0-9-]{1,46}[a-z0-9])\/?$/.exec(location.pathname);
  if (o) return { view: "objective", id: o[1] };
  const p = /^\/p\/([a-z][a-z0-9-]{1,30}[a-z0-9])\/?$/.exec(location.pathname);
  if (p) return { view: "project", id: p[1] };
  return { view: "home", id: null };
})();
const BASE = R.view === "objective" ? `/api/o/${R.id}` : "";

let S = null;            // last objective state
let events = [];         // newest first
let tab = "inbox";
let selected = null;     // { type: "contrib" | "ctx", id }
let selCand = null;
let hoverCtx = null;
let lastSeq = 0;

// ---------- data ----------

async function api(path, init = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error?.message ?? `${res.status}`);
  return body;
}

let refreshTimer = 0;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 500);
}

async function refresh() {
  try {
    S = await api(BASE);
    render();
  } catch (e) {
    toast(`Could not load state: ${e.message}`);
  }
}

async function loadEvents() {
  const list = await api(`${BASE}/events?tail=200`);
  events = list.reverse();
  lastSeq = events[0]?.seq ?? 0;
}

function connect(delay = 500) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${BASE}/live`);
  ws.onopen = () => {
    $("#liveChip").classList.add("on");
    $("#liveText").textContent = "Live";
    ws.send(JSON.stringify({ type: "replay", after: lastSeq }));
    delay = 500;
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const add = (ev) => {
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
      events.unshift({ ...ev, fresh: true });
      onEvent(ev);
    };
    if (msg.type === "event") add(msg.event);
    if (msg.type === "replay") msg.events.forEach(add);
    renderStream();
    refreshSoon();
  };
  ws.onclose = () => {
    $("#liveChip").classList.remove("on");
    $("#liveText").textContent = "Reconnecting";
    setTimeout(() => connect(Math.min(delay * 2, 10_000)), delay);
  };
}

function onEvent(ev) {
  if (ev.kind === "context" && ev.data) {
    const d = JSON.parse(ev.data);
    if (Array.isArray(d.contributions) && d.contributions.length) ripple(d.item, d.contributions);
  }
}

// ---------- helpers ----------

const who = (id) => S?.participants.find((p) => p.id === id);
const nameOf = (id) => who(id)?.name ?? id;
const currentVersion = (item) => S?.context.find((c) => c.id === item)?.version ?? 0;
const isStale = (c) => c.status !== "accepted" && c.status !== "superseded" && c.cites.some((x) => currentVersion(x.item) > x.version);
const reviewsOf = (id) => S.reviews.filter((r) => r.target === id && !r.triage);
const openInbox = () => S.inbox.filter((i) => i.status === "open");
let me = "viewer";
const owner = () => (S?.me ?? me) === "owner";

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 4200);
}

function modal(html, onMount) {
  const scrim = $("#scrim");
  scrim.innerHTML = `<div class="modal narrow" role="dialog" aria-modal="true">${html}</div>`;
  scrim.hidden = false;
  const close = () => { scrim.hidden = true; scrim.innerHTML = ""; };
  scrim.onclick = (e) => { if (e.target === scrim) close(); };
  document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
  onMount?.(scrim, close);
  scrim.querySelector("input,textarea,select,button")?.focus();
}

// ---------- render ----------

function render() {
  if (!S) return;
  // Asterion's one flourish: the headline ends on a blue full stop.
  $("#objectiveTitle").innerHTML = headline(S.objective.title ?? "Objective");
  $("#kicker").innerHTML = `<a href="/">Projects</a> / <a href="/p/${esc(S.objective.project)}">${esc(S.project?.name ?? S.objective.project)}</a> / Objective`;
  document.title = `${S.objective.title ?? "Objective"} · Nest`;
  $("#headVer").textContent = S.head ? String(S.head.version) : "-";
  const people = S.participants.filter((p) => p.kind === "person").length;
  $("#peopleCount").textContent = people;
  $("#peopleNoun").textContent = people === 1 ? "human," : "humans,";
  $("#agentCount").textContent = S.participants.filter((p) => p.kind === "agent").length;
  const used = S.spend.usedMicroUsd / 1e6, cap = (S.spend.capMicroUsd ?? 50e6) / 1e6;
  $("#spend").textContent = `$${used.toFixed(2)}`;
  $("#spendCap").textContent = `$${cap.toFixed(0)}`;
  $("#spendBar").style.inlineSize = `${Math.min(100, (100 * used) / cap).toFixed(1)}%`;
  signedIn();
  renderTools();
  renderRail();
  renderMap();
  renderRight();
}

/** Motion that answers a human's action: cross-fade through the View Transitions API where supported. */
function transition(fn) {
  if (reduceMotion || !document.startViewTransition) return fn();
  document.startViewTransition(fn);
}

function renderTools() {
  $("#mapTools").innerHTML = owner()
    ? `<button class="btn small" data-act="new-task" type="button">New task</button><button class="btn small primary" data-act="compose" type="button">Compose outcomes</button>`
    : "";
}

function renderRail() {
  const q = $("#ctxSearch").value.trim().toLowerCase();
  const groups = [["requirement", "Requirements"], ["decision", "Decisions"], ["policy", "Policies"], ["evidence", "Evidence"]];
  const cited = (id) => S.contributions.filter((c) => c.cites.some((x) => x.item === id)).length;
  const match = (t) => !q || t.toLowerCase().includes(q);
  let html = groups.map(([kind, label]) => {
    const items = S.context.filter((i) => i.kind === kind && match(`${i.title} ${i.id} ${i.body}`));
    if (!items.length) return "";
    return `<div class="group"><h3>${label}</h3>${items.map((i) => `
      <button class="ctx ${selected?.type === "ctx" && selected.id === i.id ? "on" : ""}" data-ctx="${esc(i.id)}" type="button">
        <span class="t">${esc(i.title)}</span><span class="v ${i.version > 1 ? "new" : ""}">v${i.version}</span>
        <span class="m"><span class="id">${esc(i.id)}</span><span>${cited(i.id) ? `cited by ${cited(i.id)}` : "not cited yet"}</span></span>
      </button>`).join("")}</div>`;
  }).join("");
  const rejected = (S.notes ?? []).filter((n) => n.kind === "rejected" && match(`${n.title} ${n.body}`));
  html += `<div class="group"><h3>Rejected approaches</h3>${rejected.length
    ? rejected.map((n) => `<button class="ctx" data-note="${esc(n.id)}" type="button"><span class="t">${esc(n.title)}</span><span class="v">note</span><span class="m"><span class="id">${esc(n.id)}</span></span></button>`).join("")
    : `<p class="empty-note">When you choose between approaches, the reason is kept here for every future agent.</p>`}</div>`;
  if (owner()) html += `<div class="row"><button class="btn small" data-addctx="${esc(S.objective.project)}" type="button">Add to context</button></div>`;
  $("#ctxGroups").innerHTML = html;
  const citations = S.contributions.reduce((n, c) => n + c.cites.length, 0);
  $("#store").innerHTML = `<span>Context items</span><b>${S.context.length}</b><span>Citations tracked</span><b>${citations}</b><span>Contributions</span><b>${S.contributions.length}</b><span>Reviews</span><b>${S.reviews.filter((r) => !r.triage).length}</b>`;
}

// ---------- map ----------
// Lanes of contributions under one trunk of checkpoints, on a single timeline of arrival. Accepted work
// draws a merge into the checkpoint it joined; the best ready outcome shows as the checkpoint you can accept.

const G = { trunkH: 76, laneH: 66, left: 40, right: 56, slot: 40, spineX: 14 };
const seen = { nodes: null, beads: null };

function lanes() {
  const ts = [...S.tasks];
  // Competing approaches sit next to each other.
  ts.sort((a, b) => (a.alternative ?? "~").localeCompare(b.alternative ?? "~") || a.createdAt.localeCompare(b.createdAt));
  return [...ts.filter((t) => t.alternative), ...ts.filter((t) => !t.alternative)];
}

/** The outcome the trunk previews: the one selected, or else the first that is ready. */
function proposal() {
  const live = S.candidates.filter((c) => !["superseded", "accepted"].includes(c.status));
  return live.find((c) => c.id === selCand) ?? live.find((c) => c.status === "ready") ?? null;
}

function geometry() {
  const L = lanes();
  const cps = [...(S.checkpoints ?? [])].sort((a, b) => a.version - b.version);
  // One timeline: contributions and checkpoints in the order they happened.
  const line = [
    ...S.contributions.map((c) => ({ k: "c", id: c.id, at: c.createdAt, seq: c.seq })),
    ...cps.map((cp) => ({ k: "cp", id: `cp${cp.version}`, at: cp.createdAt, seq: 0 })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  const prop = proposal();
  const slots = line.length + (prop ? 1 : 0);
  const avail = $("#plot").clientWidth;
  const step = Math.max(G.slot, (avail - G.left - G.right) / Math.max(1, slots - 1));
  G.w = Math.max(avail, G.left + G.right + step * Math.max(1, slots - 1));
  G.h = G.trunkH + Math.max(1, L.length) * G.laneH + 8;
  const index = new Map(line.map((e, i) => [e.id, i]));
  const x = (i) => G.left + i * step;
  const laneY = (task) => G.trunkH + Math.max(0, L.findIndex((l) => l.id === task)) * G.laneH + G.laneH / 2;
  const trunkY = G.trunkH / 2 + 4;
  const pos = (id) => { const c = S.contributions.find((q) => q.id === id); return c ? { x: x(index.get(id)), y: laneY(c.task) } : null; };
  const bead = (v) => ({ x: x(index.get(`cp${v}`)), y: trunkY });
  const ghost = prop ? { x: x(line.length), y: trunkY, cand: prop } : null;
  const ctx = [...S.context];
  const spineY = (item) => G.trunkH + 14 + ((Math.max(1, L.length) * G.laneH - 28) * Math.max(0, ctx.findIndex((c) => c.id === item))) / Math.max(1, ctx.length - 1);
  return { L, cps, pos, bead, ghost, trunkY, spineY };
}

const curve = (x0, y0, x1, y1) => { const dx = Math.max(28, (x1 - x0) / 2); return `M${x0},${y0} C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`; };
/** A merge rises from a lane into the trunk: leave horizontally, arrive vertically. */
const merge = (x0, y0, x1, y1) => `M${x0},${y0} C${x1},${y0} ${x1},${y0} ${x1},${y1}`;

function renderHeads(L) {
  const heads = [`<div class="lane-head trunk" role="listitem" style="block-size:${G.trunkH}px"><b>Accepted</b><span>${S.head ? `checkpoint ${S.head.version}, ${esc(S.head.commit.slice(0, 7))}` : "not seeded"}</span></div>`];
  let prevAlt = null;
  for (const t of L) {
    const p = t.participant ? who(t.participant) : null;
    const st = { open: "Open", running: "Working", paused: "Paused", done: "Done", failed: "Stopped" }[t.status] ?? t.status;
    const acts = owner()
      ? t.status === "running" ? `<button class="mini" data-pause="${esc(t.id)}" type="button">Pause</button><button class="mini" data-stop="${esc(t.id)}" type="button">Stop</button>`
        : t.status !== "done" ? `<button class="mini" data-start="${esc(t.id)}" type="button">${t.status === "paused" ? "Hand over" : "Start"}</button>` : ""
      : "";
    const alt = t.alternative && t.alternative !== prevAlt ? `<span class="alt">Competing: ${esc(t.alternative)}</span>` : "";
    prevAlt = t.alternative ?? null;
    heads.push(`<div class="lane-head lane st-${esc(t.status)} ${t.alternative ? "competing" : ""}" role="listitem" data-lane="${esc(t.id)}" style="block-size:${G.laneH}px">
      ${alt}<b title="${esc(t.title)}">${esc(t.title)}</b>
      <span class="who-line"><span class="state" aria-label="${esc(st)}"></span>${p ? `${esc(p.name)}, ${esc(p.model.replace(/^anthropic\//, ""))}` : "Unassigned"}${t.epoch > 1 ? `, attempt ${t.epoch}` : ""}${acts}</span>
    </div>`);
  }
  $("#laneHeads").innerHTML = heads.join("");
}

function renderMap() {
  const svg = $("#map");
  const empty = $("#mapEmpty");
  const L = lanes();
  renderHeads(L);
  const running = S.tasks.filter((t) => t.status === "running").length;
  $("#mapAside").textContent = running ? `${running} working now` : "";
  if (!S.contributions.length) {
    svg.innerHTML = "";
    svg.setAttribute("height", G.trunkH + Math.max(1, L.length) * G.laneH);
    empty.hidden = false;
    empty.innerHTML = `<div><h3>No contributions yet</h3><p>${S.tasks.length ? "Agents publish here as they push. Each commit lands in its task's lane." : "Create a task and start an agent or a human on it. Every commit they push lands here."}</p></div>`;
    return;
  }
  empty.hidden = true;
  // Stay with the latest work unless the human has scrolled back in time.
  const plot = $("#plot");
  const atEnd = seen.nodes === null || plot.scrollLeft + plot.clientWidth >= plot.scrollWidth - 12;
  const { cps, pos, bead, ghost, trunkY, spineY } = geometry();
  svg.setAttribute("width", G.w);
  svg.setAttribute("height", G.h);
  svg.setAttribute("viewBox", `0 0 ${G.w} ${G.h}`);
  const first = seen.nodes === null;
  const out = [`<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="hatch-line"/></pattern></defs>`];

  // Rows.
  out.push(`<rect class="row trunk-row" x="0" y="0" width="${G.w}" height="${G.trunkH}"/>`);
  L.forEach((_, i) => out.push(`<line class="row-rule" x1="0" y1="${G.trunkH + i * G.laneH + 0.5}" x2="${G.w}" y2="${G.trunkH + i * G.laneH + 0.5}"/>`));
  out.push(`<line class="spine" x1="${G.spineX}" y1="${G.trunkH + 8}" x2="${G.spineX}" y2="${G.h - 12}"/>`);

  // The trunk: solid through accepted checkpoints, dashed out to the one you can accept.
  const beads = cps.map((cp) => ({ cp, ...bead(cp.version) }));
  if (beads.length) out.push(`<line class="trunk" x1="${beads[0].x}" y1="${trunkY}" x2="${beads.at(-1).x}" y2="${trunkY}"/>`);
  if (ghost && beads.length) out.push(`<line class="trunk next" x1="${beads.at(-1).x}" y1="${trunkY}" x2="${ghost.x}" y2="${trunkY}"/>`);

  // Dependencies: direct parents only (every commit requires its whole closure, which would be noise).
  const byId = new Map(S.contributions.map((c) => [c.id, c]));
  const sel = selected?.type === "contrib" ? selected.id : null;
  for (const c of S.contributions) {
    const direct = c.requires.filter((d) => !c.requires.some((e) => e !== d && byId.get(e)?.requires.includes(d)));
    for (const d of direct) {
      const a = pos(d), b = pos(c.id);
      if (a && b) out.push(`<path class="dep ${sel && (sel === c.id || sel === d) ? "hl" : ""}" d="${curve(a.x, a.y, b.x, b.y)}"/>`);
    }
  }

  // Merges into accepted checkpoints, and the proposal's dashed merges into the next one.
  const newBeads = new Set();
  for (const b of beads) {
    if (!b.cp.candidate) continue;
    const k = S.candidates.find((x) => x.id === b.cp.candidate);
    const fresh = !first && !seen.beads?.has(b.cp.version);
    if (fresh) newBeads.add(b.cp.version);
    for (const id of k?.order ?? []) {
      const p = pos(id);
      if (p) out.push(`<path class="merge ${fresh ? "arrive" : ""}" pathLength="1" d="${merge(p.x, p.y, b.x, trunkY + 9)}"/>`);
    }
  }
  if (ghost) for (const id of ghost.cand.order) { const p = pos(id); if (p) out.push(`<path class="merge next" d="${merge(p.x, p.y, ghost.x, trunkY + 9)}"/>`); }

  // Citations for the hovered context item.
  if (hoverCtx) for (const c of S.contributions) if (c.cites.some((q) => q.item === hoverCtx)) { const p = pos(c.id); out.push(`<path class="cite" d="${curve(G.spineX, spineY(hoverCtx), p.x, p.y)}"/>`); }
  for (const c of S.context) { const y = spineY(c.id); out.push(`<circle class="spine-mark ${hoverCtx === c.id ? "on" : ""}" data-spine="${esc(c.id)}" cx="${G.spineX}" cy="${y}" r="3"><title>${esc(c.title)} v${c.version}</title></circle>`); }
  out.push(`<g id="fx"></g>`);

  // Checkpoint beads.
  for (const b of beads) {
    const contextOnly = !b.cp.candidate;
    const label = contextOnly ? `Checkpoint ${b.cp.version}: ${b.cp.reason}` : `Checkpoint ${b.cp.version}: ${S.candidates.find((x) => x.id === b.cp.candidate)?.name ?? b.cp.reason}`;
    out.push(`<g class="bead ${contextOnly ? "ctx" : ""} ${b.cp.version === S.head?.version ? "head" : ""} ${newBeads.has(b.cp.version) ? "arrive" : ""}" data-bead="${b.cp.version}" transform="translate(${b.x},${trunkY})" tabindex="0" role="button" aria-label="${esc(label)}"><circle class="halo" r="16"/><circle class="disc" r="11"/><text>${b.cp.version}</text></g>`);
  }
  if (ghost) out.push(`<g class="bead ghost" data-cand="${esc(ghost.cand.id)}" transform="translate(${ghost.x},${trunkY})" tabindex="0" role="button" aria-label="${esc(`Accepting ${ghost.cand.name} makes checkpoint ${(S.head?.version ?? 0) + 1}`)}"><circle class="disc" r="11"/><text>${(S.head?.version ?? 0) + 1}</text></g>`);

  // Contributions.
  const picks = new Set(ghost?.cand.order ?? []);
  const asks = new Set(openInbox().map((i) => i.target));
  const nowSeen = new Set();
  for (const c of S.contributions) {
    const p = pos(c.id);
    nowSeen.add(c.id);
    const person = who(c.author)?.kind === "person";
    const st = isStale(c) ? "stale" : c.status;
    const ticks = reviewsOf(c.id).slice(-4).map((r, i, arr) => {
      const tx = (i - (arr.length - 1) / 2) * 10, ty = 24;
      if (r.kind === "person") return `<rect class="tick ${r.verdict === "approve" ? "hm" : "hm-ch"}" x="${tx - 3.5}" y="${ty - 3.5}" width="7" height="7" rx="1.5"/>`;
      if (r.verdict === "approve") return `<circle class="tick ok" cx="${tx}" cy="${ty}" r="3.3"/>`;
      if (r.verdict === "changes" || r.verdict === "comment") return `<circle class="tick ch" cx="${tx}" cy="${ty}" r="3"/>`;
      return `<path class="tick bl" d="M${tx - 3},${ty - 3} L${tx + 3},${ty + 3} M${tx + 3},${ty - 3} L${tx - 3},${ty + 3}"/>`;
    }).join("");
    const shape = person ? `<rect class="body" x="-12" y="-12" width="24" height="24" rx="5"/>` : `<circle class="body" r="13"/>`;
    const mark = st === "blocked" || st === "changes" ? `<line class="mark" x1="-17" y1="17" x2="17" y2="-17"/>` : "";
    const label = `${c.title}, by ${nameOf(c.author)}. ${{ proposed: "Awaiting review", approved: "Approved", changes: "Changes requested", blocked: "Blocked", stale: "Relied on old context", accepted: "In a checkpoint", superseded: "Retired" }[st] ?? st}`;
    const arrive = !first && !seen.nodes.has(c.id);
    out.push(`<g class="node st-${st} ${sel === c.id ? "sel" : ""} ${arrive ? "arrive" : ""}" data-id="${esc(c.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(label)}">${arrive ? `<circle class="pulse" r="13"/>` : ""}${asks.has(c.id) ? `<circle class="ask" r="20"/>` : ""}${picks.has(c.id) ? `<circle class="ring" r="18"/>` : ""}${shape}${mark}<text class="ini">${esc(nameOf(c.author)[0] ?? "?")}</text><text class="nid" y="-20">${esc(short(c.id))}</text>${ticks}</g>`);
  }
  svg.innerHTML = out.join("");
  seen.nodes = nowSeen;
  seen.beads = new Set(cps.map((cp) => cp.version));
  if (atEnd) plot.scrollLeft = plot.scrollWidth;
  // A new contribution also lights its lane header once.
  for (const n of svg.querySelectorAll(".node.arrive")) {
    const c = byId.get(n.dataset.id);
    $(`.lane-head[data-lane="${CSS.escape(c?.task ?? "")}"]`)?.classList.add("arrive");
  }
}

async function ripple(item, ids) {
  const svg = $("#map");
  const layer = svg.querySelector("#fx");
  if (!layer || reduceMotion || !S) return;
  const { pos, spineY } = geometry();
  const y0 = spineY(item);
  svg.querySelector(`[data-spine="${CSS.escape(item)}"]`)?.classList.add("on");
  ids.forEach((id, i) => {
    const p = pos(id);
    if (!p) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", curve(G.spineX, y0, p.x, p.y));
    path.setAttribute("class", "cite-flow");
    layer.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 820, delay: i * 140, easing: "cubic-bezier(.3,.6,.2,1)", fill: "forwards" }).finished.then(() => {
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      ring.setAttribute("cx", p.x); ring.setAttribute("cy", p.y); ring.setAttribute("r", 11);
      ring.setAttribute("class", "cite-flow"); ring.setAttribute("fill", "none");
      ring.style.transformBox = "fill-box"; ring.style.transformOrigin = "center";
      layer.appendChild(ring);
      ring.animate([{ transform: "scale(1)", opacity: 0.9 }, { transform: "scale(2.7)", opacity: 0 }], { duration: 700, easing: "ease-out", fill: "forwards" });
    });
  });
}

// ---------- stream ----------

function renderStream() {
  $("#stream").innerHTML = events.slice(0, 80).map((e) => `<div class="ev ${e.fresh ? "new" : ""}"><time>${esc(new Date(e.at).toLocaleTimeString([], { hour12: false }))}</time><span class="svc">${esc(e.svc)}</span><span class="txt">${esc(e.text)}</span></div>`).join("")
    || `<div class="ev"><span></span><span></span><span class="txt">Nothing has happened yet.</span></div>`;
  for (const e of events) e.fresh = false;
}

// ---------- right panel ----------

function reviewHtml(r) {
  const p = who(r.reviewer);
  return `<div class="review"><div class="row"><span class="who"><span class="glyph ${p?.kind ?? "agent"}">${esc((p?.name ?? "?")[0])}</span><b>${esc(p?.name ?? r.reviewer)}</b><span>${esc(p?.kind === "agent" ? p.model : "human")}</span></span><span class="verdict">${esc({ approve: "Approved", changes: "Requested changes", block: "Blocked", comment: "Commented" }[r.verdict] ?? r.verdict)}</span></div>
    <q>${esc(r.summary)}</q>${r.findings?.length ? `<ul class="reasons">${r.findings.slice(0, 5).map((f) => `<li>${esc(f.path ? `${f.path}${f.line ? `:${f.line}` : ""} ` : "")}${esc(f.text)}${f.cite ? ` <span class="id">[${esc(f.cite)}]</span>` : ""}</li>`).join("")}</ul>` : ""}
    <div class="meta">${p?.kind === "agent" ? `<span>Confidence ${Number(r.confidence).toFixed(2)}</span>` : ""}</div></div>`;
}

/** What a real browser saw when it opened this outcome's own preview deployment. */
function shotHtml(c) {
  const seen = c.checks.find((k) => k.id === "preview");
  if (!seen || seen.status === "ERROR" || /^no deployment/.test(seen.detail)) return "";
  return `<figure class="shot"><img src="/shots/${esc(c.id)}.png" alt="The outcome's preview deployment as a browser saw it" loading="lazy" width="1100" height="720"><figcaption>${esc(seen.detail)}</figcaption></figure>`;
}

/** The outcome's preview deployment, from the project's own configuration. */
function previewHref(c) {
  const pv = S.config?.preview;
  if (!pv || !c.previewReady) return null;
  try { return new URL(pv.path, pv.url.replace("{branch}", `cand-${c.id}`)).toString(); } catch { return null; }
}
const previewLink = (c) => { const h = previewHref(c); return h ? `<a class="btn small" href="${esc(h)}" target="_blank" rel="noopener">Open preview</a>` : ""; };

function checksHtml(c) {
  if (!c.checks.length) return `<div class="checks"><span style="font-size:12.5px;color:var(--muted)">Checks not run yet</span></div>`;
  const pass = c.checks.filter((k) => k.status === "PASS").length;
  const kind = (k) => (k.status === "PASS" ? "pass" : k.status === "PENDING" ? "pend" : k.atHead && k.atHead !== "PASS" ? "todo" : "fail");
  const says = { pass: "passes", pend: "waits for approval", todo: "not done yet", fail: "broken" };
  return `<div class="checks">${c.checks.map((k) => `<span class="chk ${kind(k)}" title="${esc(k.id)}: ${says[kind(k)]}"></span>`).join("")}<span style="font-size:12.5px;color:var(--muted);margin-left:6px">${pass} of ${c.checks.length} checks</span></div>`;
}

const statusLabel = { composing: "Composing", checking: "Checking", ready: "Ready", waiting: "Waiting on review", incomplete: "Incomplete", failing: "Breaks a check", conflict: "Conflict", outdated: "Outdated", accepted: "Accepted", superseded: "Superseded" };

function inboxHtml() {
  const items = openInbox();
  if (!items.length) return `<div class="empty"><h4>Nothing needs you right now</h4><p>${S.policy?.decider === "agents"
    ? "Agents decide reviews in this project. You are asked only for what no model may clear: changes to how the project is checked or built, guard hits, and what agents cannot agree on."
    : "Agents review every push. You are asked when reviewers disagree, when a review blocks, when protected files change, and when an outcome is ready to accept."}${S.policy?.autoAccept ? " Ready outcomes are accepted automatically, except a choice between competing work." : ""}</p></div>`;
  return items.map((i, n) => {
    if (i.kind === "accept") {
      const c = S.candidates.find((x) => x.id === i.target);
      if (!c) return "";
      return `<div class="card ${n === 0 ? "focus" : ""}"><h4>${esc(c.name)} is ready</h4><p>All checks pass on the composed result and every contribution in it is approved.</p>${checksHtml(c)}
        <div class="picks">${c.order.map((id) => `<span class="pick"><span class="id">${esc(short(id))}</span>${esc(S.contributions.find((x) => x.id === id)?.title ?? "")}</span>`).join("")}</div>
        ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
        <div class="row">${owner() ? `<button class="btn small primary" data-accept="${esc(c.id)}" type="button">Accept checkpoint ${S.head.version + 1}</button>` : ""}${previewLink(c)}</div></div>`;
    }
    if (i.kind === "conflict") {
      const k = S.candidates.find((x) => x.id === i.target);
      if (!k) return "";
      const members = k.order.map((id) => S.contributions.find((x) => x.id === id)).filter(Boolean);
      const overlapping = members.filter((m) => m.paths.some((p) => (k.conflict ?? "").includes(p)));
      return `<div class="card ${n === 0 ? "focus" : ""}"><h4>Overlapping work in ${esc(k.name)}</h4><p>Real git could not combine these contributions. Keep one and the others are blocked with that reason, or have an agent reconcile them.</p>
        <div class="fail-line">${esc(k.conflict ?? "")}</div>
        ${overlapping.map((m) => `<div class="review"><div class="row" style="justify-content:space-between"><span class="who"><b>${esc(nameOf(m.author))}</b><span class="id">${esc(short(m.id))}</span></span>${owner() ? `<button class="btn small" data-keep="${esc(m.id)}" data-among="${esc(overlapping.map((x) => x.id).join(","))}" data-inbox="${esc(i.id)}" type="button">Keep this one</button>` : ""}</div><q>${esc(m.title)}</q><div class="meta"><span class="id">${m.paths.map(esc).join(", ")}</span></div></div>`).join("")}
        ${owner() ? `<div class="row"><button class="btn small primary" data-reconcile="${esc(k.id)}" type="button">Reconcile with an agent</button><button class="btn small" data-resolve="${esc(i.id)}" type="button">Dismiss</button></div>` : ""}</div>`;
    }
    const c = S.contributions.find((x) => x.id === i.target);
    if (!c) return "";
    return `<div class="card ${n === 0 ? "focus" : ""}"><h4>${esc(c.title)}</h4><p>${esc(nameOf(c.author))} published <span class="id">${esc(short(c.id))}</span>. A human is needed:</p>
      <ul class="reasons">${i.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${reviewsOf(c.id).map(reviewHtml).join("")}
      ${owner() ? `<div class="field"><label for="rv-${esc(c.id)}">Your review</label><input id="rv-${esc(c.id)}" placeholder="One sentence: why"></div>
      <div class="row"><button class="btn small primary" data-review="${esc(c.id)}" data-verdict="approve" type="button">Approve</button><button class="btn small" data-review="${esc(c.id)}" data-verdict="changes" type="button">Request changes</button><button class="btn small" data-review="${esc(c.id)}" data-verdict="block" type="button">Block</button></div>` : ""}
      <div class="row"><button class="btn small" data-open="${esc(c.id)}" type="button">Open contribution</button>${owner() && i.reasons.some((r) => /could not reach a verdict|No independent agent reviewer/.test(r)) ? `<button class="btn small" data-again="${esc(c.id)}" type="button">Ask agents again</button>` : ""}</div></div>`;
  }).join("");
}

function outcomesHtml() {
  const rank = { ready: 0, waiting: 1, composing: 2, incomplete: 3, failing: 4, conflict: 5, outdated: 6 };
  const live = S.candidates.filter((c) => !["superseded", "accepted"].includes(c.status)).sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  const head = S.head?.version ?? 0;
  const current = live.length
    ? live.map(outcomeCard).join("")
    : `<div class="empty"><h4>Nothing to accept on checkpoint ${head}</h4><p>When contributions arrive, Nest assembles every compatible combination with real git, runs the project's own checks on the whole result and opens its preview deployment in a browser.</p></div>`;
  return `${current}${historyHtml()}`;
}

/** Every checkpoint, newest first: what was accepted, why, and the commit it points at. */
function historyHtml() {
  const cps = (S.checkpoints ?? []).slice().sort((a, b) => b.version - a.version);
  if (cps.length < 2) return "";
  return `<section class="history" aria-label="Checkpoint history"><h3>History</h3><ol>${cps.map((cp) => {
    const c = cp.candidate ? S.candidates.find((x) => x.id === cp.candidate) : null;
    const what = c ? c.name : cp.reason;
    const why = c && cp.reason && !cp.reason.startsWith("Accepted ") ? cp.reason : "";
    return `<li class="${cp.version === headVersion() ? "now" : ""}"><span class="v">${cp.version}</span><div><b>${esc(what)}</b>${why ? `<q>${esc(why)}</q>` : ""}<span class="meta"><span class="id">${esc(cp.commit.slice(0, 7))}</span> ${esc(timeOf(cp.createdAt))}${c ? ` <button class="link" data-cand="${esc(c.id)}" type="button">Show on map</button>` : ""}</span></div></li>`;
  }).join("")}</ol></section>`;
}
const headVersion = () => S.head?.version ?? 0;
const timeOf = (iso) => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

function outcomeCard(c) {
  return `
    <div class="card ${c.id === selCand ? "focus" : ""}"><div class="row" style="justify-content:space-between"><h4>${esc(c.name)}</h4><span class="status ${c.status === "ready" ? "ready" : c.status === "outdated" ? "outdated" : ""}">${esc(statusLabel[c.status] ?? c.status)}</span></div>
    <div class="row"><span class="id" style="color:var(--muted)">${esc(c.id)}</span><span style="font-size:12.5px;color:var(--muted)">on checkpoint ${c.baseVersion}</span></div>
    ${checksHtml(c)}${c.checks.filter((k) => k.status === "PENDING").map((k) => `<div class="fail-line todo"><b>${esc(k.id)}</b> ${esc(k.detail)}</div>`).join("")}${c.checks.filter((k) => k.status !== "PASS" && k.status !== "PENDING").sort((a, b) => Number(b.atHead === "PASS") - Number(a.atHead === "PASS")).map((k) => `<div class="fail-line ${k.atHead === "PASS" ? "" : "todo"}"><b>${esc(k.id)}</b> ${k.atHead === "PASS" ? "Broken: passes on the checkpoint, fails here. " : k.atHead ? "Not done yet. " : ""}${esc(k.detail)}</div>`).join("")}
    ${c.conflict ? `<div class="fail-line">${esc(c.conflict)}</div>` : ""}
    ${shotHtml(c)}
    <div class="picks">${c.order.map((id) => `<span class="pick"><span class="id">${esc(short(id))}</span>${esc(S.contributions.find((x) => x.id === id)?.title ?? "")}</span>`).join("")}</div>
    ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
    <div class="row"><button class="btn small" data-cand="${esc(c.id)}" type="button">Show on map</button>${previewLink(c)}${owner() && c.status === "ready" ? `<button class="btn small primary" data-accept="${esc(c.id)}" type="button">Accept checkpoint ${S.head.version + 1}</button>` : ""}${owner() && ["failing", "incomplete"].includes(c.status) && c.commit && !/^Being repaired/.test(c.note ?? "") ? `<button class="btn small" data-repair="${esc(c.id)}" type="button">Repair with an agent</button>` : ""}${owner() && c.status === "conflict" ? `<button class="btn small" data-reconcile="${esc(c.id)}" type="button">Reconcile with an agent</button>` : ""}</div></div>`;
}

function inspectHtml() {
  if (!selected) return `<div class="empty"><h4>Select anything on the map</h4><p>A contribution shows its message, the context it cites, its changed files and every review from humans and agents. A context item shows what relies on it.</p></div>`;
  if (selected.type === "contrib") {
    const c = S.contributions.find((x) => x.id === selected.id);
    if (!c) return "";
    const p = who(c.author);
    return `<div class="card"><div class="row"><span class="who"><span class="glyph ${p?.kind ?? "agent"}">${esc(nameOf(c.author)[0])}</span><b>${esc(nameOf(c.author))}</b><span>${esc(p?.model ?? "")}</span></span></div>
      <h4>${esc(c.title)}</h4>
      <dl class="kv"><dt>Contribution</dt><dd class="id">${esc(c.id)}</dd><dt>Status</dt><dd>${esc(isStale(c) ? "Relied on old context" : ({ proposed: "Awaiting review", approved: "Approved", changes: "Changes requested", blocked: "Blocked", accepted: "Accepted", superseded: "Retired" }[c.status] ?? c.status))}</dd>
      ${c.flags?.length ? `<dt>Why</dt><dd>${c.flags.map(esc).join("<br>")}</dd>` : ""}
      <dt>Task</dt><dd>${esc(S.tasks.find((t) => t.id === c.task)?.title ?? c.task)}, attempt ${c.epoch}</dd>
      <dt>Depends on</dt><dd>${c.requires.length ? c.requires.map((r) => `<span class="id">${esc(short(r))}</span> ${esc(S.contributions.find((x) => x.id === r)?.title ?? "")}`).join("<br>") : "Nothing beyond the checkpoint"}</dd>
      ${c.alternative ? `<dt>Alternative in</dt><dd>${esc(c.alternative)}</dd>` : ""}
      <dt>Files</dt><dd class="id">${c.paths.map(esc).join("<br>")}</dd>
      <dt>Commit</dt><dd class="id">${esc(c.commit.slice(0, 12))} in ${esc(c.repo)}</dd></dl>
      <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Cites</div><div class="cites">${c.cites.map((x) => { const stale = currentVersion(x.item) > x.version; return `<button class="cite-chip ${stale ? "stale" : ""}" data-ctx="${esc(x.item)}" type="button">${esc(x.item)} v${x.version}${stale ? `, now v${currentVersion(x.item)}` : ""}</button>`; }).join("") || `<span style="font-size:12.5px;color:var(--muted)">No citations</span>`}</div></div>
      <pre class="diff">${esc(c.message)}</pre></div>
      <div class="card"><h4>Reviews</h4>${S.reviews.filter((r) => r.target === c.id && r.triage).map((r) => `<p>${esc(r.summary)}</p>`).join("")}${reviewsOf(c.id).map(reviewHtml).join("") || "<p>Waiting for reviewers.</p>"}</div>`;
  }
  const i = S.context.find((x) => x.id === selected.id);
  if (!i) return "";
  const uses = S.contributions.filter((c) => c.cites.some((x) => x.item === i.id));
  return `<div class="card"><div class="row" style="justify-content:space-between"><h4>${esc(i.title)}</h4><span class="status">${esc(i.kind)}</span></div>
    <dl class="kv"><dt>Item</dt><dd class="id">${esc(i.id)}@v${i.version}</dd><dt>Owner</dt><dd>${esc(i.owner)}</dd>
    <dt>Relied on by</dt><dd>${uses.length ? uses.map((c) => `<span class="id">${esc(short(c.id))}</span> ${esc(c.title)}${c.cites.find((x) => x.item === i.id)?.version < i.version ? " (old version)" : ""}`).join("<br>") : "Nothing yet"}</dd></dl>
    <div class="versions"><div class="ver"><small>Version ${i.version}, current</small>${esc(i.body)}</div></div>
    ${owner() ? `<div class="field"><label for="ctx-next">Propose version ${i.version + 1}</label><textarea id="ctx-next">${esc(i.body)}</textarea></div><div class="row"><button class="btn small primary" data-ctxchange="${esc(i.id)}" type="button">Accept version ${i.version + 1}</button><span style="font-size:12.5px;color:var(--muted)">Shows its blast radius on the map</span></div>` : ""}</div>`;
}

function renderRight() {
  if (!S) return;
  for (const k of ["inbox", "outcomes", "inspect"]) $(`#tab-${k}`).setAttribute("aria-selected", String(tab === k));
  const n = openInbox().length;
  $("#inboxCount").textContent = n; $("#inboxCount").classList.toggle("zero", n === 0);
  const live = S.candidates.filter((c) => !["superseded", "accepted"].includes(c.status)).length;
  $("#outCount").textContent = live; $("#outCount").classList.toggle("zero", live === 0);
  $("#rightBody").innerHTML = tab === "inbox" ? inboxHtml() : tab === "outcomes" ? outcomesHtml() : inspectHtml();
  $("#modeAside").textContent = [S.policy?.decider === "agents" ? "agents decide" : "you decide", S.policy?.autoAccept ? "auto-accept" : ""].filter(Boolean).join(", ");
}

// ---------- actions ----------

async function act(fn, done) {
  try { await fn(); if (done) toast(done); await reload(); } catch (e) { toast(e.message); }
}

/** Re-reads whatever this page shows. */
function reload() {
  return R.view === "objective" ? refresh() : R.view === "project" ? loadProject() : loadHome();
}

/** Asterion's one flourish: a headline ends on a blue full stop. */
const headline = (text) => `${esc(String(text).replace(/[.\s]+$/, ""))}<span class="blue-period">.</span>`;

function signedIn() {
  $("#signInBtn").textContent = owner() ? "Signed in" : "Sign in";
  $("#signInBtn").disabled = owner();
}

function setSpend(spend) {
  const used = (spend?.usedMicroUsd ?? 0) / 1e6, cap = (spend?.capMicroUsd ?? 50e6) / 1e6;
  $("#spend").textContent = `$${used.toFixed(2)}`;
  $("#spendCap").textContent = `$${cap.toFixed(0)}`;
  $("#spendBar").style.inlineSize = `${Math.min(100, (100 * used) / cap).toFixed(1)}%`;
}

// ---------- home: every project and its objectives ----------

let H = null;

async function loadHome() {
  try { H = await api("/api/projects"); } catch (e) { toast(`Could not load projects: ${e.message}`); return; }
  me = H.me;
  signedIn();
  setSpend(H.spend);
  $("#kicker").textContent = "Nest";
  $("#objectiveTitle").innerHTML = headline("Projects");
  $("#lede").hidden = false;
  $("#lede").textContent = "Each project is a git repository in Cloudflare Artifacts with its own checks. Inside it, objectives are where humans and agents work: agents build and review, humans decide what ships.";
  const tools = owner() ? `<div class="row page-tools"><button class="btn small primary" data-act="new-project" type="button">New project</button><button class="btn small" data-act="invite" type="button">Invite a human or agent</button></div>` : "";
  const list = H.projects.length ? H.projects.map((x) => `
    <article class="proj">
      <header class="proj-head">
        <h2><a href="/p/${esc(x.id)}">${esc(x.name)}</a></h2>
        <span class="id">${esc(x.id)}</span>
        <span class="proj-cp">${x.head ? `Checkpoint ${x.head.version}, <span class="id">${esc(x.head.commit.slice(0, 7))}</span>` : "Waiting for its first push"}</span>
      </header>
      ${x.description ? `<p class="proj-desc">${esc(x.description)}</p>` : ""}
      <ul class="objs">${x.objectives.map((o) => `<li><a href="/o/${esc(o.id)}"><span class="t">${esc(o.title)}</span><span class="id">${esc(o.id)}</span></a></li>`).join("")}
        ${x.objectives.length ? "" : `<li class="none">No objectives yet.</li>`}</ul>
      ${owner() && x.head ? `<div class="row"><button class="btn small" data-newobj="${esc(x.id)}" type="button">New objective</button></div>` : ""}
    </article>`).join("")
    : `<div class="empty"><h4>No projects yet</h4><p>${owner() ? "Create one from a public git repository, or start empty and push your code to it." : "Sign in as the owner to create the first project."}</p></div>`;
  $("#page").innerHTML = `${tools}<section class="projects" aria-label="Projects">${list}</section>`;
}

// ---------- project: context, how it is checked, objectives and history ----------

let P = null;
let openCtx = null;

async function loadProject() {
  try { P = await api(`/api/p/${R.id}`); } catch (e) { toast(`Could not load the project: ${e.message}`); return; }
  me = P.me;
  signedIn();
  api("/api/spend").then(setSpend).catch(() => undefined);
  document.title = `${P.project.name} · Nest`;
  $("#kicker").innerHTML = `<a href="/">Projects</a> / Project`;
  $("#objectiveTitle").innerHTML = headline(P.project.name);
  $("#lede").hidden = !P.project.description;
  $("#lede").textContent = P.project.description;
  renderProject();
}

function contextHtml() {
  const kinds = [["requirement", "Requirements"], ["decision", "Decisions"], ["policy", "Policies"], ["evidence", "Evidence"], ["note", "Notes"]];
  const groups = kinds.map(([kind, label]) => {
    const items = P.context.filter((i) => i.kind === kind);
    if (!items.length) return "";
    return `<div class="group"><h3>${label}</h3>${items.map((i) => `
      <div class="pctx ${openCtx === i.id ? "on" : ""}">
        <button class="ctx" data-pctx="${esc(i.id)}" type="button" aria-expanded="${openCtx === i.id}"><span class="t">${esc(i.title)}</span><span class="v ${i.version > 1 ? "new" : ""}">v${i.version}</span><span class="m"><span class="id">${esc(i.id)}</span></span></button>
        ${openCtx === i.id ? `<div class="pctx-body"><div class="ver"><small>Version ${i.version}, current</small>${esc(i.body)}</div>
          ${owner() ? `<div class="field"><label for="pctx-next">Propose version ${i.version + 1}</label><textarea id="pctx-next">${esc(i.body)}</textarea></div><div class="row"><button class="btn small primary" data-pctxsave="${esc(i.id)}" type="button">Accept version ${i.version + 1}</button><span class="hint">Work that cited version ${i.version} is marked and recomposed</span></div>` : ""}</div>` : ""}
      </div>`).join("")}</div>`;
  }).join("");
  const rejected = P.notes.filter((n) => n.kind === "rejected");
  return `${groups || `<div class="empty"><h4>No context yet</h4><p>Write down what the project must do. Agents receive every requirement with a citation, reviewers judge against them, and changing one shows exactly which work relied on the old version.</p></div>`}
    ${rejected.length ? `<div class="group"><h3>Rejected approaches</h3>${rejected.map((n) => `<div class="pctx"><div class="ctx"><span class="t">${esc(n.title)}</span><span class="v">note</span><span class="m">${esc(n.body.slice(0, 220))}${n.body.length > 220 ? "…" : ""}</span></div></div>`).join("")}</div>` : ""}
    ${owner() && P.head ? `<div class="row"><button class="btn small" data-addctx="${esc(P.project.id)}" type="button">Add to context</button></div>` : ""}`;
}

function checksConfigHtml() {
  if (!P.head) return "";
  if (P.configError) return `<div class="card"><h4>The project's configuration is invalid</h4><div class="fail-line">${esc(P.configError)}</div><p>Fix <span class="id">.nest/project.json</span> through an accepted contribution.</p></div>`;
  const c = P.config;
  if (!c || (!c.checks.length && !c.preview && !c.setup)) return `<div class="card"><h4>How Nest checks it</h4><p>No <span class="id">.nest/project.json</span> at this checkpoint, so an outcome is checked only for a clean composition. Add one to run the project's own tests and open its preview deployment.</p></div>`;
  return `<div class="card"><h4>How Nest checks it</h4><p>Read from <span class="id">.nest/project.json</span> at checkpoint ${P.head.version}. Every outcome runs these in a fresh container, on the whole composed tree.</p>
    <dl class="kv">${c.setup ? `<dt>Setup</dt><dd class="id">${esc(c.setup)}</dd>` : ""}
    ${c.checks.map((k) => `<dt>${esc(k.id)}</dt><dd class="id">${esc(k.run)}</dd>`).join("")}
    ${c.preview ? `<dt>Preview</dt><dd class="id">${esc(c.preview.url)}${c.preview.path !== "/" ? `<br>path ${esc(c.preview.path)}` : ""}</dd>` : ""}
    ${c.production ? `<dt>Production</dt><dd><a class="ext" href="${esc(c.production)}" target="_blank" rel="noopener">${esc(c.production.replace(/^https:\/\//, ""))}</a></dd>` : ""}
    ${c.protected.length ? `<dt>Needs a human</dt><dd class="id">${c.protected.map(esc).join("<br>")}</dd>` : ""}</dl></div>`;
}

const FLOOR_HUMAN = [".nest/"];

/** Who settles reviews and whether ready outcomes ship on their own: the project's review policy. */
function decidingHtml() {
  const pol = P.policy;
  if (!pol) return "";
  const agents = pol.decider === "agents";
  const handedOver = agents && pol.humanPaths.length <= FLOOR_HUMAN.length;
  const view = `<dl class="kv">
    <dt>Reviews</dt><dd>${agents ? "Agents decide. Unanimous and confident, with one more model family when they split; then you." : "You settle what agent reviewers cannot: disagreements, low confidence, protected files."}</dd>
    <dt>Accepting</dt><dd>${pol.autoAccept ? "Ready outcomes are accepted, and deployed, automatically. A choice between competing work still comes to you." : "You accept every checkpoint."}</dd>
    <dt>Always yours</dt><dd>Changes to <span class="id">.nest/</span>, guard hits, and changes reviewers could not fully see${agents && !handedOver ? `; also <span class="id">${pol.humanPaths.filter((x) => !FLOOR_HUMAN.includes(x)).slice(0, 4).map(esc).join(", ")}</span> and other build files` : ""}</dd></dl>`;
  const form = owner() ? `<form class="decide" id="decide">
    <fieldset><legend>Reviews</legend>
      <label><input type="radio" name="decider" value="human" ${agents ? "" : "checked"}> Ask me when it matters</label>
      <label><input type="radio" name="decider" value="agents" ${agents ? "checked" : ""}> Let agents decide</label></fieldset>
    <label class="check"><input type="checkbox" name="build" ${handedOver ? "checked" : ""}> Agents may also approve dependency and build changes</label>
    <p class="hint warn">A dependency or build change runs code in the project's build, which can deploy Workers. Hand it over only if you trust the reviewers with that.</p>
    <label class="check"><input type="checkbox" name="auto" ${pol.autoAccept ? "checked" : ""}> Accept ready outcomes automatically</label>
    <div class="row"><button class="btn small primary" type="submit">Save as a new policy version</button></div></form>` : "";
  return `<div class="card"><h4>How work is decided</h4>${view}${form}</div>`;
}

function savePolicy(form) {
  const item = P.context.find((i) => i.id === "policy/review-routing");
  const decider = form.querySelector('input[name="decider"]:checked')?.value ?? "human";
  const build = form.querySelector('input[name="build"]').checked;
  const auto = form.querySelector('input[name="auto"]').checked;
  const block = { ...(item?.policy ?? {}), decider, autoAccept: auto };
  if (decider === "agents" && build) block.humanPaths = [...FLOOR_HUMAN];
  else delete block.humanPaths;
  const said = [
    decider === "agents" ? "Agents decide reviews: unanimous and confident, with one more model family when they split, then a human." : "A human settles what agent reviewers cannot.",
    decider === "agents" && build ? "Agents may also approve dependency and build changes." : "Dependency and build changes need a human.",
    auto ? "Ready outcomes are accepted automatically, except a choice between competing work." : "A human accepts every checkpoint.",
  ].join(" ");
  const body = `${said}\n\n\`\`\`nest-policy\n${JSON.stringify(block, null, 2)}\n\`\`\``;
  return act(() => api(`/api/p/${P.project.id}/context`, { method: "POST", body: JSON.stringify({ id: "policy/review-routing", kind: "policy", title: "How work is reviewed and accepted", body }) }), `Policy version ${(item?.version ?? 0) + 1} accepted`);
}

function renderProject() {
  if (!P.head) {
    $("#page").innerHTML = `<div class="empty wide"><h4>Waiting for the code</h4><p>This project's repository in Artifacts has no commit on main yet: an import may still be running, or nothing has been pushed. ${owner() ? "Check again in a moment, or push your code to its main branch." : "The owner pushes the first commit."}</p>
      ${owner() ? `<div class="row"><button class="btn small primary" data-bootstrap="${esc(P.project.id)}" type="button">Check for code</button></div>` : ""}</div>`;
    return;
  }
  const cps = P.checkpoints.slice().sort((a, b) => b.version - a.version);
  $("#page").innerHTML = `<div class="proj-grid">
    <section class="proj-main" aria-label="Context"><div class="panel-head"><h2>Context</h2><span class="aside">versioned like code</span></div><div class="proj-ctx">${contextHtml()}</div></section>
    <aside class="proj-side">
      <div class="card"><div class="row" style="justify-content:space-between"><h4>Objectives</h4>${owner() ? `<button class="btn small" data-newobj="${esc(P.project.id)}" type="button">New objective</button>` : ""}</div>
        <ul class="objs">${P.objectives.map((o) => `<li><a href="/o/${esc(o.id)}"><span class="t">${esc(o.title)}</span><span class="id">${esc(o.id)}</span></a></li>`).join("") || `<li class="none">None yet. An objective is a goal with its own tasks, agents and outcomes.</li>`}</ul></div>
      ${decidingHtml()}
      ${checksConfigHtml()}
      <section class="history" aria-label="Checkpoint history"><h3>Checkpoints</h3><ol>${cps.map((cp) => `<li class="${cp.version === P.head.version ? "now" : ""}"><span class="v">${cp.version}</span><div><b>${esc(cp.reason)}</b><span class="meta"><span class="id">${esc(cp.commit.slice(0, 7))}</span> ${esc(timeOf(cp.createdAt))}</span></div></li>`).join("")}</ol></section>
    </aside></div>`;
}

function newProject() {
  modal(`<form class="form" id="np"><h3>New project</h3><p>Nest imports a public git repository into Artifacts, or creates an empty one for you to push to. Put a <span class="id">.nest/project.json</span> in it to tell Nest how to install, test and preview it.</p>
    <div class="field"><label for="np-id">Id</label><input id="np-id" required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" placeholder="beacon"></div>
    <div class="field"><label for="np-name">Name</label><input id="np-name" required placeholder="Beacon"></div>
    <div class="field"><label for="np-desc">What it is</label><input id="np-desc" placeholder="Uptime monitor and public status page"></div>
    <div class="field"><label for="np-url">Public git URL (optional)</label><input id="np-url" type="url" placeholder="https://github.com/you/project.git"></div>
    <div class="row"><button class="btn small primary" type="submit">Create project</button></div></form>`, (root, close) => {
    root.querySelector("#np").onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => root.querySelector(id).value.trim();
      act(async () => {
        const url = v("#np-url");
        const r = await api("/api/projects", { method: "POST", body: JSON.stringify({ id: v("#np-id"), name: v("#np-name"), description: v("#np-desc"), source: url ? { url } : null }) });
        close();
        if (r.importing) { location.href = `/p/${r.project.id}`; return; }
        if (r.push) modal(`<div class="form"><h3>Push your code</h3><p>The token writes to this repository only and expires at ${esc(r.push.expiresAt)}. After the push, open the project and choose Check for code.</p><pre class="diff">git remote add nest ${esc(r.push.remote)}\ngit -c http.extraHeader="Authorization: Bearer ${esc(r.push.token)}" push nest HEAD:main</pre><div class="row"><a class="btn small primary" href="/p/${esc(r.project.id)}">Open the project</a></div></div>`);
      }, "Project created");
    };
  });
}

function newObjective(project) {
  modal(`<form class="form" id="no"><h3>New objective</h3><p>A goal for this project. Agents get it, with the project's context, as the frame for every task.</p>
    <div class="field"><label for="no-id">Id</label><input id="no-id" required pattern="[a-z][a-z0-9-]{1,46}[a-z0-9]" placeholder="${esc(project)}-incidents"></div>
    <div class="field"><label for="no-title">Title</label><input id="no-title" required placeholder="Incidents a human can trust"></div>
    <div class="field"><label for="no-crit">Done when (one per line, optional)</label><textarea id="no-crit"></textarea></div>
    <div class="row"><button class="btn small primary" type="submit">Create objective</button></div></form>`, (root, close) => {
    root.querySelector("#no").onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => root.querySelector(id).value.trim();
      act(async () => {
        const o = await api(`/api/p/${project}/objectives`, { method: "POST", body: JSON.stringify({ id: v("#no-id"), title: v("#no-title"), criteria: v("#no-crit").split("\n").map((x) => x.trim()).filter(Boolean) }) });
        close();
        location.href = `/o/${o.id}`;
      }, "Objective created");
    };
  });
}

function addContext(project) {
  modal(`<form class="form" id="ac"><h3>Add to context</h3><p>Context is versioned like code. Agents cite what they rely on, so a later change shows exactly which work it affects.</p>
    <div class="field"><label for="ac-kind">Kind</label><select id="ac-kind"><option value="requirement">Requirement</option><option value="decision">Decision</option><option value="evidence">Evidence</option><option value="note">Note</option></select></div>
    <div class="field"><label for="ac-name">Short name</label><input id="ac-name" required pattern="[a-z0-9][a-z0-9-]{0,60}" placeholder="incident-rule"></div>
    <div class="field"><label for="ac-title">Title</label><input id="ac-title" required placeholder="An incident opens after three failed checks in a row"></div>
    <div class="field"><label for="ac-body">Text</label><textarea id="ac-body" required></textarea></div>
    <div class="row"><button class="btn small primary" type="submit">Add version 1</button></div></form>`, (root, close) => {
    root.querySelector("#ac").onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => root.querySelector(id).value.trim();
      const kind = v("#ac-kind");
      const dir = { requirement: "req", decision: "dec", evidence: "ev", note: "note" }[kind];
      act(async () => { await api(`/api/p/${project}/context`, { method: "POST", body: JSON.stringify({ id: `${dir}/${v("#ac-name")}`, kind, title: v("#ac-title"), body: v("#ac-body") }) }); close(); }, "Added to context");
    };
  });
}

function invite() {
  modal(`<form class="form" id="iv"><h3>Invite a human or agent</h3><p>They get a token for Nest's MCP endpoint, as themselves. A human's review decides over agents'; an agent's model family keeps reviews independent. Rotating the participant revokes the token.</p>
    <div class="field"><label for="iv-kind">Who</label><select id="iv-kind"><option value="human">A human</option><option value="agent">An agent you run</option></select></div>
    <div class="field"><label for="iv-id">Id</label><input id="iv-id" required pattern="[a-z][a-z0-9-]{1,31}" placeholder="sam"></div>
    <div class="field"><label for="iv-name">Name</label><input id="iv-name" required placeholder="Sam"></div>
    <div class="field agent-only" hidden><label for="iv-family">Model family</label><input id="iv-family" placeholder="openai, anthropic, google, ..."></div>
    <div class="field agent-only" hidden><label for="iv-model">Model</label><input id="iv-model" placeholder="the model it runs"></div>
    <div class="row"><button class="btn small primary" type="submit">Create token</button></div></form>`, (root, close) => {
    const kind = root.querySelector("#iv-kind");
    kind.onchange = () => root.querySelectorAll(".agent-only").forEach((el) => (el.hidden = kind.value !== "agent"));
    root.querySelector("#iv").onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => root.querySelector(id).value.trim();
      act(async () => {
        const r = await api("/api/participants", { method: "POST", body: JSON.stringify({ id: v("#iv-id"), name: v("#iv-name"), kind: kind.value, family: v("#iv-family") || undefined, model: v("#iv-model") || undefined }) });
        close();
        modal(`<div class="form"><h3>${esc(r.participant.name)} can join</h3><p>Send this to them privately. It is shown once.</p><pre class="diff">MCP endpoint  ${esc(r.mcp)}\nAuthorization Bearer ${esc(r.token)}</pre></div>`);
      }, "Token created");
    };
  });
}

function signIn() {
  modal(`<form class="form" id="signin"><h3>Sign in as the owner</h3><p>Paste the owner token. It is exchanged for a secure session cookie on this device.</p>
    <div class="field"><label for="tok">Owner token</label><input id="tok" type="password" autocomplete="off" required></div>
    <div class="row"><button class="btn small primary" type="submit">Sign in</button></div></form>`, (root, close) => {
    root.querySelector("#signin").onsubmit = (e) => {
      e.preventDefault();
      const token = root.querySelector("#tok").value.trim();
      act(async () => { await api("/api/session", { method: "POST", headers: { authorization: `Bearer ${token}` } }); close(); }, "Signed in");
    };
  });
}

function newTask() {
  modal(`<form class="form" id="nt"><h3>New task</h3><p>Describe the outcome, not the steps. Tasks in the same competing group become alternatives you choose between.</p>
    <div class="field"><label for="nt-id">Id</label><input id="nt-id" required pattern="t_[a-z0-9-]{1,48}" placeholder="t_export-jobs"></div>
    <div class="field"><label for="nt-title">Title</label><input id="nt-title" required placeholder="Explore a background-job export"></div>
    <div class="field"><label for="nt-brief">Brief</label><textarea id="nt-brief" required></textarea></div>
    <div class="field"><label for="nt-alt">Competing group (optional)</label><input id="nt-alt" placeholder="export-strategy"></div>
    <div class="row"><button class="btn small primary" type="submit">Create task</button></div></form>`, (root, close) => {
    root.querySelector("#nt").onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => root.querySelector(id).value.trim();
      act(async () => { await api(`${BASE}/tasks`, { method: "POST", body: JSON.stringify({ id: v("#nt-id"), title: v("#nt-title"), brief: v("#nt-brief"), alternative: v("#nt-alt") || null }) }); close(); }, "Task created");
    };
  });
}

function startTask(id) {
  const workers = S.participants.filter((p) => ["codex", "nest-agent", "external"].includes(p.harness) || p.kind === "person");
  const runsHere = (p) => ["codex", "nest-agent"].includes(p?.harness);
  const t = S.tasks.find((x) => x.id === id);
  modal(`<form class="form" id="st"><h3>${t.status === "paused" ? "Hand over" : "Start"} ${esc(t.title)}</h3><p>${t.status === "paused" ? "The next participant continues from the paused tree, the saved uncommitted work and the notes." : "Nest forks the accepted checkpoint into a workspace for this attempt."}</p>
    <div class="field"><label for="st-p">Participant</label><select id="st-p">${workers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.kind === "person" ? "human, pushes from their machine" : runsHere(p) ? `${p.harness}, ${p.model}` : `external agent, ${p.model}`)})</option>`).join("")}</select></div>
    <div class="row"><button class="btn small primary" type="submit">Start</button></div></form>`, (root, close) => {
    root.querySelector("#st").onsubmit = (e) => {
      e.preventDefault();
      const participant = root.querySelector("#st-p").value;
      const manual = !runsHere(who(participant));
      act(async () => {
        const r = await api(`${BASE}/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ participant, mode: manual ? "manual" : "agent" }) });
        close();
        if (manual) modal(`<div class="form"><h3>Your workspace is ready</h3><p>Clone, commit with the Nest trailers, push to main, then publish. The token expires at ${esc(r.expiresAt)}.</p><pre class="diff">git clone ${esc(r.remote)} ${esc(r.repo)}\ncd ${esc(r.repo)}\n# edit, then commit ending with:\n#   Nest-Task: ${esc(id)}\n#   Nest-Attempt: ${esc(id)}/e${esc(r.epoch)}\ngit -c http.extraHeader="Authorization: Bearer ${esc(r.token)}" push origin HEAD:main</pre></div>`);
      }, "Started");
    };
  });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-id], [data-ctx], [data-cand], [data-bead]");
  if (!t) return;
  if (t.matches(".tab")) { tab = t.id.replace("tab-", ""); transition(renderRight); return; }
  if (t.id === "signInBtn") return signIn();
  if (t.dataset.act === "new-project") return newProject();
  if (t.dataset.act === "invite") return invite();
  if (t.dataset.newobj) return newObjective(t.dataset.newobj);
  if (t.dataset.addctx) return addContext(t.dataset.addctx);
  if (t.dataset.bootstrap) return act(async () => { const r = await api(`/api/p/${t.dataset.bootstrap}/bootstrap`, { method: "POST", body: "{}" }); if (!r.head) throw new Error("No commit on main yet"); }, "First checkpoint created");
  if (t.dataset.pctx) { openCtx = openCtx === t.dataset.pctx ? null : t.dataset.pctx; transition(renderProject); return; }
  if (t.dataset.pctxsave) {
    const body = $("#pctx-next").value;
    return act(() => api(`/api/p/${P.project.id}/context`, { method: "POST", body: JSON.stringify({ id: t.dataset.pctxsave, body }) }), "New version accepted");
  }
  if (R.view !== "objective") return;
  if (t.dataset.id) { selected = { type: "contrib", id: t.dataset.id }; tab = "inspect"; render(); return; }
  if (t.dataset.ctx) { selected = { type: "ctx", id: t.dataset.ctx }; tab = "inspect"; render(); return; }
  if (t.dataset.open) { selected = { type: "contrib", id: t.dataset.open }; tab = "inspect"; render(); return; }
  if (t.dataset.cand) { selCand = t.dataset.cand; if (t.matches(".bead")) tab = "outcomes"; transition(() => { renderMap(); renderRight(); }); return; }
  if (t.dataset.bead) { tab = "outcomes"; transition(renderRight); return; }
  if (t.dataset.act === "new-task") return newTask();
  if (t.dataset.act === "compose") return act(() => api(`${BASE}/compose`, { method: "POST", body: "{}" }), "Composing outcomes");
  if (t.dataset.start) return startTask(t.dataset.start);
  if (t.dataset.pause) return act(() => api(`${BASE}/tasks/${t.dataset.pause}/pause`, { method: "POST", body: "{}" }), "Pause requested; the agent stops at its next boundary");
  if (t.dataset.stop) return act(() => api(`${BASE}/tasks/${t.dataset.stop}/stop`, { method: "POST", body: "{}" }), "Stopped; committed work was published");
  if (t.dataset.keep) {
    const keep = t.dataset.keep;
    const others = t.dataset.among.split(",").filter((id) => id && id !== keep);
    return act(async () => {
      for (const id of others) await api(`${BASE}/reviews`, { method: "POST", body: JSON.stringify({ target: id, verdict: "block", summary: `Overlaps ${short(keep)}; the owner chose to keep ${short(keep)}.` }) });
      await api(`${BASE}/inbox/${t.dataset.inbox}/resolve`, { method: "POST", body: JSON.stringify({ resolution: `kept ${keep}` }) });
      await api(`${BASE}/compose`, { method: "POST", body: "{}" });
    }, `Kept ${short(keep)}; recomposing`);
  }
  if (t.dataset.again) return act(() => api(`${BASE}/contributions/${t.dataset.again}/review-again`, { method: "POST", body: "{}" }), "Asked agents to review again");
  if (t.dataset.resolve) return act(() => api(`${BASE}/inbox/${t.dataset.resolve}/resolve`, { method: "POST", body: "{}" }), "Dismissed");
  if (t.dataset.review) {
    const summary = document.getElementById(`rv-${t.dataset.review}`)?.value.trim() || "";
    return act(() => api(`${BASE}/reviews`, { method: "POST", body: JSON.stringify({ target: t.dataset.review, verdict: t.dataset.verdict, summary }) }), "Review recorded");
  }
  if (t.dataset.repair) {
    const workers = S.participants.filter((p) => p.kind === "agent" && ["codex", "nest-agent"].includes(p.harness));
    return modal(`<form class="form" id="rp"><h3>Repair this outcome</h3><p>Git combined this work, but the result fails a check. The agent starts from the composed tree, gets the failing output as data, and makes the smallest fix. The planner then composes the outcome with the fix on top.</p>
      <div class="field"><label for="rp-who">Agent</label><select id="rp-who">${workers.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}, ${esc(w.model)}</option>`).join("")}</select></div>
      <div class="row"><button class="btn small primary" type="submit">Start repairing</button></div></form>`, (root, close) => {
      root.querySelector("#rp").onsubmit = (ev) => {
        ev.preventDefault();
        const participant = root.querySelector("#rp-who").value;
        act(async () => { await api(`${BASE}/candidates/${t.dataset.repair}/repair`, { method: "POST", body: JSON.stringify({ participant }) }); close(); }, "Repairing");
      };
    });
  }
  if (t.dataset.reconcile) {
    const workers = S.participants.filter((p) => p.kind === "agent" && ["codex", "nest-agent"].includes(p.harness));
    return modal(`<form class="form" id="rc"><h3>Reconcile the conflict</h3><p>The agent starts from everything that did combine, gets the conflicting change as data, and re-creates it on top. Its work replaces the conflicting contribution in every outcome.</p>
      <div class="field"><label for="rc-who">Agent</label><select id="rc-who">${workers.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}, ${esc(w.model)}</option>`).join("")}</select></div>
      <div class="row"><button class="btn small primary" type="submit">Start reconciling</button></div></form>`, (root, close) => {
      root.querySelector("#rc").onsubmit = (ev) => {
        ev.preventDefault();
        const participant = root.querySelector("#rc-who").value;
        act(async () => { await api(`${BASE}/candidates/${t.dataset.reconcile}/reconcile`, { method: "POST", body: JSON.stringify({ participant }) }); close(); }, "Reconciling");
      };
    });
  }
  if (t.dataset.accept) {
    const c = S.candidates.find((x) => x.id === t.dataset.accept);
    const stale = c.order.map((id) => S.contributions.find((x) => x.id === id)).filter((x) => x && isStale(x));
    // Approaches this acceptance turns down: the human's reason is recorded with them for later agents.
    const chosenTasks = new Set(Object.entries(c.choice ?? {}).filter(([g]) => !/^(overlap|replace):/.test(g)).map(([, id]) => S.contributions.find((x) => x.id === id)?.task));
    const groups = new Set(Object.keys(c.choice ?? {}).filter((g) => !/^(overlap|replace):/.test(g)));
    const losing = [...new Set(S.contributions.filter((x) => x.alternative && groups.has(x.alternative) && !chosenTasks.has(x.task)).map((x) => x.task))]
      .map((id) => S.tasks.find((t) => t.id === id)?.title).filter(Boolean);
    if (stale.length || losing.length) {
      return modal(`<form class="form" id="cr"><h3>Accept checkpoint ${S.head.version + 1}</h3>
        ${losing.length ? `<p>This turns down ${losing.map(esc).join(" and ")}. Say why; every later agent's context pack carries your reason.</p>
        <div class="field"><label for="cr-why">Why this approach</label><textarea id="cr-why" required minlength="12"></textarea></div>` : ""}
        ${stale.length ? `<p>${stale.length} contributions in this outcome were written against an older version of a requirement. Say why the outcome still meets the current one.</p>
        <div class="field"><label for="cr-t">Context review</label><textarea id="cr-t" required minlength="12"></textarea></div>` : ""}
        <div class="row"><button class="btn small primary" type="submit">Accept checkpoint ${S.head.version + 1}</button></div></form>`, (root, close) => {
        root.querySelector("#cr").onsubmit = (ev) => {
          ev.preventDefault();
          const reason = root.querySelector("#cr-why")?.value ?? null;
          const contextReview = root.querySelector("#cr-t")?.value ?? null;
          act(async () => { await api(`${BASE}/candidates/${c.id}/accept`, { method: "POST", body: JSON.stringify({ expectedVersion: S.head.version, contextReview, reason }) }); close(); }, "Accepted");
        };
      });
    }
    return act(() => api(`${BASE}/candidates/${c.id}/accept`, { method: "POST", body: JSON.stringify({ expectedVersion: S.head.version }) }), "Accepted");
  }
  if (t.dataset.ctxchange) {
    const body = $("#ctx-next").value;
    return act(() => api(`/api/p/${S.objective.project}/context`, { method: "POST", body: JSON.stringify({ id: t.dataset.ctxchange, body }) }), "New version accepted");
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "decide") return;
  e.preventDefault();
  savePolicy(e.target);
});

document.addEventListener("keydown", (e) => {
  const n = e.target.closest?.(".node, .bead");
  if (n && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    if (n.matches(".bead")) { if (n.dataset.cand) selCand = n.dataset.cand; tab = "outcomes"; transition(() => { renderMap(); renderRight(); }); return; }
    selected = { type: "contrib", id: n.dataset.id }; tab = "inspect"; render();
  }
});
const tip = $("#tip");
$("#map").addEventListener("pointermove", (e) => {
  const n = e.target.closest(".node, .bead");
  if (!n || !S) { tip.hidden = true; return; }
  if (n.matches(".bead")) {
    tip.innerHTML = `<b>${esc(n.getAttribute("aria-label"))}</b><span>${n.matches(".ghost") ? "Open Outcomes to review and accept it." : "Open Outcomes for the history."}</span>`;
  } else {
    const c = S.contributions.find((x) => x.id === n.dataset.id);
    tip.innerHTML = `<b>${esc(c.title)}</b><span>${esc(nameOf(c.author))}, ${reviewsOf(c.id).length} reviews.</span>`;
  }
  const box = $("#mapWrap").getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(box.width - 270, e.clientX - box.left + 14))}px`;
  tip.style.top = `${e.clientY - box.top + 14}px`;
  tip.hidden = false;
});
$("#map").addEventListener("pointerleave", () => (tip.hidden = true));
$("#ctxGroups").addEventListener("pointerover", (e) => { const b = e.target.closest("[data-ctx]"); const id = b?.dataset.ctx ?? null; if (id !== hoverCtx) { hoverCtx = id; if (S) renderMap(); } });
$("#ctxGroups").addEventListener("pointerleave", () => { hoverCtx = null; if (S) renderMap(); });
$("#ctxSearch").addEventListener("input", () => S && renderRail());
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => S && renderMap(), 120); });

document.body.dataset.view = R.view;
$("#page").hidden = R.view === "objective";
$("#shell").hidden = R.view !== "objective";
if (R.view === "objective") {
  await refresh();
  await loadEvents().catch(() => undefined);
  renderStream();
  connect();
} else {
  await reload();
}
