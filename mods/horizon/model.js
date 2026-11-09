// Pure data preparation for the Horizon layout. No timers,
// process access or rendering.

export const firstLine = value => String(value ?? "").split(/\r?\n/)[0];
export const machineOf = address => address.includes("/") ? address.slice(0, address.indexOf("/")) : null;
const localId = id => String(id ?? "").split("/").pop();

export const doneKey = t =>
  `${t?.turn ?? 0}:${t?.status_ms ?? 0}:${t?.labels?.["orch.status"] ?? ""}`;

// Persisted deck layout configuration: height, expanded space count and the
// agent / OTHER SPACES grid shapes, normalized into guaranteed ranges.
export const DEFAULT_CONFIG = {
  deckHeight: 235,
  maxExpanded: 4,
  fullWidthMax: 2,
  agentCols: 2,
  agentRows: 3,
  otherCols: 2,
  otherRows: 4,
  windowDrag: "auto",
  titlebar: "none",
};

const clampInt = (v, min, max, fallback) => {
  const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback;
  return Math.max(min, Math.min(max, n));
};

export function normalizeConfig(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    deckHeight: clampInt(r.deckHeight, 175, 360, DEFAULT_CONFIG.deckHeight),
    maxExpanded: clampInt(r.maxExpanded, 2, 6, DEFAULT_CONFIG.maxExpanded),
    fullWidthMax: clampInt(r.fullWidthMax, 0, 4, DEFAULT_CONFIG.fullWidthMax),
    agentCols: clampInt(r.agentCols, 1, 2, DEFAULT_CONFIG.agentCols),
    agentRows: clampInt(r.agentRows, 2, 5, DEFAULT_CONFIG.agentRows),
    otherCols: clampInt(r.otherCols, 1, 3, DEFAULT_CONFIG.otherCols),
    otherRows: clampInt(r.otherRows, 2, 6, DEFAULT_CONFIG.otherRows),
    windowDrag: ["auto", "on", "off"].includes(r.windowDrag) ? r.windowDrag : DEFAULT_CONFIG.windowDrag,
    titlebar: ["none", "system"].includes(r.titlebar) ? r.titlebar : DEFAULT_CONFIG.titlebar,
  };
}

// Window drag: "on"/"off" are explicit; "auto" drags on Windows/macOS only,
// where frameless windows have no native title bar to move the window by.
export function isWindowDragEnabled(cfg = DEFAULT_CONFIG, platform = "linux") {
  if (cfg?.windowDrag === "on") return true;
  if (cfg?.windowDrag === "off") return false;
  return platform === "windows" || platform === "macos";
}

// Urgency for a single agent: blocked > error > working > done > idle.
export const AGENT_RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
// Urgency for a space box: blocked > error > working > done > idle.
export const SPACE_RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };

export function normalizeStatus(status, child = false) {
  if (child && status === "done") return "idle";
  return ["working", "blocked", "error", "done", "idle"].includes(status) ? status : null;
}

// A dispatched hc worker (herdr-orch label or wrk-* naming) reports status via
// orch.status first, then its CLI status, and only then falls back to "working".
// Finished subagents (done/idle) clear automatically: a terminal child/worker
// reports null so it drops out of collectAgents entirely.
function workerStatus(t) {
  const isWorker = Boolean(t.labels?.spec) || /^wrk-/.test(t.name ?? "");
  const orch = t.labels?.["orch.status"];
  const fromOrch = ["working", "blocked", "error", "done", "idle"].includes(orch) ? orch : null;
  const status = fromOrch ?? normalizeStatus(t.status, !isWorker);
  const resolved = status ?? ((t.program?.agent || isWorker) ? "working" : null);
  if ((t.parent || isWorker) && (resolved === "done" || resolved === "idle")) return null;
  return resolved;
}

const workerMeta = t => ({
  name: t.name ?? null, tier: t.labels?.tier ?? null,
  spec: t.labels?.spec ?? null, cwd: t.cwd ?? null,
});

