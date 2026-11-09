// Horizon: top boxed deck of priority-ordered space columns,
// a spaces & tabs selection bar above the main window, and a boxed pane header.
// Roles come in via props().role: "deck" | "spaces-bar" | "pane-header" | "subagents" | "customize-overlay" | "help-overlay".

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, spaces, panes, props, run, theme, shared,
  setShared, setAgentOrder, window, openOverlay, closeOverlay, layout, home,
  nextCommand, keys } from "herdr";
import { collectAgents, collectSubagents, cleanCardTitle, sortSpaces, sortAgents,
  spaceStatus, firstLine, AGENT_RANK, statusPalette, pillTitle, partitionSpaces,
  spaceSubagentCount, spaceLastActiveMs, formatActivityAge, marqueeFrames, doneKey,
  DEFAULT_CONFIG, normalizeConfig, isWindowDragEnabled } from "./model.js";

const MOTION_KEY = "horizon.motion";
const ACK_KEY = "horizon.acked";
const LAST_ACTIVE_KEY = "horizon.last-active";
const CONFIG_KEY = "horizon.config";
const HELP_OVERLAY_KEY = "horizon.help-overlay-id";
const CUSTOMIZE_OVERLAY_KEY = "horizon.customize-overlay-id";
const IDLE_BOX_WIDTH = 300;

const text = (value, size, color) => div().text_size(size).text_color(color).child(value);
const icon = (program, size, color) => {
  if (!program?.icon) return text(">_", Math.max(10, size - 2), color).flex_none();
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color)
    : image(program.icon).w(size).h(size).flex_none();
};
const folder = cwd => {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
};
const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
};
const tip = a => `${a.address} | ${a.space_name} / ${a.tab_name}${a.child ? " / child" : ""}\n${a.title}\n${a.status}${a.kind ? `: ${a.kind}` : ""}${a.msg ? `\n${a.msg}` : ""}`;
const statusColor = (t, status) => t[status] ?? t.idle;

// Colored status pill badge. Native .frames() drives the animation when motion is on.
// Compact mode condenses to single-letter labels for the 2-column agent grid.
function statusBadge(status, motion, shell = false, compact = false) {
  let bg, border, fg, label, frames = null, period = 0;
  switch (status) {
    case "blocked":
      bg = "#ff6b9d28"; border = "#ff6b9d"; fg = "#ff9fbb";
      label = compact ? "● W" : "● WAITING";
      frames = compact ? ["● W", "○ W"] : ["● WAITING", "○ WAITING"];
      period = 900;
      break;
    case "error":
      bg = "#dc262632"; border = "#dc2626"; fg = "#ff6b6b";
      label = compact ? "✕ E" : "✕ ERROR";
      if (compact) { frames = ["✕ E", "· E"]; period = 900; }
      break;
    case "working":
      bg = "#ff9e3b28"; border = "#ff9e3b"; fg = "#ffd29d";
      label = compact ? "◐ B" : "◐ BUSY";
      frames = compact ? ["◐ B", "◓ B", "◑ B", "◒ B"] : ["◐ BUSY", "◓ BUSY", "◑ BUSY", "◒ BUSY"];
      period = 350;
      break;
    case "done":
      bg = "#59e58c28"; border = "#59e58c"; fg = "#8affb8";
      label = compact ? "✓ D" : "✓ DONE";
      break;
    default:
      if (shell) {
        bg = "#a78bfa22"; border = "#a78bfa88"; fg = "#d8b4fe";
        label = compact ? "· S" : "· SHELL";
      } else {
        bg = "#343d5e44"; border = "#4a5682"; fg = "#97a7d6";
        label = compact ? "· C" : "· CHILLING";
      }
  }
  const el = compact
    ? h_flex().h(16).px(5).gap(3).rounded(8).border(1)
        .border_color(border).bg(bg).items_center().flex_none()
        .text_size(9.5).font_semibold().text_color(fg)
    : h_flex().h(20).px(8).gap(5).rounded(10).border(1)
        .border_color(border).bg(bg).items_center().flex_none()
        .text_size(10.5).font_semibold().text_color(fg);
  if (frames && motion) el.frames(frames, period);
  else el.child(label);
  return el;
}

function activate(a) {
  if (a.pane) { run("pane.focus", { pane: a.pane }); return; }
  run(a.child ? "terminal.peek" : "agent.focus", { terminal: a.address });
}

