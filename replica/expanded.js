/* ==========================================================================
   THE EXPANDED SURFACES — the Orchestrator wall, the focused stage, the
   single-task attention panel, and the pocket card.
   Transcribed from WallView / StageView / TaskSurfaceView / PocketView /
   ConversationPanel / SurfaceSizeControls.
   ========================================================================== */

import { icon, providerMark } from "./icons.js";
import { notchPath, STATUS_COLOR } from "./notch.js";

/** Assets resolve against this module, not the importing document — the
 *  replica is loaded from more than one directory now. */
const ASSET = (f) => new URL(`assets/${f}`, import.meta.url).href;


const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_LABEL = {
  processing: "Working", "needs-user": "Needs you", ready: "Ready",
  stuck: "Stuck", failed: "Errored", done: "Done",
};
/** TaskStatus.isYourMove — colour encodes status only (rule R1). */
const isYourMove = (s) => s === "needs-user" || s === "ready" || s === "stuck" || s === "failed";

const dot = (status, size = 7, breathing = false) =>
  `<span class="u-dot" style="width:${size}px;height:${size}px;background:${STATUS_COLOR[status]}"
     ${breathing ? "data-breathing" : ""}></span>`;
const statusLabel = (s) =>
  `<span class="u-status-label" style="color:${STATUS_COLOR[s]}">${STATUS_LABEL[s]}</span>`;
const num = (t) => `<span class="u-num">${esc(t)}</span>`;
const badge = (text, color = "#9b9ba1") =>
  `<span class="u-badge2" style="--badge-color:${color}">${esc(text)}</span>`;
const keyBtn = (label, { symbol, danger } = {}) =>
  `<button type="button" class="u-key-btn" ${danger ? "data-danger" : ""}>${
    symbol ? icon(symbol, 9.5) : ""}${esc(label)}</button>`;
const quietBtn = (label, symbol) =>
  `<button type="button" class="u-quiet-btn">${symbol ? icon(symbol, 10) : ""}${esc(label)}</button>`;
const roundBtn = (symbol, size, title) =>
  `<button type="button" class="u-round-btn" title="${esc(title)}" aria-label="${esc(title)}">${icon(symbol, size)}</button>`;

/* ── SurfaceSizeControls ───────────────────────────────────────────────────
   The range stops at 0.95, not 1.0: an expanded surface edge-to-edge leaves no
   ground around it, and the notch is deliberately an overlay rather than a
   window. It stops at 0.40 because below that the task view cannot hold a
   readable column and a terminal at the same time.
   ------------------------------------------------------------------------- */
export const SurfaceSizeStep = {
  minimum: 0.40, maximum: 0.95, fallback: 0.80, nudge: 0.05,
  clamp(fill) {
    if (Number.isNaN(fill)) return this.fallback;
    return Math.round(Math.min(Math.max(fill, this.minimum), this.maximum) * 100) / 100;
  },
  fraction(fill) { return (this.clamp(fill) - this.minimum) / (this.maximum - this.minimum); },
  fill(fraction) {
    if (Number.isNaN(fraction)) return this.fallback;
    return this.clamp(this.minimum + (this.maximum - this.minimum) * Math.min(Math.max(fraction, 0), 1));
  },
};

function sizeControls(fill) {
  const f = SurfaceSizeStep.fraction(fill);
  const w = 116, x = f * w;
  return `<div class="u-size" data-size-control data-fill="${fill}"
      role="slider" aria-label="Expanded size" tabindex="0"
      aria-valuemin="40" aria-valuemax="95" aria-valuenow="${Math.round(fill * 100)}">
      <span class="u-size-label">${Math.round(fill * 100)}%</span>
      <span class="u-size-track">
        <span class="u-size-track-bg"></span>
        <span class="u-size-fill" style="width:${Math.max(x, 0).toFixed(1)}px"></span>
        <span class="u-size-knob" style="left:${Math.min(Math.max(x - 6, 0), w - 12).toFixed(1)}px"></span>
      </span></div>`;
}