// agents() supplies native unseen-done semantics. Only raw children supplement it.
export function collectAgents(listed, raw, sectors, acked = {}) {
  const live = raw.filter(t => !t.state || t.state === "live");
  const rawByAddress = new Map(live.map(t => [t.address, t]));
  const result = new Map();
  for (const a of listed) {
    const t = rawByAddress.get(a.address);
    const dKey = doneKey(t);
    const isAcked = Boolean(dKey && acked && acked[a.address] === dKey);
    const sector = sectors.find(s => s.id === a.space);
    const tabObj = sector?.tabs?.find(tb => tb.id === a.tab);
    const orch = ["working", "blocked", "error", "done", "idle"].includes(t?.labels?.["orch.status"])
      ? t.labels["orch.status"] : null;
    const rawSt = normalizeStatus(t?.report?.state, false) ?? normalizeStatus(t?.status, false);
    const listedSt = normalizeStatus(a.status, false);
    let status;
    if (rawSt === "error" || orch === "error") {
      status = "error";
    } else if (orch && orch !== "done") {
      status = orch;
    } else if (orch === "done" || rawSt === "done" || listedSt === "done") {
      status = isAcked ? "idle" : "done";
    } else {
      status = listedSt ?? rawSt ?? "idle";
    }
    result.set(a.address, {
      ...a, title: a.title || t?.report?.title || a.program?.name || t?.program?.name || a.address,
      status, done_key: dKey,
      child: false,
      kind: firstLine(t?.report?.kind), msg: firstLine(t?.report?.msg),
      machine: machineOf(a.address), status_ms: t?.status_ms ?? null,
      name: a.name ?? t?.name ?? null, tier: a.tier ?? t?.labels?.tier ?? null,
      spec: a.spec ?? t?.labels?.spec ?? null, cwd: a.cwd ?? t?.cwd ?? null,
      tab_named: Boolean(tabObj?.named),
    });
  }
  // Resolve descendants even if terminals() puts a child before its parent.
  let pending = live.filter(t => !result.has(t.address) &&
    (t.parent || t.labels?.["herdr.space"] || t.labels?.spec || /^wrk-/.test(t.name ?? "")));
  for (let pass = 0; pending.length && pass <= live.length; pass++) {
    const rest = [];
    for (const t of pending) {
      const parent = result.get(t.parent);
      const status = workerStatus(t);
      if (!parent) { rest.push(t); continue; }
      if (!status) continue; // A plain child shell is not a reporting agent.
      result.set(t.address, {
        address: t.address, pane: null, space: parent.space,
        space_name: parent.space_name, tab: parent.tab, tab_name: parent.tab_name,
        status, child: true, parent: t.parent, machine: machineOf(t.address),
        title: t.report?.title || t.title || t.name || t.program?.name || "Child agent",
        program: t.program, kind: firstLine(t.report?.kind), msg: firstLine(t.report?.msg),
        status_ms: t.status_ms ?? null, ...workerMeta(t),
      });
    }
    if (rest.length === pending.length) break;
    pending = rest;
  }
  // An orphan with usable layout labels must not disappear from attention.
  for (const t of pending) {
    const status = workerStatus(t);
    if (!status) continue;
    const sector = sectors.find(s => s.machine === machineOf(t.address) &&
      localId(s.id) === t.labels?.["herdr.space"]);
    const tab = sector?.tabs.find(tab => localId(tab.id) === t.labels?.["herdr.tab"]);
    result.set(t.address, {
      address: t.address, pane: null, space: sector?.id ?? `unplaced:${machineOf(t.address) ?? "local"}`,
      space_name: sector?.name ?? "Unplaced child", tab: tab?.id ?? "unplaced",
      tab_name: tab?.name ?? "No tab", status, child: true, parent: t.parent,
      machine: machineOf(t.address), title: t.report?.title || t.title || t.name || "Child agent",
      program: t.program, kind: firstLine(t.report?.kind), msg: firstLine(t.report?.msg),
      status_ms: t.status_ms ?? null, ...workerMeta(t),
    });
  }
  // Roll active child/worker status up to the parent terminal so neither the
  // parent nor its space box prematurely reads done/idle while a subagent is
  // still working (or blocked/error).
  for (const c of result.values()) {
    if (!(c.child === true || /^wrk-/.test(c.name ?? "") || Boolean(c.spec))) continue;
    if (!["working", "blocked", "error"].includes(c.status)) continue;
    const parent = (c.parent && result.get(c.parent))
      || [...result.values()].find(a => !a.child && a.space === c.space && a.tab === c.tab)
      || [...result.values()].find(a => !a.child && a.space === c.space);
    if (!parent) continue;
    if ((c.status === "blocked" || c.status === "error")
      && AGENT_RANK[c.status] < AGENT_RANK[parent.status]) {
      parent.status = c.status;
    } else if (c.status === "working" && (parent.status === "done" || parent.status === "idle")) {
      parent.status = "working";
    }
  }
  return [...result.values()];
}

