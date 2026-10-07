// Nest work map: live state from the Objective Durable Object, rendered as lanes of contributions.
// Every string from agents (titles, messages, reviews) is escaped before it reaches the DOM.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const short = (id) => String(id).replace(/^c_/, "").slice(0, 4);

let S = null;            // last /api/state
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
    S = await api("/api/state");
    render();
  } catch (e) {
    toast(`Could not load state: ${e.message}`);
  }
}

async function loadEvents() {
  const list = await api(`/api/events?after=0`);
  events = list.reverse();
  lastSeq = events[0]?.seq ?? 0;
}

function connect(delay = 500) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
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
const owner = () => S?.me === "owner";

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
  $("#objectiveTitle").textContent = S.objective.title ?? "Objective";
  $("#projectName").textContent = S.objective.project ? S.objective.project[0].toUpperCase() + S.objective.project.slice(1) : "Project";
  $("#headVer").textContent = S.head ? `checkpoint ${S.head.version}` : "not seeded";
  const people = S.participants.filter((p) => p.kind === "person").length;
  $("#peopleCount").textContent = people;
  $("#peopleNoun").textContent = people === 1 ? "person," : "people,";
  $("#agentCount").textContent = S.participants.filter((p) => p.kind === "agent").length;
  $("#spend").textContent = `$${(S.spend.usedMicroUsd / 1e6).toFixed(2)}`;
  $("#signInBtn").textContent = owner() ? "Signed in" : "Sign in";
  $("#signInBtn").disabled = owner();
  renderTools();
  renderRail();
  renderTasks();
  renderMap();
  renderRight();
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
  $("#ctxGroups").innerHTML = html;
  const citations = S.contributions.reduce((n, c) => n + c.cites.length, 0);
  $("#store").innerHTML = `<span>Context items</span><b>${S.context.length}</b><span>Citations tracked</span><b>${citations}</b><span>Contributions</span><b>${S.contributions.length}</b><span>Reviews</span><b>${S.reviews.filter((r) => !r.triage).length}</b>`;
}

function renderTasks() {
  $("#tasks").innerHTML = S.tasks.map((t) => {
    const p = t.participant ? who(t.participant) : null;
    const st = { open: "Open", running: "Running", paused: "Paused at boundary", done: "Done", failed: "Failed" }[t.status] ?? t.status;
    const cls = t.status === "running" ? "running" : t.status === "paused" ? "paused" : t.status === "done" ? "done" : "";
    const acts = owner()
      ? (t.status === "running" ? `<button data-pause="${esc(t.id)}" type="button">Pause</button>`
        : t.status !== "done" ? `<button data-start="${esc(t.id)}" type="button">${t.status === "paused" ? "Hand over" : "Start"}</button>` : "")
      : "";
    return `<span class="task ${cls}"><span class="dot"></span><b>${esc(t.title)}</b><span>${p ? `${esc(p.name)}, ${esc(p.model)}` : "unassigned"}${t.epoch > 1 ? `, attempt ${t.epoch}` : ""}</span><span class="state">${st}</span>${acts ? `<span class="actions">${acts}</span>` : ""}</span>`;
  }).join("") || `<span class="task">No tasks yet${owner() ? ". Create one with New task." : "."}</span>`;
}

// ---------- map ----------

const G = { w: 900, top: 34, laneH: 62, labelW: 168, right: 40 };

function lanes() {
  const ts = [...S.tasks];
  // Keep tasks in the same alternative group next to each other.
  ts.sort((a, b) => (a.alternative ?? "~").localeCompare(b.alternative ?? "~") || a.createdAt.localeCompare(b.createdAt));
  const order = [...ts.filter((t) => t.alternative), ...ts.filter((t) => !t.alternative)];
  return order.map((t) => ({ id: t.id, name: t.title, alt: t.alternative }));
}