/* ── The panel shell ──────────────────────────────────────────────────────
   The expanded panel is the SAME single path as the bar-level mass — its own
   concave top fillet (14) and its own radius (18), both part of the shape
   rather than an overlay. It hangs from the top edge of the screen.
   ------------------------------------------------------------------------- */
export function panel(inner, { width, height, machine = "mbp14", pocket = false, shoulders = "" } = {}) {
  // A panel with square shoulders reads as a floating window pasted over the
  // screen instead of something the screen grew — same path, same fillets.
  const fillet = pocket ? 10 : 14;   // barFillet at a 34pt bar / Theme.panelFillet
  const path = notchPath(width, height, fillet, pocket ? 10 : 18);
  // THE SHOULDER ROW IS OUTSIDE THE PLANE, on the housing's own line, so the
  // plane below it never passes behind the camera. The grey plane is a
  // different material from the black around it: where it crossed the housing
  // it simply stopped being displayed, taking its own rounded corners with it.
  return `<div class="u-panel" data-machine="${machine}" ${pocket ? "data-pocket" : ""}
      style="width:${width}px;height:${height}px">
      <div class="u-panel-shell" style="clip-path:path('${path}');width:100%;height:100%;
        display:flex;flex-direction:column;${shoulders ? "padding-top:0" : ""}">
        ${shoulders}
        <div class="u-plane" style="flex:1;min-height:0">${inner}</div>
      </div></div>`;
}

/** The pocket's shoulder row — identity left of the cutout, controls right of
 *  it, nothing behind the camera. Zero-width middle off-notch, so the row
 *  collapses to an ordinary header on a display without one. */
export function pocketShoulders(p, cutoutWidth) {
  const quiet = p.demanding === false;
  const status = quiet ? "done" : (p.status ?? "needs-user");
  return `<div class="u-pocket-shoulders">
      <div class="u-pocket-shoulder-left">
        ${dot(status, 8)}
        ${p.isAgent
          ? `<img src="${ASSET('unmark.png')}" alt="Unmute" style="height:16px;width:25.8px;display:block">`
          : providerMark(p.backend, p.terminal ?? true, 16)}
      </div>
      <div class="u-pocket-shoulder-mid" style="width:${cutoutWidth}px"></div>
      <div class="u-pocket-shoulder-right">
        ${roundBtn("square.grid.2x2", 8.5, "Open the dashboard")}
        ${roundBtn("xmark", 8, "Close — your voice goes back to normal routing")}
      </div>
    </div>`;
}

/* ── The Orchestrator wall ────────────────────────────────────────────────── */

const VIEW_MODES = [
  { key: "today", title: "Today" },
  { key: "needsYou", title: "Needs you" },
  { key: "finished", title: "Finished" },
  { key: "allWork", title: "All work" },
];

/** Nil where the emptiness speaks for itself — an empty list already says
 *  "nothing needs you", and being congratulated for it grates every time. */
const EMPTY_MESSAGE = {
  needsYou: null,
  finished: "No finished work here",
  today: "No sessions — speak to spawn one",
  allWork: "No sessions — speak to spawn one",
};

function card(c) {
  const yourMove = isYourMove(c.status);
  return `<button type="button" class="u-card" ${yourMove ? "data-yourmove" : ""}
      style="--card-status:${STATUS_COLOR[c.status]}">
      <span class="u-card-head">
        ${dot(c.status, 7, c.status === "processing")}
        ${statusLabel(c.status)}
        ${c.promoted ? badge("now a session", "rgba(255,255,255,0.93)") : ""}
        ${c.agentOrigin ? badge(c.agentOrigin, "var(--c-ready)") : (c.agent ? badge("agent", "var(--c-ready)") : "")}
        <span style="flex:1"></span>
        ${c.qpos ? badge("Q" + c.qpos) : ""}
      </span>
      <span class="u-card-title">${esc(c.title)}</span>
      ${c.activity ? `<span class="u-card-activity">${esc(c.activity)}</span>` : ""}
      ${c.note ? `<span class="u-card-note">${icon("pencil", 9.5)}${esc(c.note)}</span>` : ""}
      <span class="u-card-foot">
        ${providerMark(c.backend, c.terminal ?? true)}
        ${num(c.kind === "session" ? (c.dir ?? "session") : "one-off")}
        <span class="u-spacer"></span>
        ${num(c.age ?? "")}
      </span></button>`;
}