// Active (working/blocked/error) hc child/worker terminals belonging to the selected
// space, for the right-hand SUBAGENTS rail; most urgent first, then by name.
export function collectSubagents(live, activeSpaceId) {
  return live
    .filter(a => (a.child === true || /^wrk-/.test(a.name ?? "") || Boolean(a.spec))
      && ["working", "blocked", "error"].includes(a.status)
      && (!activeSpaceId || a.space === activeSpaceId))
    .sort((a, b) => (AGENT_RANK[a.status] - AGENT_RANK[b.status])
      || String(a.name || a.address).localeCompare(String(b.name || b.address)));
}

// A space's status is the most urgent of its agents: blocked > error > working
// > done > idle. Working naturally outranks done, so a space only reads "done"
// once all active work in it has completed.
export function spaceStatus(space, list) {
  let best = "idle";
  for (const a of list) {
    if (a.space !== space.id) continue;
    if (AGENT_RANK[a.status] < AGENT_RANK[best]) best = a.status;
  }
  return best;
}

// Priority-ordered spaces for the deck: blocked > error > working > done > idle,
// then most recently accessed, then declaration order.
export function sortSpaces(sectors, list, lastActiveMap = {}, raw = []) {
  return [...sectors].map((s, i) => {
    const status = spaceStatus(s, list);
    const rank = SPACE_RANK[status] ?? 4;
    const lastActiveMs = spaceLastActiveMs(s, list, raw, lastActiveMap);
    return { space: s, rank, order: i, lastActiveMs };
  }).sort((a, b) => (a.rank - b.rank) || (b.lastActiveMs - a.lastActiveMs) || (a.order - b.order))
    .map(entry => entry.space);
}

// Priority-ordered agents inside a space: blocked > error > working > done > idle.
export function sortAgents(list) {
  return [...list].sort((a, b) => (AGENT_RANK[a.status] - AGENT_RANK[b.status]));
}

export function spaceLastActiveMs(space, list = [], raw = [], lastActiveMap = {}) {
  let best = Number(lastActiveMap?.[space.id] ?? 0) || 0;
  for (const a of list) {
    if (a.space === space.id && (a.status_ms ?? 0) > best) best = a.status_ms;
  }
  const sid = localId(space.id);
  const tabIds = new Set((space.tabs ?? []).map(tb => localId(tb.id)));
  for (const t of raw) {
    if (t.labels?.["herdr.space"] === sid || tabIds.has(t.labels?.["herdr.tab"])) {
      const ms = Math.max(t.status_ms ?? 0, t.created_ms ?? 0);
      if (ms > best) best = ms;
    }
  }
  return best;
}

export function formatActivityAge(lastActiveMs, now = Date.now()) {
  if (!lastActiveMs || lastActiveMs <= 0) return "1w";
  const diffMin = Math.max(0, (now - lastActiveMs) / 60000);
  if (diffMin < 1) return "1m";
  if (diffMin < 30) return "30m";
  if (diffMin < 60) return "1h";
  if (diffMin < 300) return "5h";
  if (diffMin < 10080) return "1d";
  return "1w";
}

// Marquee scroll frames for long one-line subtitle text: hold briefly on the
// start so it stays readable, then step through `text · text` two characters
// at a time. Returns null when the text fits within maxChars.
export function marqueeFrames(text, fitChars = 42) {
  const s = firstLine(text).trim();
  if (!s || s.length <= fitChars) return null;
  const loop = `${s}   ·   ${s}`;
  const win = fitChars + 20;
  const frames = [];
  for (let i = 0; i < 3; i++) frames.push(s.slice(0, win));
  for (let i = 2; i <= s.length + 5; i += 2) frames.push(loop.slice(i, i + win));
  return frames;
}