function geometry() {
  const L = lanes();
  const slots = Math.max(8, S.contributions.length + 1);
  G.w = Math.max(640, $("#mapWrap").clientWidth);
  G.h = G.top + Math.max(1, L.length) * G.laneH + 22;
  G.spineX = G.labelW + 10;
  G.left = G.labelW + 52;
  const laneY = (task) => G.top + Math.max(0, L.findIndex((l) => l.id === task)) * G.laneH + G.laneH / 2;
  const order = [...S.contributions].sort((a, b) => a.seq - b.seq).map((c) => c.id);
  const slotX = (id) => G.left + order.indexOf(id) * ((G.w - G.left - G.right) / (slots - 1));
  const all = [...S.context];
  const spineY = (item) => G.top + 15 + ((Math.max(1, L.length) * G.laneH - 30) * Math.max(0, all.findIndex((c) => c.id === item))) / Math.max(1, all.length - 1);
  return { L, pos: (id) => { const c = S.contributions.find((x) => x.id === id); return c ? { x: slotX(id), y: laneY(c.task) } : null; }, spineY };
}

const curve = (x0, y0, x1, y1) => { const dx = Math.max(30, (x1 - x0) / 2); return `M${x0},${y0} C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`; };

function renderMap() {
  const svg = $("#map");
  const empty = $("#mapEmpty");
  if (!S.contributions.length) {
    svg.innerHTML = "";
    svg.setAttribute("height", 220);
    empty.hidden = false;
    empty.innerHTML = `<div><h3>No contributions yet</h3><p>${S.tasks.length ? "Agents publish here as they push. Each commit appears as a node in its task's lane." : "Create a task and start an agent or a person on it. Every commit they push appears here."}</p></div>`;
    return;
  }
  empty.hidden = true;
  const { L, pos, spineY } = geometry();
  svg.setAttribute("width", G.w);
  svg.setAttribute("height", G.h);
  svg.setAttribute("viewBox", `0 0 ${G.w} ${G.h}`);
  const out = [`<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="hatch-line"/></pattern></defs>`];
  L.forEach((l, i) => {
    const y = G.top + i * G.laneH;
    out.push(`<rect class="lane-bg ${i % 2 ? "alt" : ""}" x="0" y="${y}" width="${G.w}" height="${G.laneH}"/>`);
    out.push(`<text class="lane-name" x="16" y="${y + G.laneH / 2 + (l.alt ? 0 : 4)}">${esc(l.name.length > 22 ? `${l.name.slice(0, 21)}…` : l.name)}</text>`);
    if (l.alt) out.push(`<text class="lane-sub" x="16" y="${y + G.laneH / 2 + 15}">choose one: ${esc(l.alt)}</text>`);
  });
  const altLanes = L.map((l, i) => ({ ...l, i })).filter((l) => l.alt);
  for (const group of [...new Set(altLanes.map((l) => l.alt))]) {
    const ix = altLanes.filter((l) => l.alt === group).map((l) => l.i);
    if (ix.length < 2) continue;
    const y0 = G.top + Math.min(...ix) * G.laneH + 12, y1 = G.top + (Math.max(...ix) + 1) * G.laneH - 12;
    out.push(`<path class="bracket" d="M8,${y0} L4,${y0} L4,${y1} L8,${y1}"/>`);
  }
  out.push(`<text class="axis" x="${G.left}" y="20">Earlier</text><text class="axis" x="${G.w - G.right}" y="20" text-anchor="end">Later</text>`);
  out.push(`<line class="spine" x1="${G.spineX}" y1="${G.top + 6}" x2="${G.spineX}" y2="${G.top + L.length * G.laneH - 6}"/>`);
  for (const c of S.candidates.filter((x) => !["superseded"].includes(x.status))) {
    const pts = c.order.map(pos).filter(Boolean).sort((a, b) => a.x - b.x);
    if (pts.length < 2) continue;
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], dx = (b.x - a.x) / 2; d += ` C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; }
    out.push(`<path class="thread ${c.id === selCand ? "sel" : ""}" d="${d}"/>`);
  }
  const sel = selected?.type === "contrib" ? selected.id : null;
  for (const c of S.contributions) for (const r of c.requires) {
    const a = pos(r), b = pos(c.id);
    if (a && b) out.push(`<path class="dep ${sel && (sel === c.id || sel === r) ? "hl" : ""}" d="${curve(a.x, a.y, b.x, b.y)}"/>`);
  }
  if (hoverCtx) for (const c of S.contributions) if (c.cites.some((x) => x.item === hoverCtx)) { const p = pos(c.id); out.push(`<path class="cite" d="${curve(G.spineX, spineY(hoverCtx), p.x, p.y)}"/>`); }
  for (const c of S.context) { const y = spineY(c.id); out.push(`<rect class="spine-mark ${hoverCtx === c.id ? "on" : ""}" data-spine="${esc(c.id)}" x="${G.spineX - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${G.spineX} ${y})"><title>${esc(c.title)}</title></rect>`); }
  out.push(`<g id="fx"></g>`);
  const picks = new Set(S.candidates.find((x) => x.id === selCand)?.order ?? []);
  const asks = new Set(openInbox().map((i) => i.target));
  for (const c of S.contributions) {
    const p = pos(c.id);
    const person = who(c.author)?.kind === "person";
    const st = isStale(c) ? "stale" : c.status;
    const ticks = reviewsOf(c.id).slice(-4).map((r, i, arr) => {
      const x = (i - (arr.length - 1) / 2) * 9, y = 22;
      if (r.kind === "person") return `<rect class="tick ${r.verdict === "approve" ? "hm" : "hm-ch"}" x="${x - 3}" y="${y - 3}" width="6" height="6" rx="1"/>`;
      if (r.verdict === "approve") return `<circle class="tick ok" cx="${x}" cy="${y}" r="3"/>`;
      if (r.verdict === "changes" || r.verdict === "comment") return `<circle class="tick ch" cx="${x}" cy="${y}" r="2.8"/>`;
      return `<path class="tick bl" d="M${x - 3},${y - 3} L${x + 3},${y + 3} M${x + 3},${y - 3} L${x - 3},${y + 3}"/>`;
    }).join("");
    const shape = person ? `<rect class="body" x="-10.5" y="-10.5" width="21" height="21" rx="4.5"/>` : `<circle class="body" r="11.5"/>`;
    const mark = st === "blocked" || st === "changes" ? `<line class="mark" x1="-15" y1="15" x2="15" y2="-15" opacity="0.7"/>` : "";
    const ini = esc(nameOf(c.author)[0] ?? "?");
    const label = `${c.title}, by ${nameOf(c.author)}. ${{ proposed: "Awaiting review", approved: "Approved", changes: "Changes requested", blocked: "Blocked", stale: "Relied on old context", accepted: "Accepted", superseded: "Retired" }[st] ?? st}`;
    out.push(`<g class="node st-${st} ${sel === c.id ? "sel" : ""}" data-id="${esc(c.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(label)}">${asks.has(c.id) ? `<circle class="ask" r="22"/>` : ""}${picks.has(c.id) ? `<circle class="ring" r="17"/>` : ""}${shape}${mark}<text class="ini">${ini}</text><text class="nid" y="-18">${esc(short(c.id))}</text>${ticks}</g>`);
  }
  svg.innerHTML = out.join("");
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
  return `<div class="review"><div class="row"><span class="who"><span class="glyph ${p?.kind ?? "agent"}">${esc((p?.name ?? "?")[0])}</span><b>${esc(p?.name ?? r.reviewer)}</b><span>${esc(p?.kind === "agent" ? p.model : "person")}</span></span><span class="verdict">${esc({ approve: "Approved", changes: "Requested changes", block: "Blocked", comment: "Commented" }[r.verdict] ?? r.verdict)}</span></div>
    <q>${esc(r.summary)}</q>${r.findings?.length ? `<ul class="reasons">${r.findings.slice(0, 5).map((f) => `<li>${esc(f.path ? `${f.path}${f.line ? `:${f.line}` : ""} ` : "")}${esc(f.text)}${f.cite ? ` <span class="id">[${esc(f.cite)}]</span>` : ""}</li>`).join("")}</ul>` : ""}
    <div class="meta">${p?.kind === "agent" ? `<span>Confidence ${Number(r.confidence).toFixed(2)}</span>` : ""}</div></div>`;
}

/** What a real browser saw after clicking Export CSV on this outcome's preview. */
function shotHtml(c) {
  const click = c.checks.find((k) => k.id === "export-click");
  if (!click || click.status === "ERROR") return "";
  return `<figure class="shot"><img src="/shots/${esc(c.id)}.png" alt="The outcome's page after a browser clicked Export CSV" loading="lazy" width="1100" height="720"><figcaption>${esc(click.detail)}</figcaption></figure>`;
}

function checksHtml(c) {
  if (!c.checks.length) return `<div class="checks"><span style="font-size:12.5px;color:var(--muted)">Checks not run yet</span></div>`;
  const pass = c.checks.filter((k) => k.status === "PASS").length;
  const kind = (k) => (k.status === "PASS" ? "pass" : k.atHead && k.atHead !== "PASS" ? "todo" : "fail");
  const says = { pass: "passes", todo: "not done yet", fail: "broken" };
  return `<div class="checks">${c.checks.map((k) => `<span class="chk ${kind(k)}" title="${esc(k.id)}: ${says[kind(k)]}"></span>`).join("")}<span style="font-size:12.5px;color:var(--muted);margin-left:6px">${pass} of ${c.checks.length} checks</span></div>`;
}

const statusLabel = { composing: "Composing", ready: "Ready", waiting: "Waiting on review", incomplete: "Incomplete", failing: "Breaks a check", conflict: "Conflict", outdated: "Outdated", accepted: "Accepted", superseded: "Superseded" };

function inboxHtml() {
  const items = openInbox();
  if (!items.length) return `<div class="empty"><h4>Nothing needs you right now</h4><p>Agents review every push. You are asked when reviewers disagree, when a review blocks, when protected files change, and when an outcome is ready to accept.</p></div>`;
  return items.map((i) => {
    if (i.kind === "accept") {
      const c = S.candidates.find((x) => x.id === i.target);
      if (!c) return "";
      return `<div class="card focus"><h4>${esc(c.name)} is ready</h4><p>All checks pass on the composed result and every contribution in it is approved.</p>${checksHtml(c)}
        <div class="picks">${c.order.map((id) => `<span class="pick"><span class="id">${esc(short(id))}</span>${esc(S.contributions.find((x) => x.id === id)?.title ?? "")}</span>`).join("")}</div>
        ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
        <div class="row">${owner() ? `<button class="btn small primary" data-accept="${esc(c.id)}" type="button">Accept checkpoint ${S.head.version + 1}</button>` : ""}${c.previewReady ? `<a class="btn small" href="/preview/${esc(c.id)}/" target="_blank" rel="noopener">Open preview</a>` : ""}</div></div>`;
    }
    if (i.kind === "conflict") {
      const k = S.candidates.find((x) => x.id === i.target);
      if (!k) return "";
      const members = k.order.map((id) => S.contributions.find((x) => x.id === id)).filter(Boolean);
      const overlapping = members.filter((m) => m.paths.some((p) => (k.conflict ?? "").includes(p)));
      return `<div class="card focus"><h4>Overlapping work in ${esc(k.name)}</h4><p>Real git could not combine these contributions. Keep one and the others are blocked with that reason, or have an agent reconcile them.</p>
        <div class="fail-line">${esc(k.conflict ?? "")}</div>
        ${overlapping.map((m) => `<div class="review"><div class="row" style="justify-content:space-between"><span class="who"><b>${esc(nameOf(m.author))}</b><span class="id">${esc(short(m.id))}</span></span>${owner() ? `<button class="btn small" data-keep="${esc(m.id)}" data-among="${esc(overlapping.map((x) => x.id).join(","))}" data-inbox="${esc(i.id)}" type="button">Keep this one</button>` : ""}</div><q>${esc(m.title)}</q><div class="meta"><span class="id">${m.paths.map(esc).join(", ")}</span></div></div>`).join("")}
        ${owner() ? `<div class="row"><button class="btn small primary" data-reconcile="${esc(k.id)}" type="button">Reconcile with an agent</button><button class="btn small" data-resolve="${esc(i.id)}" type="button">Dismiss</button></div>` : ""}</div>`;
    }
    const c = S.contributions.find((x) => x.id === i.target);
    if (!c) return "";
    return `<div class="card focus"><h4>${esc(c.title)}</h4><p>${esc(nameOf(c.author))} published <span class="id">${esc(short(c.id))}</span>. A person is needed:</p>
      <ul class="reasons">${i.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${reviewsOf(c.id).map(reviewHtml).join("")}
      ${owner() ? `<div class="field"><label for="rv-${esc(c.id)}">Your review</label><input id="rv-${esc(c.id)}" placeholder="One sentence: why"></div>
      <div class="row"><button class="btn small primary" data-review="${esc(c.id)}" data-verdict="approve" type="button">Approve</button><button class="btn small" data-review="${esc(c.id)}" data-verdict="changes" type="button">Request changes</button><button class="btn small" data-review="${esc(c.id)}" data-verdict="block" type="button">Block</button></div>` : ""}
      <div class="row"><button class="btn small" data-open="${esc(c.id)}" type="button">Open contribution</button></div></div>`;
  }).join("");
}

function outcomesHtml() {
  const list = S.candidates.filter((c) => c.status !== "superseded");
  if (!list.length) return `<div class="empty"><h4>No outcomes yet</h4><p>When contributions arrive, Nest assembles every compatible combination, merges it with real git and runs the trusted checks on the whole result.</p></div>`;
  const rank = { ready: 0, accepted: 1, waiting: 2, composing: 3, incomplete: 4, failing: 5, conflict: 6, outdated: 7 };
  return list.slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)).map((c) => `
    <div class="card ${c.id === selCand ? "focus" : ""}"><div class="row" style="justify-content:space-between"><h4>${esc(c.name)}</h4><span class="status ${c.status === "ready" ? "ready" : c.status === "accepted" ? "accepted" : c.status === "outdated" ? "outdated" : ""}">${esc(statusLabel[c.status] ?? c.status)}</span></div>
    <div class="row"><span class="id" style="color:var(--muted)">${esc(c.id)}</span><span style="font-size:12.5px;color:var(--muted)">on checkpoint ${c.baseVersion}</span></div>
    ${checksHtml(c)}${c.checks.filter((k) => k.status !== "PASS").sort((a, b) => Number(b.atHead === "PASS") - Number(a.atHead === "PASS")).map((k) => `<div class="fail-line ${k.atHead === "PASS" ? "" : "todo"}"><b>${esc(k.id)}</b> ${k.atHead === "PASS" ? "Broken: passes on the checkpoint, fails here. " : k.atHead ? "Not done yet. " : ""}${esc(k.detail)}</div>`).join("")}
    ${c.conflict ? `<div class="fail-line">${esc(c.conflict)}</div>` : ""}
    ${shotHtml(c)}
    <div class="picks">${c.order.map((id) => `<span class="pick"><span class="id">${esc(short(id))}</span>${esc(S.contributions.find((x) => x.id === id)?.title ?? "")}</span>`).join("")}</div>
    ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
    <div class="row"><button class="btn small" data-cand="${esc(c.id)}" type="button">Show on map</button>${c.previewReady ? `<a class="btn small" href="/preview/${esc(c.id)}/" target="_blank" rel="noopener">Open preview</a>` : ""}${owner() && c.status === "ready" ? `<button class="btn small primary" data-accept="${esc(c.id)}" type="button">Accept checkpoint ${S.head.version + 1}</button>` : ""}</div></div>`).join("");
}

function inspectHtml() {
  if (!selected) return `<div class="empty"><h4>Select anything on the map</h4><p>A contribution shows its message, the context it cites, its changed files and every review from people and agents. A context item shows what relies on it.</p></div>`;
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
  for (const k of ["inbox", "outcomes", "inspect"]) $(`#tab-${k}`).setAttribute("aria-selected", String(tab === k));
  const n = openInbox().length;
  $("#inboxCount").textContent = n; $("#inboxCount").classList.toggle("zero", n === 0);
  const live = S.candidates.filter((c) => c.status !== "superseded").length;
  $("#outCount").textContent = live; $("#outCount").classList.toggle("zero", live === 0);
  $("#rightBody").innerHTML = tab === "inbox" ? inboxHtml() : tab === "outcomes" ? outcomesHtml() : inspectHtml();
}

// ---------- actions ----------

async function act(fn, done) {
  try { await fn(); if (done) toast(done); await refresh(); } catch (e) { toast(e.message); }
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
      act(async () => { await api("/api/tasks", { method: "POST", body: JSON.stringify({ id: v("#nt-id"), title: v("#nt-title"), brief: v("#nt-brief"), alternative: v("#nt-alt") || null }) }); close(); }, "Task created");
    };
  });
}