function railSection(title, rows, trailing) {
  return `<div class="u-rail-section">
      <div class="u-rail-head"><span class="u-section-label">${esc(title)}</span>
        ${trailing ? quietBtn(trailing) : ""}</div>
      ${rows}</div>`;
}

/** The voice chip's wording, exactly as WallView resolves it. */
function voiceChipText(m) {
  if (m.capturePhase) {
    const target = m.captureTarget ?? "new task";
    if (m.capturePhase === "listening") return `Listening → ${target}`;
    if (m.capturePhase === "transcribing" || m.capturePhase === "routing")
      return m.capturePhase[0].toUpperCase() + m.capturePhase.slice(1) + "…";
    if (m.capturePhase === "landed") return `Landed → ${target}`;
  }
  if (m.focusedTitle) return `Voice → ${m.focusedTitle}`;
  return "Voice → new task";
}

export function renderWall(m) {
  const view = m.view ?? "today";
  const workspace = m.workspace ?? "All workspaces";
  const showHeadings = workspace === "All workspaces";
  const groups = (m.groups ?? []).filter((g) => showHeadings || g.name === workspace);
  const anyRunning = (m.groups ?? []).some((g) => g.cards.some((c) => c.status === "processing"));

  const place = showHeadings ? "across your workspaces" : `in ${workspace}`;
  const subtitle = {
    today: `Work moving ${place} today.`,
    needsYou: `Work waiting for your decision ${place}.`,
    finished: `Recently finished work ${place}.`,
    allWork: `All visible work ${place}.`,
  }[view];

  const rail = `<div class="u-rail"><div class="u-rail-sections">
    ${railSection(`Queue · ${m.queue.length}`, m.queue.length
      ? m.queue.map((q, i) => `<button type="button" class="u-rail-row">
          <span class="u-num" style="width:20px">Q${i + 1}</span>${dot(q.status, 6)}
          <span class="u-rail-row-name">${esc(q.name)}</span></button>`).join("")
      : `<div class="u-rail-empty">Clear</div>`)}
    ${railSection(`One-offs · ${m.oneoffs.length}`, m.oneoffs.length
      ? m.oneoffs.map((o) => `<button type="button" class="u-rail-row">
          ${dot(o.status, 6)}<span class="u-rail-row-name">${esc(o.name)}</span>
          ${num(o.age ?? "")}</button>`).join("")
      : `<div class="u-rail-empty">Short-lived tasks resolve here</div>`, "Clear finished")}
    ${m.shelf?.length ? railSection(`Shelf · ${m.shelf.length}`,
      m.shelf.map((s) => `<div class="u-rail-row" style="cursor:default">
        <span class="u-rail-row-name">${esc(s.name)}</span>
        <button type="button" class="u-round-btn" title="Unshelve — back on the wall"
          style="width:16px;height:16px;background:none">${icon("chevron.up", 10)}</button>
      </div>`).join("")) : ""}
  </div></div>`;

  const main = `<div class="u-wall-main">
    <div class="u-scroll-edge" style="--edge-h:52px">
      <div class="u-scroll u-wall-scroll"><div class="u-wall-groups">
        <div class="u-wall-title">
          <h3>${esc(showHeadings ? VIEW_MODES.find((v) => v.key === view).title : workspace)}</h3>
          <p>${esc(subtitle)}</p>
        </div>
        ${groups.length ? groups.map((g) => `<section class="u-group">
            ${showHeadings ? `<div class="u-group-head">
              <h4 ${g.name === "Ungrouped" ? "data-ungrouped" : ""}>${esc(g.name)}</h4>
              ${g.cards.length > 3 ? quietBtn(`Show all · ${g.cards.length}`) : ""}
            </div>` : ""}
            <div class="u-card-grid" style="grid-template-columns:repeat(${m.columns ?? 1},minmax(0,1fr))">
              ${g.cards.map(card).join("")}</div>
          </section>`).join("")
          : (EMPTY_MESSAGE[view]
            ? `<p style="font:var(--f-body);color:var(--text-faint);text-align:center;padding-top:34px;margin:0">${EMPTY_MESSAGE[view]}</p>`
            : "")}
      </div></div>
    </div>
    <div class="u-wall-bottom">
      <div class="u-voice-chip" ${m.capturePhase ? "data-live" : ""}>
        ${icon(m.capturePhase ? "mic.fill" : "mic", 11)}<span>${esc(voiceChipText(m))}</span>
      </div>
      <span class="u-spacer"></span>
      ${sizeControls(m.surfaceFill ?? 0.8)}
      <button type="button" class="u-bell" ${m.doorbell === false ? "data-off" : ""}
        title="Doorbell — spoken headlines when a task needs you">${icon(m.doorbell === false ? "bell.slash" : "bell", 12.5)}</button>
    </div>
  </div>`;

  return `<div class="u-wall">
    <div class="u-wall-chrome">
      <img src="${ASSET('unmark.png')}" alt="Unmute" style="height:13px;width:21px;display:block">
      <span class="u-section-label">Orchestrator</span>
      <div class="u-view-tabs" role="tablist">
        ${VIEW_MODES.map((v) => `<button type="button" class="u-view-tab" role="tab"
          aria-selected="${v.key === view}" data-view="${v.key}">${v.title}</button>`).join("")}
      </div>
      <span style="flex:1"></span>
      ${anyRunning ? `<span class="u-system-moving">${dot("processing", 6, true)}System moving</span>` : ""}
      <button type="button" class="u-round-btn" title="Close (esc, or click outside)"
        aria-label="Close">${icon("xmark", 10)}</button>
    </div>
    <div class="u-wall-chrome-rule"></div>
    <div class="u-wall-body">
      <div class="u-workspace-rail">
        <span class="u-section-label">Workspaces</span>
        <div class="u-ws-list">
          <button type="button" class="u-ws-btn" aria-selected="${workspace === "All workspaces"}"
            data-workspace="All workspaces">
            <span class="u-ws-marker" ${anyRunning ? "data-active" : ""}></span>
            <span class="u-ws-name">All workspaces</span>${num(String((m.groups ?? []).length))}</button>
          ${(m.groups ?? []).map((g) => `<button type="button" class="u-ws-btn"
            aria-selected="${workspace === g.name}" data-workspace="${esc(g.name)}">
            <span class="u-ws-marker" ${g.cards.some((c) => c.status === "processing") ? "data-active" : ""}
              ${g.name === "Ungrouped" ? "data-ungrouped" : ""}></span>
            <span class="u-ws-name">${esc(g.name)}</span>${num(String(g.cards.length))}</button>`).join("")}
        </div>
      </div>
      ${main}
      ${rail}
    </div>
  </div>`;
}

