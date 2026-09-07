/* ==========================================================================
   THE PILL — state machine and rendering.
   Transcribed from PillView.swift, PillModel.swift, Waveform.swift,
   LevelMeterSupport/{LevelMeter,DotWave}.swift.
   ========================================================================== */

import { icon, notePenGlyph, providerMark } from "./icons.js";

/* ── LevelMeter ────────────────────────────────────────────────────────────
   THE MIC SIGNAL, TURNED INTO A HEIGHT. Every constant is fixed rather than
   adaptive: a previous revision normalised each frame against a decaying peak
   and amplified an empty room to full height, because dividing room tone by
   room tone is 1.0.
   ------------------------------------------------------------------------- */
export const LevelMeter = {
  gate: 0.018,      // below this, draw nothing
  ceiling: 0.32,    // the level that fills the bar — a loud moment, not a shout
  attack: 0.42,     // rise fast…
  release: 0.22,    // …fall slow
  target(raw) {
    const v = Math.min(1, Math.max(0, raw));
    if (v <= this.gate) return 0;
    const norm = Math.min(1, (v - this.gate) / (this.ceiling - this.gate));
    return Math.pow(norm, 0.62);
  },
  advance(envelope, target) {
    const rate = target > envelope ? this.attack : this.release;
    const next = envelope + (target - envelope) * rate;
    // Park exactly on zero rather than approaching it forever.
    return next < 0.004 ? 0 : next;
  },
};

/* ── DotWave ───────────────────────────────────────────────────────────────
   A ROW OF DOTS THAT VIBRATES IN PLACE. Two modes, because a single mode has
   fixed nodes and the middle dot would never move. The frequencies are
   deliberately INCOMMENSURATE so the row never looks like a looping animation.
   ------------------------------------------------------------------------- */
export const DotWave = {
  modeA: 2, modeB: 3,
  freqA: 3.1, freqB: 5.3,
  mixB: 0.5,
  shape(mode, index, count) {
    if (count <= 0) return 0;
    return Math.sin(Math.PI * mode * (index + 1) / (count + 1));
  },
  offset(index, count, time, amplitude) {
    if (amplitude <= 0) return 0;   // SILENCE IS A STRAIGHT ROW.
    const a = this.shape(this.modeA, index, count) * Math.sin(2 * Math.PI * this.freqA * time);
    const b = this.shape(this.modeB, index, count) * Math.sin(2 * Math.PI * this.freqB * time);
    const mixed = (a + this.mixB * b) / (1 + this.mixB);
    return Math.max(-1, Math.min(1, amplitude * mixed));
  },
};

/* ── PillOfflineReason ─────────────────────────────────────────────────────
   Text and symbol per reason, verbatim. Only paymentFailed is recoverable —
   one tinted thing per surface, and it is the one that fixes the problem.
   ------------------------------------------------------------------------- */