function startTask(id) {
  const workers = S.participants.filter((p) => ["codex", "nest-agent", "opencode", "external"].includes(p.harness) || p.kind === "person");
  const t = S.tasks.find((x) => x.id === id);
  modal(`<form class="form" id="st"><h3>${t.status === "paused" ? "Hand over" : "Start"} ${esc(t.title)}</h3><p>${t.status === "paused" ? "The next participant continues from the paused tree, the saved uncommitted work and the notes." : "Nest forks the accepted checkpoint into a workspace for this attempt."}</p>
    <div class="field"><label for="st-p">Participant</label><select id="st-p">${workers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.kind === "person" ? "person, push from your machine" : `${p.harness}, ${p.model}`)})</option>`).join("")}</select></div>
    <div class="row"><button class="btn small primary" type="submit">Start</button></div></form>`, (root, close) => {
    root.querySelector("#st").onsubmit = (e) => {
      e.preventDefault();
      const participant = root.querySelector("#st-p").value;
      const person = who(participant)?.kind === "person";
      act(async () => {
        const r = await api(`/api/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ participant, mode: person ? "manual" : "agent" }) });
        close();
        if (person) modal(`<div class="form"><h3>Your workspace is ready</h3><p>Clone, commit with the Nest trailers, push to main, then publish. The token expires at ${esc(r.expiresAt)}.</p><pre class="diff">git clone ${esc(r.remote)} ${esc(r.repo)}\ncd ${esc(r.repo)}\n# edit, then commit ending with:\n#   Nest-Task: ${esc(id)}\n#   Nest-Attempt: ${esc(id)}/e${esc(r.epoch)}\ngit -c http.extraHeader="Authorization: Bearer ${esc(r.token)}" push origin HEAD:main</pre></div>`);
      }, "Started");
    };
  });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-id], [data-ctx]");
  if (!t) return;
  if (t.matches(".tab")) { tab = t.id.replace("tab-", ""); renderRight(); return; }
  if (t.id === "signInBtn") return signIn();
  if (t.dataset.id) { selected = { type: "contrib", id: t.dataset.id }; tab = "inspect"; render(); return; }
  if (t.dataset.ctx) { selected = { type: "ctx", id: t.dataset.ctx }; tab = "inspect"; render(); return; }
  if (t.dataset.open) { selected = { type: "contrib", id: t.dataset.open }; tab = "inspect"; render(); return; }
  if (t.dataset.cand) { selCand = t.dataset.cand; renderMap(); renderRight(); return; }
  if (t.dataset.act === "new-task") return newTask();
  if (t.dataset.act === "compose") return act(() => api("/api/compose", { method: "POST", body: "{}" }), "Composing outcomes");
  if (t.dataset.start) return startTask(t.dataset.start);
  if (t.dataset.pause) return act(() => api(`/api/tasks/${t.dataset.pause}/pause`, { method: "POST", body: "{}" }), "Pause requested; the agent stops at its next boundary");
  if (t.dataset.keep) {
    const keep = t.dataset.keep;
    const others = t.dataset.among.split(",").filter((id) => id && id !== keep);
    return act(async () => {
      for (const id of others) await api("/api/reviews", { method: "POST", body: JSON.stringify({ target: id, verdict: "block", summary: `Overlaps ${short(keep)}; the owner chose to keep ${short(keep)}.` }) });
      await api(`/api/inbox/${t.dataset.inbox}/resolve`, { method: "POST", body: JSON.stringify({ resolution: `kept ${keep}` }) });
      await api("/api/compose", { method: "POST", body: "{}" });
    }, `Kept ${short(keep)}; recomposing`);
  }
  if (t.dataset.resolve) return act(() => api(`/api/inbox/${t.dataset.resolve}/resolve`, { method: "POST", body: "{}" }), "Dismissed");
  if (t.dataset.review) {
    const summary = document.getElementById(`rv-${t.dataset.review}`)?.value.trim() || "";
    return act(() => api("/api/reviews", { method: "POST", body: JSON.stringify({ target: t.dataset.review, verdict: t.dataset.verdict, summary }) }), "Review recorded");
  }
  if (t.dataset.reconcile) {
    const workers = S.participants.filter((p) => p.kind === "agent" && ["codex", "nest-agent"].includes(p.harness));
    return modal(`<form class="form" id="rc"><h3>Reconcile the conflict</h3><p>The agent starts from everything that did combine, gets the conflicting change as data, and re-creates it on top. Its work replaces the conflicting contribution in every outcome.</p>
      <div class="field"><label for="rc-who">Agent</label><select id="rc-who">${workers.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}, ${esc(w.model)}</option>`).join("")}</select></div>
      <div class="row"><button class="btn small primary" type="submit">Start reconciling</button></div></form>`, (root, close) => {
      root.querySelector("#rc").onsubmit = (ev) => {
        ev.preventDefault();
        const participant = root.querySelector("#rc-who").value;
        act(async () => { await api(`/api/candidates/${t.dataset.reconcile}/reconcile`, { method: "POST", body: JSON.stringify({ participant }) }); close(); }, "Reconciling");
      };
    });
  }
  if (t.dataset.accept) {
    const c = S.candidates.find((x) => x.id === t.dataset.accept);
    const stale = c.order.map((id) => S.contributions.find((x) => x.id === id)).filter((x) => x && isStale(x));
    // Approaches this acceptance turns down: the person's reason is recorded with them for later agents.
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
          act(async () => { await api(`/api/candidates/${c.id}/accept`, { method: "POST", body: JSON.stringify({ expectedVersion: S.head.version, contextReview, reason }) }); close(); }, "Accepted");
        };
      });
    }
    return act(() => api(`/api/candidates/${c.id}/accept`, { method: "POST", body: JSON.stringify({ expectedVersion: S.head.version }) }), "Accepted");
  }
  if (t.dataset.ctxchange) {
    const body = $("#ctx-next").value;
    return act(() => api("/api/context", { method: "POST", body: JSON.stringify({ id: t.dataset.ctxchange, body }) }), "New version accepted");
  }
});

document.addEventListener("keydown", (e) => {
  const n = e.target.closest?.(".node");
  if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selected = { type: "contrib", id: n.dataset.id }; tab = "inspect"; render(); }
});
const tip = $("#tip");
$("#map").addEventListener("pointermove", (e) => {
  const n = e.target.closest(".node");
  if (!n || !S) { tip.hidden = true; return; }
  const c = S.contributions.find((x) => x.id === n.dataset.id);
  tip.innerHTML = `<b>${esc(c.title)}</b><span>${esc(nameOf(c.author))}. ${reviewsOf(c.id).length} reviews.</span>`;
  const box = $("#mapWrap").getBoundingClientRect();
  tip.style.left = `${Math.min(box.width - 270, e.clientX - box.left + 14)}px`;
  tip.style.top = `${e.clientY - box.top + 14}px`;
  tip.hidden = false;
});
$("#map").addEventListener("pointerleave", () => (tip.hidden = true));
$("#ctxGroups").addEventListener("pointerover", (e) => { const b = e.target.closest("[data-ctx]"); const id = b?.dataset.ctx ?? null; if (id !== hoverCtx) { hoverCtx = id; if (S) renderMap(); } });
$("#ctxGroups").addEventListener("pointerleave", () => { hoverCtx = null; if (S) renderMap(); });
$("#ctxSearch").addEventListener("input", () => S && renderRail());
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => S && renderMap(), 120); });

await refresh();
await loadEvents().catch(() => undefined);
renderStream();
connect();