export default class Horizon extends View {
  init(p, cx) {
    this.hoveredPane = null;
    this.hoveredCard = null;
    this.cycleCursor = 0;
    this.lastRailWant = null;
    this.expandedIds = [];
    this.spacePages = {};
    this.otherPage = 0;
    try {
      this.mru = JSON.parse(localStorage.getItem("horizon.mru") ?? localStorage.getItem("omarchy-deck.mru") ?? "[]");
    } catch {
      this.mru = [];
    }
    this.role = p?.role ?? props()?.role;
    this.overlayId = p?.overlay ?? props()?.overlay ?? null;
    if (this.role === "help-overlay" && this.overlayId) {
      setShared(HELP_OVERLAY_KEY, this.overlayId);
    }
    if (this.role === "customize-overlay" && this.overlayId) {
      setShared(CUSTOMIZE_OVERLAY_KEY, this.overlayId);
    }
    if (this.role === "customize-overlay" || this.role === "help-overlay") {
      this.handle = cx.focus_handle();
      this.handle.focus();
      cx.timer?.after(50, () => this.handle?.focus());
    }
    if (this.role === "deck") {
      setShared(HELP_OVERLAY_KEY, null);
      setShared(CUSTOMIZE_OVERLAY_KEY, null);
    }
    if (this.role === "deck" && cx?.spawn) {
      cx.spawn(async cx => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "help") this.openHelpOverlay();
          else if (cmd === "customize") this.openCustomizeOverlay();
          cx.notify();
        }
      });
    }
  }

  close() {
    const id = this.overlayId ?? props()?.overlay;
    if (this.role === "help-overlay" && (!id || shared(HELP_OVERLAY_KEY) === id)) {
      setShared(HELP_OVERLAY_KEY, null);
    } else if (this.role === "customize-overlay" && (!id || shared(CUSTOMIZE_OVERLAY_KEY) === id)) {
      setShared(CUSTOMIZE_OVERLAY_KEY, null);
    }
  }

  closeCurrentOverlay() {
    const id = this.overlayId ?? props()?.overlay;
    if (this.role === "help-overlay") setShared(HELP_OVERLAY_KEY, null);
    if (this.role === "customize-overlay") setShared(CUSTOMIZE_OVERLAY_KEY, null);
    if (id) closeOverlay(id);
  }

  openCustomizeOverlay() {
    const existing = shared(CUSTOMIZE_OVERLAY_KEY);
    if (existing) {
      setShared(CUSTOMIZE_OVERLAY_KEY, null);
      closeOverlay(existing);
      return;
    }
    const helpId = shared(HELP_OVERLAY_KEY);
    if (helpId) {
      setShared(HELP_OVERLAY_KEY, null);
      closeOverlay(helpId);
    }
    const id = openOverlay({ mod: "horizon", kind: "dialog", width: 620, height: 470,
      props: { role: "customize-overlay" } });
    if (id) setShared(CUSTOMIZE_OVERLAY_KEY, id);
  }

  openHelpOverlay() {
    const existing = shared(HELP_OVERLAY_KEY);
    if (existing) {
      setShared(HELP_OVERLAY_KEY, null);
      closeOverlay(existing);
      return;
    }
    const custId = shared(CUSTOMIZE_OVERLAY_KEY);
    if (custId) {
      setShared(CUSTOMIZE_OVERLAY_KEY, null);
      closeOverlay(custId);
    }
    const id = openOverlay({ mod: "horizon", kind: "dialog", width: 680, height: 520,
      props: { role: "help-overlay" } });
    if (id) setShared(HELP_OVERLAY_KEY, id);
  }

  recordMru(activeSpaceId) {
    if (!activeSpaceId) return;
    this.mru = [activeSpaceId, ...this.mru.filter(id => id !== activeSpaceId)].slice(0, 5);
    try {
      localStorage.setItem("horizon.mru", JSON.stringify(this.mru));
    } catch {}
  }

  getAcked() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(ACK_KEY) ?? localStorage.getItem("omarchy-deck.acked") ?? "{}");
    } catch {}
    return { ...stored, ...(shared(ACK_KEY) ?? {}) };
  }

  saveAcked(next) {
    try {
      localStorage.setItem(ACK_KEY, JSON.stringify(next));
    } catch {}
    setShared(ACK_KEY, next);
  }

  getConfig() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? localStorage.getItem("omarchy-deck.config") ?? "{}");
    } catch {}
    return normalizeConfig({ ...stored, ...(shared(CONFIG_KEY) ?? {}) });
  }

  // Merge a patch into the persisted config, normalize it into range, save it
  // to localStorage + shared state, and live-apply a deck height change.
  saveConfig(patch = {}) {
    const next = normalizeConfig({ ...this.getConfig(), ...patch });
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    } catch {}
    setShared(CONFIG_KEY, next);
    if (patch.deckHeight !== undefined) {
      run("layout.resize", { id: "deck", px: next.deckHeight });
    }
    if (patch.titlebar !== undefined) {
      const tree = JSON.parse(JSON.stringify(layout() ?? {}));
      tree.titlebar = next.titlebar;
      run("layout.set", { layout: tree });
    }
    return next;
  }

  getLastActive() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(LAST_ACTIVE_KEY) ?? localStorage.getItem("omarchy-deck.last-active") ?? "{}");
    } catch {}
    return { ...stored, ...(shared(LAST_ACTIVE_KEY) ?? {}) };
  }

  // Clicking any space (header, agent card, idle tile, top pill) stamps it as
  // most-recently-accessed so the priority sort moves it to the front of its
  // status tier on the very next render frame.
  markSpaceActive(spaceId) {
    if (!spaceId) return;
    const map = { ...this.getLastActive(), [spaceId]: Date.now() };
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify(map));
    } catch {}
    setShared(LAST_ACTIVE_KEY, map);
  }

  touchLastActive(allSpaces, live) {
    const map = this.getLastActive();
    const now = Date.now();
    let changed = false;
    for (const s of allSpaces) {
      const busy = s.active === true || live.some(a => a.space === s.id
        && ["working", "blocked", "error"].includes(a.status));
      if (busy && map[s.id] !== now) { map[s.id] = now; changed = true; }
    }
    if (changed && (this.lastActiveSavedId !== (allSpaces.find(s => s.active)?.id ?? null)
        || now - (this.lastActiveSavedAt ?? 0) > 15000)) {
      this.lastActiveSavedId = allSpaces.find(s => s.active)?.id ?? null;
      this.lastActiveSavedAt = now;
      try {
        localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify(map));
      } catch {}
    }
    return map;
  }

  // Pre-seed acked for terminals already seen idle by agents() before a reload
  // so stale historical done turns do not resurrect as DONE on startup.
  seedInitialAcked() {
    if (this.seededAck) return;
    const raws = terminals();
    if (!raws.length) return;
    this.seededAck = true;
    const acked = this.getAcked();
    let changed = false;
    for (const a of agents()) {
      if (a.status !== "idle") continue;
      const t = raws.find(t => t.address === a.address);
      if (t?.labels?.["orch.status"] === "done") {
        if (acked[a.address]) { delete acked[a.address]; changed = true; }
      } else if (t && (t?.report?.state === "done" || t?.status === "done")) {
        acked[a.address] = doneKey(t);
        changed = true;
      }
    }
    if (changed) this.saveAcked(acked);
  }

  ackAgents(items) {
    const acked = this.getAcked();
    let changed = false;
    for (const a of items) {
      if (!a?.done_key) continue;
      acked[a.address] = a.done_key;
      changed = true;
    }
    if (changed) this.saveAcked(acked);
  }

  ackSpace(spaceId, live) {
    this.ackAgents(live.filter(a => a.space === spaceId && a.status === "done"));
  }

  jumpInSpace(spaceId, live) {
    let hot = sortAgents(live.filter(a => a.space === spaceId && a.status !== "idle"));
    if (!hot.length) hot = live.filter(a => a.space === spaceId);
    if (!hot.length) return;
    const target = hot[this.cycleCursor % hot.length];
    this.cycleCursor++;
    this.ackAgents([target]);
    activate(target);
  }

  // Agents plus live pane-backed terminals not already reported as agents,
  // grouped per space, so every space shows its live agent/terminal cards.
  spaceCards(allSpaces, live) {
    const seen = new Set(live.map(a => a.address));
    const extra = panes().filter(p => p.terminal && !seen.has(p.terminal))
      .map(p => {
        const space = allSpaces.find(s => s.tabs.some(tab => tab.id === p.tab));
        const tab = space?.tabs.find(tab => tab.id === p.tab);
        return {
          address: p.terminal, pane: p.pane, space: space?.id ?? "unplaced",
          space_name: space?.name ?? "Unplaced", tab: p.tab, tab_name: tab?.name ?? "No tab",
          status: ["working", "blocked", "error", "done", "idle"].includes(p.status) ? p.status : "idle",
          child: false, title: p.title || p.program?.name || "Terminal",
          program: p.program, kind: null, msg: null, cwd: p.cwd, shell: !p.program?.agent,
          tab_named: Boolean(tab?.named),
        };
      });
    return { agents: live, extra };
  }

  card(a, index, t, motion, isActiveCard = false, compact = false) {
    const visualStatus = (a.shell && a.status === "idle") ? "shell" : a.status;
    const color = visualStatus === "shell" ? "#a78bfa" : statusColor(t, a.status);
    const pal = statusPalette(visualStatus, isActiveCard, t);
    const displayTitle = isActiveCard ? `▸ ${cleanCardTitle(a)}` : cleanCardTitle(a);
    const detail = a.msg ? firstLine(a.msg)
      : (a.tab_named && a.title ? firstLine(a.title) : folder(a.cwd));
    const maxChars = compact ? 22 : Math.max(20, 43 - (a.space_name?.length ?? 0));
    const frames = marqueeFrames(detail, maxChars);
    const shouldScroll = motion && (isActiveCard || this.hoveredCard === a.address);
    const subtitle = text(detail, 10, t.muted).flex_1().min_w(0).h(14).overflow_hidden().truncate();
    if (shouldScroll && frames) subtitle.frames(frames, 220);
    const onActivate = () => { this.ackAgents([a]); this.markSpaceActive(a.space); activate(a); };
    const onHover = (hovered, cx) => {
      this.hoveredCard = hovered ? a.address : (this.hoveredCard === a.address ? null : this.hoveredCard);
      cx.notify();
    };
    if (compact) {
      return v_flex().id(`deck-card-${a.address}`).flex_1().min_w(0).h(39).rounded(6)
        .border(isActiveCard ? 2 : 1)
        .border_color(pal.border)
        .bg(pal.cardBg)
        .px(6).py(3).gap(1).justify_between()
        .tooltip(tip(a))
        .hover(el => el.bg(t.hover))
        .on_hover(onHover)
        .on_click(onActivate)
        .child(h_flex().items_center().gap(4)
          .child(icon(a.program, 11, color))
          .child(text(displayTitle, 10.5, t.foreground).font_semibold().flex_1().min_w(0).truncate())
          .child(statusBadge(visualStatus, motion, a.shell, true)))
        .child(h_flex().items_center().gap(4).h(14).overflow_hidden().child(subtitle));
    }
    return v_flex().id(`deck-card-${a.address}`).w_full().rounded(7)
      .border(isActiveCard ? 2 : 1)
      .border_color(pal.border)
      .bg(pal.cardBg)
      .px(8).py(5).gap(2)
      .tooltip(tip(a))
      .hover(el => el.bg(t.hover))
      .on_hover(onHover)
      .on_click(onActivate)
      .child(h_flex().items_center().gap(6)
        .child(text(index != null ? `#${index}` : `#${a.address}`, 10, t.dim).flex_none())
        .child(icon(a.program, 13, color))
        .child(text(displayTitle, 12, t.foreground).font_semibold().flex_1().min_w(0).truncate())
        .child(div().id(`rename-agent-${a.address}`).text_color(t.dim).flex_none()
          .hover(el => el.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (a.tab && a.tab !== "unplaced") run("tab.rename", { id: a.tab });
          })
          .child(text("✎", 10, t.dim)))
        .child(statusBadge(visualStatus, motion, a.shell, false)))
      .child(h_flex().items_center().gap(5).h(14).overflow_hidden()
        .child(text(a.space_name, 10, color).font_medium().flex_none())
        .child(subtitle));
  }

  spaceBox(space, cards, indexOf, lastActiveMap, raw, t, motion, cfg) {
    const live = cards.agents.filter(a => a.space === space.id);
    const extra = cards.extra.filter(a => a.space === space.id);
    const rawStatus = spaceStatus(space, live);
    const pal = statusPalette(rawStatus, space.active, t);
    const age = formatActivityAge(spaceLastActiveMs(space, cards.agents, raw, lastActiveMap));
    const mainLive = live.filter(a => !a.child && !/^wrk-/.test(a.name ?? "") && !a.spec);
    const items = [...sortAgents(mainLive), ...extra];
    // Full-width cards up to fullWidthMax agents, then a compact agentCols x agentRows grid.
    const compact = items.length > cfg.fullWidthMax;
    const cols = compact ? cfg.agentCols : 1;
    const pageSize = compact ? (cfg.agentCols * cfg.agentRows) : Math.max(2, cfg.fullWidthMax);
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(Math.max(0, this.spacePages[space.id] ?? 0), totalPages - 1);
    this.spacePages[space.id] = page;
    const pageItems = compact ? items.slice(page * pageSize, (page + 1) * pageSize) : items;
    const isActiveCard = a => Boolean(space.active && space.tabs?.some(tb => tb.id === a.tab && tb.active));
    const subCount = spaceSubagentCount(space.id, live);
    const pills = h_flex().gap(5).flex_none()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.jumpInSpace(space.id, live); });
    if (subCount > 0) {
      pills.child(h_flex().h(20).px(7).gap(4).flex_none().items_center().rounded(10).border(1)
        .border_color(t.accent).bg(t.chrome).text_size(10).font_semibold().text_color(t.accent)
        .child(text("⚡", 10, t.accent).flex_none())
        .child(text(`${subCount} SUB`, 10, t.accent).flex_none()));
    }
    if (items.length > pageSize) {
      const arrow = (glyph, delta) => div().px(3).flex_none()
        .hover(el => el.text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.spacePages[space.id] = (page + delta + totalPages) % totalPages;
          cx.notify();
        })
        .child(text(glyph, 9, t.muted));
      pills.child(h_flex().h(18).px(3).gap(2).flex_none().items_center().rounded(9).border(1)
        .border_color(t.border).bg(t.chrome).text_size(9.5).font_semibold().text_color(t.muted)
        .child(arrow("▲", -1))
        .child(text(`${page + 1}/${totalPages}`, 9.5, t.muted).flex_none())
        .child(arrow("▼", 1)));
    }
    pills.child(statusBadge(rawStatus, motion));
    let body;
    if (compact) {
      const rows = [];
      for (let i = 0; i < pageItems.length; i += cols) {
        const rowItems = pageItems.slice(i, i + cols);
        const row = h_flex().w_full().gap(5)
          .children(rowItems.map(a => this.card(a, indexOf.get(a.address), t, motion, isActiveCard(a), true)));
        if (cols > 1) {
          for (let pad = rowItems.length; pad < cols; pad++) row.child(div().flex_1().min_w(0));
        }
        rows.push(row);
      }
      body = v_flex().flex_1().min_h(0).p(6).gap(4).overflow_y_scrollbar().children(rows);
    } else {
      body = v_flex().flex_1().min_h(0).p(6).gap(6).overflow_y_scrollbar()
        .children(pageItems.map(a => this.card(a, indexOf.get(a.address), t, motion, isActiveCard(a), false)))
        .when(!pageItems.length, el => el.child(v_flex().rounded(7).border(1).border_color(pal.border)
          .bg(pal.cardBg).p(8).gap(4).flex_none()
          .child(h_flex().items_center().gap(6)
            .child(icon(null, 13, t.dim))
            .child(text("Idle space", 12, t.muted).font_semibold()))
          .child(text("No agents reporting.\nOpen a terminal or agent here.", 10, t.dim))));
    }
    return v_flex().id(`deck-space-${space.id}`).flex_1().min_w(0).max_w(320).h_full()
      .rounded(8)
      .border(space.active ? 2 : 1)
      .border_color(space.active ? (rawStatus === "idle" ? t.accent : pal.border) : pal.border)
      .bg(space.active ? t.surface : t.canvas)
      .opacity(space.active ? 1.0 : 0.42)
      .hover(el => el.opacity(space.active ? 1.0 : 0.85))
      .child(h_flex().h(32).flex_none().px(8).gap(6).items_center()
        .bg(pal.headerBg).border_b(space.active ? 2 : 1).border_color(pal.border)
        .tooltip(`${space.name}${space.branch ? `\n⎇ ${space.branch}` : ""}`)
        .on_click(() => {
          this.ackSpace(space.id, live);
          this.markSpaceActive(space.id);
          run("space.select", { id: space.id });
        })
        .child(div().size(8).rounded(4).bg(pal.dot).flex_none())
        .child(text(space.active ? `▸ ${space.name}` : space.name, 12, t.foreground).font_semibold().flex_1().min_w(0).truncate())
        .child(text(age, 10, t.muted).flex_none())
        .child(div().id(`rename-space-${space.id}`).text_color(t.dim).flex_none()
          .hover(el => el.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.rename", { id: space.id }); })
          .child(text("✎", 10, t.dim)))
        .child(pills))
      .child(body);
  }

  idleSpacesBox(idleSpaces, live, lastActiveMap, raw, t, cfg) {
    const boxBorder = "#222533";
    const boxBg = "#08090f";
    const headBg = "#0e1018";
    const headFg = "#6e758c";
    const idleCard = { border: "#222533", cardBg: "#11131c", dot: "#52586e", fg: "#8b92a8" };
    // cfg.otherCols x cfg.otherRows per page; box width auto-scales with columns.
    const cols = cfg.otherCols;
    const pageSize = cfg.otherCols * cfg.otherRows;
    const boxWidth = cols === 1 ? 185 : cols === 3 ? 415 : IDLE_BOX_WIDTH;
    const totalPages = Math.max(1, Math.ceil(idleSpaces.length / pageSize));
    const page = Math.min(Math.max(0, this.otherPage ?? 0), totalPages - 1);
    this.otherPage = page;
    const pageSpaces = idleSpaces.slice(page * pageSize, (page + 1) * pageSize);
    const rows = [];
    for (let i = 0; i < pageSpaces.length; i += cols) {
      const row = pageSpaces.slice(i, i + cols);
      const rowEl = h_flex().w_full().gap(5)
        .children(row.map(s => {
          const st = spaceStatus(s, live);
          const isIdle = st === "idle";
          const sPal = isIdle ? idleCard : statusPalette(st, s.active);
          const age = formatActivityAge(spaceLastActiveMs(s, live, raw, lastActiveMap));
          return h_flex().id(`idle-space-${s.id}`).flex_1().min_w(0).h(27).px(8).gap(6)
            .items_center().rounded(6).border(1).border_color(sPal.border).bg(sPal.cardBg)
            .hover(el => el.bg(t.hover))
            .on_click(() => {
              this.ackSpace(s.id, live);
              this.markSpaceActive(s.id);
              run("space.select", { id: s.id });
            })
            .child(div().size(6).rounded(3).bg(sPal.dot).flex_none())
            .child(text(s.name, 11, isIdle ? idleCard.fg : t.foreground).font_medium().flex_1().min_w(0).truncate())
            .child(text(String(s.tabs?.length ?? 1), 10, t.dim).flex_none())
            .child(text(age, 10, t.dim).flex_none());
        }));
      if (cols > 1) {
        for (let pad = row.length; pad < cols; pad++) rowEl.child(div().flex_1().min_w(0));
      }
      rows.push(rowEl);
    }
    const pager = idleSpaces.length > pageSize
      ? h_flex().h(18).px(3).gap(2).flex_none().items_center().rounded(9).border(1)
          .border_color(boxBorder).bg(idleCard.cardBg).text_size(9.5).font_semibold().text_color(headFg)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(div().px(3).flex_none().hover(el => el.text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.otherPage = (page - 1 + totalPages) % totalPages;
              cx.notify();
            })
            .child(text("▲", 9, headFg)))
          .child(text(`${page + 1}/${totalPages}`, 9.5, headFg).flex_none())
          .child(div().px(3).flex_none().hover(el => el.text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.otherPage = (page + 1) % totalPages;
              cx.notify();
            })
            .child(text("▼", 9, headFg)))
      : null;
    return v_flex().id("deck-idle-spaces").w(boxWidth).flex_none().h_full()
      .rounded(8).border(1).border_color(boxBorder).bg(boxBg)
      .opacity(0.62).hover(el => el.opacity(0.92))
      .child(h_flex().h(32).flex_none().px(10).gap(8).items_center()
        .bg(headBg).border_b(1).border_color(boxBorder)
        .child(text("OTHER SPACES", 11, headFg).font_semibold())
        .child(text(String(idleSpaces.length).padStart(2, "0"), 12, headFg).flex_none())
        .when(Boolean(pager), el => el.child(pager))
        .child(div().flex_1())
        .child(h_flex().h(20).px(7).gap(4).flex_none().items_center().rounded(6).border(1)
          .border_color(boxBorder).bg(idleCard.cardBg).text_size(10).font_semibold().text_color(headFg)
          .hover(el => el.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new"))
          .child(text("+", 11, headFg).flex_none())
          .child(text("New Space", 10, headFg).flex_none())))
      .child(v_flex().flex_1().min_h(0).p(6).gap(5).overflow_y_scrollbar()
        .children(rows)
        .when(!idleSpaces.length, el => el.child(v_flex().rounded(7).border(1).border_color(boxBorder)
          .bg(idleCard.cardBg).p(10).gap(4).flex_none()
          .child(text("All spaces shown on the left.", 11, t.muted)))));
  }

  headerButton(t, id, label, onClick, opts = {}) {
    return h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(7)
      .text_size(11).border(1).border_color(opts.on ? t.accent : t.border)
      .bg(opts.on ? t.selected : t.chrome).text_color(opts.on ? t.foreground : t.muted)
      .hover(el => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .when(Boolean(opts.icon), el => el.child(opts.icon))
      .child(label);
  }

  deckHeader(live, t, motion, cfg) {
    const w = window();
    const dragOn = isWindowDragEnabled(cfg, w?.platform);
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const panelToggle = id => {
      const on = panel && !panel.hidden && body?.active === id;
      if (on) run("layout.hide", { id: "panel" });
      else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
    };
    const topPill = a => {
      const pal = statusPalette(a.status);
      const glyph = a.status === "blocked" ? "●" : a.status === "error" ? "✕" : a.status === "done" ? "✓" : "◐";
      const glyphEl = text(glyph, 11, pal.fg).flex_none();
      if (a.status === "working" && motion) glyphEl.frames(["◐", "◓", "◑", "◒"], 350);
      return h_flex().id("top-pill-" + a.address).h(22).px(9).gap(5).rounded(11).border(1)
        .border_color(pal.border).bg(pal.headerBg).items_center().flex_none()
        .text_size(10.5).font_semibold().text_color(pal.fg)
        .hover(el => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.ackAgents([a]);
          this.markSpaceActive(a.space);
          activate(a);
        })
        .child(glyphEl)
        .child(text(pillTitle(a), 10.5, pal.fg).max_w(190).truncate().flex_none());
    };
    const hot = sortAgents(live.filter(a => a.status !== "idle"));
    return h_flex().id("deck-header").h(36).flex_none().px(12).gap(10).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .when(!dragOn, el => el
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation()))
      .child(text("HORIZON", 13, t.foreground).font_semibold().flex_none())
      .child(text(`${live.length} AGENTS / ${spaces().length} SPACES`, 10, t.dim).flex_none())
      .child(h_flex().gap(5).items_center().flex_1().min_w(0).overflow_x_scrollbar()
        .children(hot.map(topPill)))
      .child(this.headerButton(t, "deck-new-agent", "+ Agent",
        () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(this.headerButton(t, "deck-split-right", "+ Split Right",
        () => run("pane.split", { direction: "right" })))
      .child(this.headerButton(t, "deck-panel-files", "Files", () => panelToggle("files"),
        { on: panel && !panel.hidden && body?.active === "files" }))
      .child(this.headerButton(t, "deck-panel-changes", "Changes", () => panelToggle("changes"),
        { on: panel && !panel.hidden && body?.active === "changes" }))
      .child(this.headerButton(t, "deck-motion", `Motion: ${motion ? "on" : "off"}`,
        () => setShared(MOTION_KEY, shared(MOTION_KEY) === true ? false : true)))
      .child(this.headerButton(t, "deck-customize", "⚙ Customize",
        () => this.openCustomizeOverlay(), { on: Boolean(shared(CUSTOMIZE_OVERLAY_KEY)) }))
      .child(this.headerButton(t, "deck-help", "? Help (F1)",
        () => this.openHelpOverlay(), { on: Boolean(shared(HELP_OVERLAY_KEY)) }))
      .when(Boolean(w?.buttons), el => el
        .child(this.headerButton(t, "deck-min", "−", () => run("window.minimize")))
        .child(this.headerButton(t, "deck-max", "□", () => run("window.maximize")))
        .child(this.headerButton(t, "deck-close", "✕", () => run("window.close"))));
  }

  overlayRoot(t) {
    const esc = keys?.escape ?? "escape";
    return v_flex().size_full().min_h(0).p(18).gap(14)
      .bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const isHelpToggle = this.role === "help-overlay"
          && (e.key === "f1" || (e.key === "/" && e.modifiers?.control));
        const isCustToggle = this.role === "customize-overlay"
          && e.key === "," && e.modifiers?.control && e.modifiers?.shift;
        if (e.key === "escape" || e.key === esc || isHelpToggle || isCustToggle) {
          this.closeCurrentOverlay();
          cx.stop_propagation();
        }
      });
  }

  overlayHeader(t, title) {
    return h_flex().h(34).flex_none().items_center().gap(10)
      .child(text(title, 14, t.foreground).font_semibold().flex_1().min_w(0))
      .child(text("Esc to close", 10, t.dim).flex_none())
      .child(h_flex().h(24).px(8).gap(5).flex_none().items_center().rounded(7)
        .text_size(11).border(1).border_color(t.border).bg(t.chrome).text_color(t.muted)
        .hover(el => el.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.closeCurrentOverlay())
        .child(text("✕ Close", 11, t.muted)));
  }

  helpOverlay(t) {
    const close = () => this.closeCurrentOverlay();
    const trigger = action => () => { this.closeCurrentOverlay(); action(); };
    const sectionTitle = label => text(label, 11, t.dim).font_semibold().flex_none();
    const legend = [
      statusBadge("blocked", false), statusBadge("error", false),
      statusBadge("working", false), statusBadge("done", false),
      statusBadge("idle", false), statusBadge("idle", false, true),
    ];
    const card = (keyLabel, label, action) => h_flex().h(30).px(8).gap(8).flex_1().min_w(0)
      .items_center().rounded(7).border(1).border_color(t.border).bg(t.surface)
      .hover(el => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click(action.direct ? action : trigger(action))
      .child(h_flex().h(18).px(5).flex_none().items_center().rounded(4)
        .border(1).border_color(t.border).bg(t.chrome)
        .text_size(9.5).font_semibold().text_color(t.foreground)
        .child(text(keyLabel, 9.5, t.foreground)))
      .child(text(label, 11, t.muted).flex_1().min_w(0).truncate());
    const shortcuts = [
      ["F2", "Rename Tab", () => run("tab.rename")],
      ["Shift+F2", "Rename Space", () => run("space.rename")],
      ["Ctrl+Shift+K", "Go To Picker", () => run("mod.open", { name: "picker" })],
      ["Ctrl+Shift+P", "Command Palette", () => run("app.palette")],
      ["Ctrl+Shift+T", "New Agent/Tab",
        () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })],
      ["Ctrl+Shift+N", "New Space", () => run("space.new")],
      ["Alt+V", "Split Right", () => run("pane.split", { direction: "right" })],
      ["Alt+S", "Split Down", () => run("pane.split", { direction: "down" })],
      ["Alt+1..9", "Focus Spaces", () => {
        const s = spaces()[0];
        if (s) run("space.select", { id: s.id });
      }],
      ["Ctrl+Shift+,", "Customize", Object.assign(() => this.openCustomizeOverlay(), { direct: true })],
      ["F1 / Ctrl+/", "Help", () => this.openHelpOverlay()],
    ];
    const gridRows = [];
    for (let i = 0; i < shortcuts.length; i += 2) {
      const pair = shortcuts.slice(i, i + 2);
      gridRows.push(h_flex().w_full().gap(8).flex_none()
        .children(pair.map(([k, l, a]) => card(k, l, a)))
        .when(pair.length === 1, el => el.child(div().flex_1().min_w(0))));
    }
    const footer = h_flex().h(32).flex_none().items_center().gap(8)
      .child(h_flex().h(26).px(10).gap(6).flex_none().items_center().rounded(7)
        .border(1).border_color(t.border).bg(t.surface)
        .text_size(11).font_semibold().text_color(t.muted)
        .hover(el => el.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click(trigger(() => run("app.help")))
        .child(text("All Herdr Keybinds ↗", 11, t.muted)))
      .child(div().flex_1())
      .child(h_flex().h(26).px(12).gap(6).flex_none().items_center().rounded(7)
        .border(1).border_color(t.accent).bg(t.selected)
        .text_size(11).font_semibold().text_color(t.foreground)
        .hover(el => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click(close)
        .child(text("Close (Esc)", 11, t.foreground)));
    return this.overlayRoot(t).id("deck-help-overlay")
      .child(this.overlayHeader(t, "? Horizon Shortcuts & Guide"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(12)
        .child(sectionTitle("STATUS PRIORITY & COLOR LEGEND"))
        .child(h_flex().gap(6).items_center().flex_none().children(legend))
        .child(text("Spaces sort by urgency tier (blocked > error > working > done > idle),\nthen most recently accessed.", 10, t.dim))
        .child(div().h(1).w_full().bg(t.border).flex_none())
        .child(sectionTitle("QUICK ACTIONS & KEYBOARD SHORTCUTS"))
        .child(v_flex().gap(8).children(gridRows)))
      .child(footer);
  }

  customizeOverlay(t) {
    const cfg = this.getConfig();
    const close = () => this.closeCurrentOverlay();
    const save = patch => this.saveConfig(patch);
    const pill = (label, on, onClick, title) => h_flex().h(22).px(8).gap(4).flex_none().items_center()
      .rounded(6).border(1).border_color(on ? t.accent : t.border)
      .bg(on ? t.selected : t.surface)
      .text_size(10).font_semibold().text_color(on ? t.foreground : t.muted)
      .hover(el => el.bg(t.hover).text_color(t.foreground))
      .tooltip(title)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(text(label, 10, on ? t.foreground : t.muted));
    const stepBtn = (glyph, onClick, title) => h_flex().h(22).w(24).flex_none().items_center().justify_center()
      .rounded(6).border(1).border_color(t.border).bg(t.surface)
      .text_size(11).font_semibold().text_color(t.muted)
      .hover(el => el.bg(t.hover).text_color(t.foreground))
      .tooltip(title)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(text(glyph, 11, t.muted));
    const valuePill = (value, title) => h_flex().h(22).px(8).flex_none().items_center()
      .rounded(6).border(1).border_color(t.border).bg(t.chrome)
      .text_size(10).font_semibold().text_color(t.foreground)
      .tooltip(title)
      .child(text(value, 10, t.foreground));
    const settingRow = (titleText, subtitle, controls) => h_flex().w_full().flex_none().items_center().gap(12)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(text(titleText, 12, t.foreground).font_semibold())
        .child(text(subtitle, 10, t.dim)))
      .child(h_flex().gap(4).items_center().flex_none().children(controls));
    const body = v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(10)
      .child(settingRow("Window Drag", "Drag the frameless window by its header (auto enables on Windows/macOS).",
        [pill("Auto (Win/Mac)", cfg.windowDrag === "auto", () => save({ windowDrag: "auto" }),
            "Auto: header drag on Windows/macOS only"),
         pill("On", cfg.windowDrag === "on", () => save({ windowDrag: "on" }), "Always drag from the header"),
         pill("Off", cfg.windowDrag === "off", () => save({ windowDrag: "off" }), "Never drag from the header")]))
      .child(settingRow("Window Titlebar", "Frameless hides the OS title bar; System shows it.",
        [pill("Frameless", cfg.titlebar === "none", () => save({ titlebar: "none" }), "Hide the system title bar"),
         pill("System", cfg.titlebar === "system", () => save({ titlebar: "system" }), "Show the system title bar")]))
      .child(settingRow("Deck Height", "Vertical size of the command deck (175–360px, 15px steps).",
        [stepBtn("−", () => save({ deckHeight: cfg.deckHeight - 15 }), "Deck height (−15px)"),
         valuePill(`${cfg.deckHeight}px`, "Deck height"),
         stepBtn("+", () => save({ deckHeight: cfg.deckHeight + 15 }), "Deck height (+15px)"),
         pill("S (195)", cfg.deckHeight === 195, () => save({ deckHeight: 195 }), "Deck height 195px"),
         pill("M (235)", cfg.deckHeight === 235, () => save({ deckHeight: 235 }), "Deck height 235px"),
         pill("L (285)", cfg.deckHeight === 285, () => save({ deckHeight: 285 }), "Deck height 285px")]))
      .child(settingRow("Expanded Spaces", "Priority space columns shown expanded on the left (2–6).",
        [stepBtn("−", () => save({ maxExpanded: cfg.maxExpanded - 1 }), "Expanded spaces (−)"),
         valuePill(`${cfg.maxExpanded} spaces`, "Expanded spaces (2–6)"),
         stepBtn("+", () => save({ maxExpanded: cfg.maxExpanded + 1 }), "Expanded spaces (+)")]))
      .child(settingRow("Full-Width Agent Cards", "Agents per space before switching to the compact grid (0–4).",
        [stepBtn("−", () => save({ fullWidthMax: cfg.fullWidthMax - 1 }), "Full-width max (−)"),
         valuePill(`≤ ${cfg.fullWidthMax} agents`, "Max full-width agents (0–4)"),
         stepBtn("+", () => save({ fullWidthMax: cfg.fullWidthMax + 1 }), "Full-width max (+)")]))
      .child(settingRow("Compact Agent Grid", "Grid shape for the remaining agents in a space.",
        [pill("1 Col", cfg.agentCols === 1, () => save({ agentCols: 1 }), "One agent grid column"),
         pill("2 Cols", cfg.agentCols === 2, () => save({ agentCols: 2 }), "Two agent grid columns"),
         stepBtn("−", () => save({ agentRows: cfg.agentRows - 1 }), "Agent grid rows (−)"),
         valuePill(`${cfg.agentRows} rows`, "Agent grid rows (2–5)"),
         stepBtn("+", () => save({ agentRows: cfg.agentRows + 1 }), "Agent grid rows (+)")]))
      .child(settingRow("Other Spaces Grid", "Tile shape of the OTHER SPACES box on the right.",
        [stepBtn("−", () => save({ otherCols: cfg.otherCols - 1 }), "Other Spaces columns (−)"),
         valuePill(`${cfg.otherCols} cols`, "Other Spaces columns (1–3)"),
         stepBtn("+", () => save({ otherCols: cfg.otherCols + 1 }), "Other Spaces columns (+)"),
         stepBtn("−", () => save({ otherRows: cfg.otherRows - 1 }), "Other Spaces rows (−)"),
         valuePill(`${cfg.otherRows} rows`, "Other Spaces rows (2–6)"),
         stepBtn("+", () => save({ otherRows: cfg.otherRows + 1 }), "Other Spaces rows (+)")]));
    const footer = h_flex().h(32).flex_none().items_center().gap(8)
      .child(h_flex().h(26).px(10).gap(6).flex_none().items_center().rounded(7)
        .border(1).border_color(t.border).bg(t.surface)
        .text_size(11).font_semibold().text_color(t.muted)
        .hover(el => el.bg(t.hover).text_color(t.foreground))
        .tooltip("Reset all deck settings to defaults")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.saveConfig(DEFAULT_CONFIG); })
        .child(text("↺ Reset to Defaults", 11, t.muted)))
      .child(div().flex_1())
      .child(h_flex().h(26).px(12).gap(6).flex_none().items_center().rounded(7)
        .border(1).border_color(t.accent).bg(t.selected)
        .text_size(11).font_semibold().text_color(t.foreground)
        .hover(el => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click(close)
        .child(text("Done (Esc)", 11, t.foreground)));
    return this.overlayRoot(t).id("deck-customize-overlay")
      .child(this.overlayHeader(t, "⚙ Customize Horizon"))
      .child(body)
      .child(footer);
  }

  subagentsRail(t) {
    const live = collectAgents(agents(), terminals(), spaces(), this.getAcked());
    const activeSpace = spaces().find(s => s.active);
    const activeSubs = collectSubagents(live, activeSpace?.id);
    const pal = statusPalette("working", false);
    const subCard = a => {
      const cardPal = statusPalette(a.status, false);
      return h_flex().id(`subagent-${a.address}`).h(28).px(8).gap(6).items_center().rounded(6)
        .border(1).border_color(cardPal.border).bg(cardPal.cardBg)
        .hover(el => el.bg(t.hover)).on_click(() => run("terminal.peek", { terminal: a.address }))
        .child(div().size(6).rounded(3).bg(cardPal.dot).flex_none())
        .child(text(a.name || cleanCardTitle(a), 11, t.foreground).font_medium().flex_1().min_w(0).truncate())
        .child(statusBadge(a.status, false));
    };
    return v_flex().id("deck-subagents-rail").size_full().min_h(0).bg(t.canvas).text_color(t.foreground)
      .child(h_flex().h(32).flex_none().px(10).gap(8).items_center()
        .bg(t.chrome).border_b(1).border_color(t.border)
        .child(text(`SUBAGENTS · ${activeSpace?.name ?? ""}`, 12, t.foreground).font_semibold().flex_1().min_w(0).truncate())
        .child(text(String(activeSubs.length).padStart(2, "0"), 12, pal.fg).flex_none()))
      .child(v_flex().flex_1().min_h(0).p(8).gap(5).overflow_y_scrollbar()
        .children(activeSubs.map(subCard))
        .when(!activeSubs.length, el => el.child(v_flex().rounded(7).border(1).border_color(pal.border)
          .bg(pal.cardBg).p(10).gap(4).flex_none()
          .child(text("No active subagents.", 11, t.muted)))));
  }

  // Color the outer work pane border/focus outline with the focused pane's
  // status palette; only re-applies when the resolved color changes.
  syncWorkBorder(live) {
    const fp = panes().find(p => p.focused) ?? panes()[0];
    const st = live.find(a => a.address === fp?.terminal)?.status ?? fp?.status ?? "idle";
    const borderCol = statusPalette(st, true).border;
    if (this.lastWorkBorder !== borderCol) {
      this.lastWorkBorder = borderCol;
      const tree = JSON.parse(JSON.stringify(layout() ?? {}));
      const work = find(tree, "work");
      if (work?.content?.pane) {
        work.content.pane.focus = { width: 2, color: borderCol };
        work.content.pane.border = { width: 1, color: borderCol };
        run("layout.set", { layout: tree });
      }
    }
  }

  deck(cx, t) {
    const live = collectAgents(agents(), terminals(), spaces(), this.getAcked());
    const cfg = this.getConfig();
    const allSpaces = spaces();
    const cards = this.spaceCards(allSpaces, live);
    const activeSpacePre = allSpaces.find(s => s.active);
    this.recordMru(activeSpacePre?.id);
    const lastActiveMap = this.touchLastActive(allSpaces, live);
    const raw = terminals();
    const { activeSpaces, otherSpaces } = partitionSpaces(allSpaces, live, this.expandedIds, lastActiveMap, raw, cfg.maxExpanded);
    this.expandedIds = activeSpaces.map(s => s.id);
    const ranked = sortAgents(live);
    const indexOf = new Map(ranked.slice(0, 9).map((a, i) => [a.address, i + 1]));
    setAgentOrder(ranked.map(a => a.address));
    const motion = shared(MOTION_KEY) !== false && window()?.active === true;
    const activeSpace = allSpaces.find(s => s.active);
    if (activeSpace?.id && this.lastActiveSpaceId && activeSpace.id !== this.lastActiveSpaceId) {
      this.ackSpace(this.lastActiveSpaceId, live);
    }
    this.lastActiveSpaceId = activeSpace?.id ?? this.lastActiveSpaceId;
    this.syncWorkBorder(live);
    const activeSubs = collectSubagents(live, activeSpace?.id);
    const wantVisible = activeSubs.length > 0;
    if (this.lastRailWant !== wantVisible) {
      this.lastRailWant = wantVisible;
      run(wantVisible ? "layout.show" : "layout.hide", { id: "subagents-rail" });
    }
    return v_flex().id("deck-root").size_full().min_h(0).bg(t.canvas).text_color(t.foreground)
      .child(this.deckHeader(live, t, motion, cfg))
      .child(h_flex().flex_1().min_h(0).p(10).gap(10)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .child(h_flex().flex_1().min_w(0).h_full().gap(10)
          .children(activeSpaces.map(s => this.spaceBox(s, cards, indexOf, lastActiveMap, raw, t, motion, cfg)))
          .when(!allSpaces.length, el => el.child(text("No spaces yet.\nOpen a terminal or agent to begin.", 12, t.muted).p(16))))
        .child(this.idleSpacesBox(otherSpaces, live, lastActiveMap, raw, t, cfg)));
  }

  spacesBar(t) {
    const allSpaces = spaces();
    const active = allSpaces.find(s => s.active);
    const live = collectAgents(agents(), terminals(), spaces(), this.getAcked());
    const tabPill = tab => {
      const tabAgents = live.filter(a => a.tab === tab.id);
      const dotStatus = tabAgents.length
        ? tabAgents.reduce((best, a) => (AGENT_RANK[a.status] ?? AGENT_RANK.idle) < AGENT_RANK[best] ? a.status : best, "idle")
        : (["working", "blocked", "error", "done"].includes(tab.status) ? tab.status : null);
      const program = panes().find(p => p.tab === tab.id && p.program?.agent)?.program
        ?? panes().find(p => p.tab === tab.id)?.program;
      return h_flex().id(`bar-tab-${tab.id}`).h(28).px(9).gap(5).flex_none().items_center()
        .rounded(6).border(1).text_size(11)
        .bg(tab.active ? t.raised : t.surface)
        .border_color(tab.active ? t.accent : t.border)
        .text_color(tab.active ? t.foreground : t.muted)
        .hover(el => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => {
          this.ackAgents(live.filter(a => a.tab === tab.id && a.status === "done"));
          run("tab.select", { id: tab.id });
        })
        .when(Boolean(program?.icon), el => el.child(program.tint
          ? svg(program.icon).size(12).flex_none().text_color(t.muted)
          : image(program.icon).size(12).flex_none()))
        .child(div().truncate().child(tab.name))
        .when(["working", "blocked", "error", "done"].includes(dotStatus),
          el => el.child(div().size(6).rounded(3).bg(t[dotStatus] ?? "#f59e0b").flex_none()))
        .when(tab.active, el => el.child(div().id(`bar-tab-rename-${tab.id}`).text_color(t.dim).flex_none()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.rename", { id: tab.id }); })
          .child(text("✎", 10, t.dim))))
        .when(tab.active, el => el.child(div().id(`bar-tab-close-${tab.id}`).text_color(t.dim).flex_none()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
          .child(svg("mods/pane/close.svg").size(11))));
    };
    return h_flex().id("deck-spaces-bar").size_full().h(38).px(10).gap(8).items_center()
      .bg(t.chrome).border_t(1).border_b(1).border_color(t.border)
      .child(h_flex().h(28).px(9).gap(6).flex_none().items_center()
        .rounded(6).border(1).border_color(t.border).bg(t.surface)
        .child(div().size(7).rounded(4).bg(t.accent).flex_none())
        .child(text(active?.name ?? "Space", 11.5, t.muted).font_semibold().flex_none().max_w(140).truncate())
        .when(Boolean(active), el => el.child(div().id("bar-space-rename").text_color(t.dim).flex_none()
          .hover(el2 => el2.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.rename", { id: active.id }); })
          .child(text("✎", 10, t.dim)))))
      .child(div().w(1).h(18).bg(t.border).flex_none())
      .child(h_flex().flex_1().min_w(0).gap(5).items_center().overflow_x_scrollbar()
        .children((active?.tabs ?? []).map(tabPill))
        .child(h_flex().id("bar-tab-new").h(28).px(8).flex_none().items_center().justify_center()
          .rounded(6).border(1).border_color(t.border).bg(t.surface).text_color(t.muted)
          .hover(el => el.bg(t.hover).text_color(t.foreground))
          .on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))
          .child(text("+", 12, t.muted))));
  }

  paneHeader(t) {
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const motion = shared(MOTION_KEY) !== false && window()?.active === true;
    const live = collectAgents(agents(), terminals(), spaces(), this.getAcked());
    const st = live.find(a => a.address === p.terminal)?.status
      ?? (["working", "blocked", "error", "done", "idle"].includes(p.status) ? p.status : "idle");
    const isShell = Boolean(p.program?.shell && !p.program?.agent);
    const pal = statusPalette(isShell && st === "idle" ? "shell" : st, p.focused);
    const space = spaces().find(s => s.tabs.some(tab => tab.id === p.tab));
    const tab = space?.tabs?.find(tb => tb.id === p.tab);
    const progName = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const name = (tab?.named && tab?.name) ? `${tab.name} · ${progName}` : progName;
    const button = (id, iconName, command, args) => div().id(id).p(3).rounded(4).text_color(t.dim)
      .hover(el => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/pane/${iconName}.svg`).size(13));
    return h_flex().id(`deck-pane-head-${p.pane}`).size_full().px(10).gap(8).items_center()
      .bg(pal.headerBg).border_b(1).border_color(pal.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hoveredPane = hovered ? p.pane : null; cx.notify(); })
      .on_click(() => {
        this.ackAgents(live.filter(a => a.address === p.terminal && a.status === "done"));
        run("pane.focus", { pane: p.pane });
      })
      .child(div().size(8).rounded(4).bg(pal.dot).flex_none())
      .when(Boolean(p.program?.icon), el => el.child(p.program.tint
        ? svg(p.program.icon).size(13).flex_none().text_color(t.dim)
        : image(p.program.icon).w(13).h(13).flex_none()))
      .child(div().flex_none().truncate().max_w(220).font_semibold().text_color(t.foreground).child(name))
      .child(div().id(`dph-rename-${p.pane}`).text_color(t.dim).flex_none()
        .hover(el => el.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (p.tab && p.tab !== "unplaced") run("tab.rename", { id: p.tab });
        })
        .child(text("✎", 10, t.dim)))
      .child(text(folder(p.cwd), 11, t.dim).flex_1().min_w(0).truncate())
      .when(Boolean(space?.branch), el => el.child(h_flex().h(18).px(6).flex_none().items_center()
        .rounded(5).bg(t.surface).text_size(10).text_color(t.muted).child(`⎇ ${space.branch}`)))
      .child(statusBadge(st, motion, isShell))
      .when(this.hoveredPane === p.pane || p.focused, el => el
        .child(button(`dph-r-${p.pane}`, "split-right", "pane.split", { direction: "right", pane: p.pane }))
        .child(button(`dph-d-${p.pane}`, "split-down", "pane.split", { direction: "down", pane: p.pane }))
        .child(button(`dph-z-${p.pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane: p.pane }))
        .child(button(`dph-x-${p.pane}`, "close", "pane.close", { pane: p.pane })));
  }

  render(cx) {
    this.seedInitialAcked();
    const t = theme();
    const role = props()?.role;
    if (role === "spaces-bar") return this.spacesBar(t);
    if (role === "pane-header") return this.paneHeader(t);
    if (role === "subagents") return this.subagentsRail(t);
    if (role === "customize-overlay") return this.customizeOverlay(t);
    if (role === "help-overlay") return this.helpOverlay(t);
    return this.deck(cx, t);
  }
}