export const OFFLINE = {
  not_signed_in:     { text: "Sign in for faster cloud transcription",              symbol: "person.crop.circle" },
  no_subscription:   { text: "Subscribe for cloud transcription",                   symbol: "creditcard" },
  payment_failed:    { text: "Payment failed — update your card to restore cloud",  symbol: "exclamationmark.circle", recoverable: true },
  cloud_unreachable: { text: "Cloud unreachable — using the on-device model",       symbol: "wifi.slash" },
  chose_on_device:   { text: "On-device mode is selected in Settings",              symbol: "laptopcomputer" },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Only the two states that are telling you something wrong carry a wash —
 *  plus the formatter, which is a MODE and only while the capture is live. */
function pillTint(s) {
  switch (s.phase) {
    case "error":           return "var(--c-error)";
    case "output-fallback": return "var(--c-needs)";
    case "recording":
    case "processing":      return s.kind === "instruction" ? "var(--c-instruction)" : null;
    default:                return null;
  }
}

function glassAttrs(tint) {
  if (!tint) return "";
  return ` data-tint style="--tint-strong:color-mix(in srgb, ${tint} 95%, transparent);` +
         `--tint-wash:color-mix(in srgb, ${tint} 16%, transparent)"`;
}

const fmt = (n) => {
  const v = Math.max(n, 0);
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

function processingLabel(s) {
  if (s.draftOffer) return "Taking longer…";
  if (s.engineNotice) return "On-device";
  return "Processing";
}

/* ── The pill's interior, per phase ───────────────────────────────────────── */
function pillBody(s) {
  switch (s.phase) {
    case "hidden":
      return "";

    case "recording": {
      // Remote keeps its glyph — it is not a recording indicator, it is THE
      // LANE: "these words are going to a session, not your cursor".
      const glyph = s.kind === "remote"
        ? `<span class="u-remote-glyph">${icon("av.remote", 12)}</span>` : "";
      // The countdown is kept for the last stretch before the cap: there,
      // seconds remaining IS the information.
      const near = s.maxSeconds - s.elapsed <= 15;
      const middle = near
        ? `<span class="u-timer" data-near="${s.maxSeconds - s.elapsed <= 30}">${
             s.maxSeconds - s.elapsed <= 30 ? "-" + fmt(s.maxSeconds - s.elapsed) : fmt(s.elapsed)}</span>`
        : `<span class="u-wave" data-wave>${'<i></i>'.repeat(7)}</span>`;
      return `${glyph}${middle}
        <button type="button" class="u-cancel" data-action="cancel"
          title="Cancel — discard this recording" aria-label="Cancel — discard this recording">
          <span>${icon("xmark", 9)}</span></button>`;
    }

    case "paused":
      return `<span class="u-paused-dot"></span><span class="u-paused-label">Paused</span>`;

    case "processing": {
      let trailing = "";
      if (s.draftOffer) {
        trailing = `<button type="button" class="u-capsule-btn" data-action="acceptDraft">Use quick draft</button>`;
      } else if (s.engineNotice) {
        trailing = `<span class="u-note">offline model</span>`;
      } else if (s.showDiscardHint) {
        trailing = `<span class="u-note">Esc to discard</span>`;
      }
      return `<span class="u-processing-dot u-breathes"></span>
        <span class="u-processing-label">${esc(processingLabel(s))}</span>
        <span class="u-bouncing"><i></i><i></i><i></i></span>${trailing}`;
    }

    case "output":
      return icon("checkmark", 13);

    case "output-fallback":
      return `<span class="u-offline-icon" style="color:var(--c-needs)">${
          icon("exclamationmark.triangle.fill", 12)}</span>
        <span class="u-fallback-msg">${esc(s.fallbackMessage ?? "Formatting unavailable — pasted raw")}</span>
        ${s.outputPreview ? `<span class="u-fallback-preview">${esc(s.outputPreview)}</span>` : ""}`;

    case "too-short":
      return `<span class="u-tooshort">${esc(s.mutedText ?? "Didn't catch that")}</span>`;

    case "cancelled":
      return `<span class="u-cancelled-label">Cancelled</span>
        <button type="button" class="u-capsule-btn" data-action="undo">Undo</button>`;

    case "error": {
      const msg = s.message ?? "Something went wrong";
      return `<span style="color:var(--c-error);display:inline-flex">${icon("xmark", 12)}</span>
        <span class="u-error-stack"><span class="u-error-msg">${esc(msg)}</span>
        ${msg.includes("limit reached") ? "" :
          `<span class="u-error-hint">Retry from History to regenerate</span>`}</span>`;
    }
    default:
      return "";
  }
}

/* ── The chips and the rows around it ─────────────────────────────────────── */

function agentControl(s) {
  // The Agent lane is recognised by having nothing to offer: the engine blanks
  // both option lists for it, and only for it.
  const isAgentLane = !(s.agentOptions?.length) && !(s.modelOptions?.length);
  const picked = s.agentOptions?.find((o) => o.label === (s.agent ?? ""));
  return `<button type="button" class="u-agent-control u-glass"
      data-connected="${s.agentConnected !== false}"
      data-lane="${isAgentLane ? "agent" : "backend"}"
      aria-expanded="${!!s.selectorOpen}" data-action="toggleSelector"
      ${isAgentLane ? "disabled" : ""}>
      ${picked ? providerMark(picked.id, picked.terminal ?? true) : ""}
      <span class="u-agent-name">${esc((s.agent ?? "Claude Code") +
        (s.agentConnected === false ? " · connect" : ""))}</span>
      ${s.model ? `<span class="u-agent-model">${esc(s.model)}</span>` : ""}
      ${isAgentLane ? "" : `<span class="u-agent-chevron">${icon("chevron.down", 8)}</span>`}
    </button>`;
}

function selectorRow(label, on, backend, terminal) {
  return `<button type="button" class="u-selector-row" role="option" aria-selected="${on}"
      data-action="pick" data-value="${esc(label)}">
      <span class="u-selector-check">${icon("checkmark", 9)}</span>
      ${backend ? providerMark(backend, terminal) : ""}
      <span class="u-selector-label">${esc(label)}</span></button>`;
}

function selectorPanel(s) {
  const axes = s.modelAxes ?? [];
  const options = s.modelOptions ?? [];
  // HOW THE MODEL CONTROL IS SHAPED, decided by WHAT THE ENGINE SENT rather
  // than by which backend this is. A literal backend name cannot answer it.
  const chooser = axes.length ? "axes" : (options.length ? "list" : "empty");
  const agentId = s.agentOptions?.find((o) => o.label === (s.agent ?? ""))?.id ?? "claude";
  const summary = axes.map((a) => a.current).filter(Boolean).join(" · ") || (s.model ?? "Model");

  let cols = "";
  // Not shown when the capture is addressed to an existing task.
  if (s.taskId == null && s.agentOptions?.length) {
    cols += `<div class="u-selector-col" role="listbox" aria-label="Agent">
      <div class="u-selector-header">Agent</div>
      ${s.agentOptions.map((o) => selectorRow(o.label, o.id === agentId, o.id, o.terminal ?? true)).join("")}</div>`;
  }
  if (chooser === "axes") {
    cols += axes.map((a) => `<div class="u-selector-col" role="listbox" aria-label="${esc(a.axis)}">
      <div class="u-selector-header">${esc(a.axis)}</div>
      ${a.values.map((v) => selectorRow(v, v === a.current)).join("")}</div>`).join("");
  } else if (chooser === "list") {
    cols += `<div class="u-selector-col" role="listbox" aria-label="Model">
      <div class="u-selector-header">Model</div>
      ${options.map((o) => selectorRow(o.label, o.label === s.model)).join("")}</div>`;
  } else {
    // HONEST EMPTY STATE, IN THE ENGINE'S WORDS.
    cols += `<div class="u-selector-col" data-empty>
      <div class="u-selector-header">Model</div>
      <div class="u-selector-empty">${esc(s.modelEmpty ?? "No models to choose from")}</div></div>`;
  }
  return `<div class="u-selector u-glass u-glass--panel">
      <div class="u-selector-summary">${esc(summary)}</div>
      <div class="u-selector-cols">${cols}</div></div>`;
}

function micChip(s) {
  const isPhone = (s.mic ?? "").includes("iphone");
  return `<button type="button" class="u-chip u-glass" data-on="${isPhone}" data-action="pickMic"
      title="${isPhone ? "Capturing from iPhone — tap for the Mac mic"
                       : "Capturing from the Mac — tap for iPhone"}">
      ${icon(isPhone ? "iphone" : "laptopcomputer", 11)}</button>`;
}

function scratchpadChip(armed) {
  // It ARMS AND DISARMS ONLY — it never sends.
  return `<button type="button" class="u-chip u-chip--scratch u-glass" data-on="${!!armed}"
      data-action="toggleArm"
      title="${armed ? "Keeping on stop — tap to deliver normally again"
                     : "Keep on stop instead of delivering"}">
      ${notePenGlyph()}</button>`;
}

/** ONE CHIP AT A TIME, with strict precedence: mic narration first, then noise. */
function hintChip(s) {
  let accent, label, detail, symbol;
  if (s.micStatus) {
    const parts = s.micStatus.split(" — ");
    accent = "#f97316"; symbol = "mic";
    label = parts[0]; detail = parts.slice(1).join(" — ");
  } else if (s.coaching) {
    const quiet = s.coaching.level === "quiet";
    accent = quiet ? "#38bdf8" : "#fbbf24";
    symbol = quiet ? "mic" : "waveform";
    label = s.coaching.condition; detail = s.coaching.remedy ?? "";
  } else return "";
  return `<div class="u-hint u-glass"${glassAttrs(accent)} style="--hint-accent:${accent}">
      <span class="u-hint-icon">${icon(symbol, 11)}</span>
      <span class="u-hint-label">${esc(label)}</span>
      ${detail ? `<span class="u-hint-detail">${esc(detail)}</span>` : ""}</div>`;
}

function offlineCard(reason) {
  const r = OFFLINE[reason];
  if (!r) return "";
  const rec = !!r.recoverable;
  return `<div class="u-offline u-glass" data-recoverable="${rec}"${rec ? glassAttrs("var(--c-needs)") : ""}>
      <span class="u-offline-icon">${icon(r.symbol, 11.5)}</span>
      <span class="u-offline-text">${esc(r.text)}</span>
      ${rec ? `<button type="button" class="u-capsule-btn" data-prominent data-action="fixBilling">Update card</button>` : ""}
      <button type="button" class="u-offline-dismiss" data-action="dismissOffline"
        aria-label="Dismiss">${icon("xmark", 9)}</button></div>`;
}

/* ── The whole cluster ────────────────────────────────────────────────────── */
export function renderPill(state) {
  const s = { phase: "hidden", kind: "dictation", level: 0, elapsed: 0,
              maxSeconds: 300, agentConnected: true, ...state };
  if (s.phase === "hidden") return "";

  // Chips ride with the pill only while a capture is live. PAUSED counts: it
  // IS the capture, waiting.
  const chipsVisible = ["recording", "processing", "paused"].includes(s.phase);
  const selectorShowing = chipsVisible && s.selectorOpen && s.kind === "remote";
  const tint = pillTint(s);

  const cluster = `<div class="u-cluster">
      ${chipsVisible && s.kind === "remote" ? agentControl(s) : ""}
      <div class="u-pill u-glass" data-phase="${s.phase}"${glassAttrs(tint)}>${pillBody(s)}</div>
      ${chipsVisible && (s.micOptions?.length ?? 0) > 1 ? micChip(s) : ""}
      ${s.scratchpadEnabled && (chipsVisible || s.padShowing) ? scratchpadChip(s.armed) : ""}
    </div>`;

  return `<div class="u-pill-row"><div class="u-pill-column">
      ${chipsVisible ? hintChip(s) : ""}
      ${selectorShowing ? selectorPanel(s) : ""}
      ${cluster}
      ${chipsVisible && s.offline ? offlineCard(s.offline) : ""}
    </div></div>`;
}

/* ── Live waveform ─────────────────────────────────────────────────────────
   ONE CLOCK FOR THE WHOLE ROW, and NONE AT ALL while it is silent: with the
   envelope at zero there is nothing to redraw, so a muted mic costs no frames
   and, more to the point, CANNOT move.
   ------------------------------------------------------------------------- */
export function driveWaveforms(root, getLevel) {
  const envelopes = new WeakMap();
  let raf;
  const tick = () => {
    const t = performance.now() / 1000;
    let anyLive = false;
    root.querySelectorAll("[data-wave]").forEach((row) => {
      const level = getLevel(row);
      const prev = envelopes.get(row) ?? 0;
      const env = LevelMeter.advance(prev, LevelMeter.target(level));
      envelopes.set(row, env);
      if (env > 0) anyLive = true;
      const dots = row.children;
      const travel = 16 / 2 - 3.5 / 2;          // height/2 - dotSize/2 = 6.25
      for (let i = 0; i < dots.length; i++) {
        const y = DotWave.offset(i, dots.length, t, env);
        dots[i].style.transform = `translateY(${(y * travel).toFixed(3)}px)`;
        dots[i].style.opacity = (0.4 + 0.6 * env).toFixed(3);
      }
    });
    raf = requestAnimationFrame(tick);
    return anyLive;
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