/* ── The transcript ───────────────────────────────────────────────────────── */

/** RichText, at the level of inline markdown the panel actually renders. */
function rich(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

/** Codex phrases this as elapsed wall time; keep its wording exactly. */
function workedLabel(ms) {
  if (!ms || ms <= 0) return "Worked on it";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `Worked for ${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem === 0 ? `Worked for ${m}m` : `Worked for ${m}m ${rem}s`;
}

function conversation(rows) {
  return `<div class="u-convo">${rows.map((r) => {
    if (r.kind === "user") {
      return `<div class="u-user-row"><div class="u-user-bubble">${rich(r.text)}</div></div>`;
    }
    if (r.kind === "answer") {
      return `<div class="u-answer"><div class="u-answer-text">${rich(r.text)}</div>
        <div class="u-copy-row"><button type="button" class="u-copy-btn" data-copy>
          ${icon("doc.on.doc", 10.5)}<span>Copy</span></button></div></div>`;
    }
    const steps = r.steps ?? [];
    return `<div class="u-work" data-work>
      <button type="button" class="u-work-toggle">
        <span class="u-work-chevron">${icon("chevron.down", 9)}</span>
        <span class="u-work-label">${esc(r.failed ? "Failed" : workedLabel(r.durationMs))}</span>
        ${steps.length ? num(`${steps.length} step${steps.length === 1 ? "" : "s"}`) : ""}
      </button>
      <div class="u-work-rule"></div>
      <div class="u-work-steps" hidden>${steps.map((s) => `<div class="u-step" ${s.ok === false ? "data-failed" : ""}>
        <span class="u-step-icon">${icon(s.ok === false ? "xmark" : "chevron.right", 8.5)}</span>
        <span class="u-step-title">${esc(s.title)}</span>
        ${s.ms ? num(s.ms < 1000 ? `${s.ms}ms` : `${(s.ms / 1000).toFixed(1)}s`) : ""}</div>`).join("")}
      </div></div>`;
  }).join("")}</div>`;
}

function composer(t) {
  return `<div class="u-composer">
      <textarea class="u-composer-input" rows="1"
        placeholder="${esc(t.placeholder ?? "Reply — or hold right ⌥ and speak")}"></textarea>
      ${t.modelLabel ? `<span class="u-composer-model">${esc(t.modelLabel)}</span>` : ""}
      <button type="button" class="u-send" aria-label="Send">${icon("arrow.up", 11)}</button>
    </div>`;
}

/* ── The single-task attention panel ──────────────────────────────────────── */
export function renderTaskSurface(m) {
  const t = m.task;
  const ended = (t.status === "done" || t.status === "failed") && t.kind !== "session";
  return `<div class="u-stage">
    <div class="u-stage-head">
      ${dot(t.status, 9, t.status === "processing")}
      ${providerMark(t.backend, t.hasTerminal)}
      <span class="u-stage-title">${esc(t.title)}</span>
      ${statusLabel(t.status)}
      ${t.elapsed ? num(t.elapsed) : ""}
      <span class="u-spacer"></span>
      ${m.attention > 0 ? `<span class="u-stage-count">1 of ${m.attention}</span>` : ""}
      <button type="button" class="u-round-btn" title="Close (esc, or click outside)"
        aria-label="Close">${icon("xmark", 10)}</button>
    </div>
    <div class="u-scroll-edge" style="--edge-h:26px"><div class="u-scroll">
      ${conversation(m.rows ?? [])}</div></div>
    ${ended ? "" : composer({ modelLabel: t.modelLabel, placeholder: t.placeholder })}
    <div class="u-stage-actions">
      ${t.alive ? keyBtn("Stop", { symbol: "stop.circle" }) : ""}
      ${t.hasTerminal ? keyBtn("Terminal", { symbol: "terminal" }) : ""}
      ${ended ? keyBtn("Re-run", { symbol: "arrow.clockwise" }) : ""}
      ${keyBtn("Pause background audio", { symbol: "pause.circle" })}
      <span class="u-spacer"></span>
      ${keyBtn(t.isOwned === false ? "Remove" : "Kill", { danger: true, symbol: "trash" })}
    </div>
    <div class="u-stage-foot">
      ${quietBtn("Open dashboard", "square.grid.2x2")}
      ${quietBtn("Mute", "bell.slash")}
      <span class="u-spacer"></span>
      ${sizeControls(m.surfaceFill ?? 0.8)}
      ${keyBtn("Prev", { symbol: "arrow.left" })}
      <button type="button" class="u-act-btn">${icon("arrow.right", 10)}Next</button>
    </div>
  </div>`;
}

/* ── The focused stage inside the cockpit ─────────────────────────────────── */
export function renderStage(m) {
  const t = m.task;
  return `<div class="u-stage">
    <div class="u-stage-head">
      ${dot(t.status, 9, t.status === "processing")}
      ${providerMark(t.backend, t.hasTerminal)}
      <span class="u-stage-title">${esc(t.title)}</span>
      <span class="u-spacer"></span>
      <span class="u-key-group">
        ${keyBtn(t.kind === "session" ? "Unpin" : "Pin", { symbol: t.kind === "session" ? "pin.slash" : "pin" })}
        ${keyBtn("Shelve", { symbol: "archivebox" })}
      </span>
      <span class="u-key-group" style="margin-left:6px">
        ${t.alive ? keyBtn("Kill", { danger: true, symbol: "stop.circle" }) : keyBtn("Resume", { symbol: "play" })}
      </span>
      <span style="margin-left:6px">${keyBtn("Remove", { danger: true, symbol: "trash" })}</span>
      ${t.hasTerminal && t.alive ? `<span style="margin-left:6px">${keyBtn("Terminal", { symbol: "terminal" })}</span>` : ""}
      <button type="button" class="u-round-btn" style="margin-left:6px" aria-label="Close"
        title="Close (esc, or click outside)">${icon("xmark", 10)}</button>
    </div>
    <div class="u-scroll-edge" style="--edge-h:26px"><div class="u-scroll">
      ${conversation(m.rows ?? [])}</div></div>
    ${composer({ modelLabel: t.modelLabel, placeholder: "Reply — or hold right ⌥ and speak" })}
    <div class="u-stage-foot">
      <span class="u-spacer"></span>
      ${sizeControls(m.surfaceFill ?? 0.8)}
    </div>
  </div>`;
}

/* ── The pocket card ─────────────────────────────────────────────────────── */
export function renderPocket(p, shoulders = false) {
  const quiet = p.demanding === false;
  const status = p.status ?? "needs-user";
  // The mark already says "Unmute"; the title would say it again — unless the
  // mark has moved up to the shoulders, in which case the title is all there is.
  const showTitle = !p.isAgent || shoulders;
  return `<div class="u-pocket" ${quiet ? "data-quiet" : ""} ${shoulders ? "data-shoulders" : ""}>
    <div class="u-pocket-head">
      ${shoulders ? "" : dot(quiet ? "done" : status, 8)}
      ${shoulders ? "" : (p.isAgent
        ? `<img src="${ASSET('unmark.png')}" alt="Unmute" style="height:14px;width:22.6px;display:block">`
        : providerMark(p.backend, p.terminal ?? true, 14))}
      ${showTitle ? `<span class="u-pocket-title">${esc(p.title ?? "Nothing in your pocket")}</span>` : ""}
    </div>
    ${p.ask ? `<div class="u-pocket-ask" ${p.toast ? "data-toast" : ""}>${esc(p.ask)}</div>` : ""}
    <div class="u-pocket-foot">
      ${p.slots > 1 ? `<span class="u-pocket-rail">${
        Array.from({ length: p.slots }, (_, i) =>
          `<span class="u-pocket-pip" ${i === (p.at ?? 0) ? "data-on" : ""}></span>`).join("")}</span>` : ""}
      <span class="u-spacer"></span>
      <span class="u-pocket-status" style="color:${STATUS_COLOR[quiet ? "done" : status]}">${
        STATUS_LABEL[quiet ? "done" : status]}</span>
    </div>
    <div class="u-pocket-controls">
      ${roundBtn("square.grid.2x2", 8.5, "Open the dashboard")}
      ${roundBtn("xmark", 8, "Close — your voice goes back to normal routing")}
    </div>
  </div>`;
}