// Split spaces into up to MAX_EXPANDED expanded priority columns on the left
// and the compact OTHER SPACES box for all remaining spaces. Both groups are
// sorted by status tier (blocked > error > working > done > idle), then most
// recently accessed first, then declaration order — clicking any space updates
// its lastActiveMs so it jumps to the front of its tier on the next render.
export function partitionSpaces(sectors, list, _prevExpandedIds = [], lastActiveMap = {}, raw = [], maxExpanded = 4) {
  const MAX_EXPANDED = Math.min(clampInt(maxExpanded, 2, 6, 4), sectors.length);
  const scored = sectors.map((space, order) => {
    const status = spaceStatus(space, list);
    const rank = SPACE_RANK[status] ?? 4;
    const lastActiveMs = spaceLastActiveMs(space, list, raw, lastActiveMap);
    return { space, order, status, rank, lastActiveMs };
  });
  const byUrgency = (a, b) =>
    (a.rank - b.rank) || (b.lastActiveMs - a.lastActiveMs) || (a.order - b.order);
  const sorted = [...scored].sort(byUrgency);
  const activeSpaces = sorted.slice(0, MAX_EXPANDED).map(e => e.space);
  const otherSpaces = sorted.slice(MAX_EXPANDED).map(e => e.space);
  return { activeSpaces, otherSpaces, idleSpaces: otherSpaces };
}

// Number of live working/blocked/error subagent (hc child/wrkspec) terminals in a space,
// for the compact ⚡ SUB pill on each Space Box header.
export function spaceSubagentCount(spaceId, list) {
  return list.filter(a => a.space === spaceId
    && (a.child === true || /^wrk-/.test(a.name ?? "") || Boolean(a.spec))
    && ["working", "blocked", "error"].includes(a.status)).length;
}

// Full status palette for space/card outlines, header tints and dots.
// Optional theme token map `t` overrides the hard-coded accent colors.
export function statusPalette(status, active = false, t = null) {
  switch (status) {
    case "blocked": {
      const c = t?.blocked ?? "#ff6b9d";
      return { border: active ? c : `${c}99`, headerBg: active ? `${c}33` : `${c}1f`,
        cardBg: active ? `${c}3b` : `${c}12`, dot: c, fg: "#ff9fbb" };
    }
    case "error": {
      const c = t?.error ?? "#dc2626";
      return { border: active ? "#ef4444" : `${c}99`, headerBg: active ? `${c}38` : `${c}22`,
        cardBg: active ? `${c}42` : `${c}14`, dot: active ? "#ef4444" : c, fg: "#ff6b6b" };
    }
    case "done": {
      const c = t?.done ?? "#59e58c";
      return { border: active ? c : `${c}99`, headerBg: active ? `${c}30` : `${c}1c`,
        cardBg: active ? `${c}36` : `${c}12`, dot: c, fg: "#8affb8" };
    }
    case "working": {
      const c = t?.working ?? "#ff9e3b";
      return { border: active ? c : `${c}99`, headerBg: active ? `${c}33` : `${c}1f`,
        cardBg: active ? `${c}3b` : `${c}12`, dot: c, fg: "#ffd29d" };
    }
    case "shell": {
      const c = t?.shell ?? "#a78bfa";
      return { border: active ? c : `${c}80`, headerBg: active ? `${c}30` : `${c}1a`,
        cardBg: active ? `${c}36` : `${c}12`, dot: c, fg: "#d8b4fe" };
    }
    default:
      return active
        ? { border: "#6875a1", headerBg: "#1e2235", cardBg: "#23283d", dot: "#8ea4e8", fg: "#dbe4ff" }
        : { border: "#343d5e", headerBg: "#131726", cardBg: "#101422", dot: "#687aa8", fg: "#97a7d6" };
  }
}

// Concise label for a top-bar named status pill.
export function pillTitle(a) {
  if (a.child || a.spec || /^wrk-/.test(a.name ?? "")) {
    return `${a.space_name} · ${a.name || cleanCardTitle(a)}`;
  }
  return `${a.space_name} · ${cleanCardTitle(a)}`;
}

// Concise card title without repeating the program name (the icon shows it).
export function cleanCardTitle(a) {
  if (a.tab_named && a.tab_name) return a.tab_name;
  const rawTitle = firstLine(a.title).trim();
  if (!rawTitle || /^t\d+$/.test(rawTitle)
    || rawTitle.toLowerCase() === (a.program?.name ?? "").toLowerCase()) {
    return a.tab_name || "Terminal";
  }
  return rawTitle;
}
