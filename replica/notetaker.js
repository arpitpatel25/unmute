/* ==========================================================================
   THE MEETING NOTETAKER WIDGET — behaviour.
   Transcribed from NotetakerWidget.tsx.
   ========================================================================== */

/* 55pt of waveform at 2px bars on a 2px gap holds fourteen — which is what
   makes it read as a voice rather than a meter. */
export const BAR_COUNT = 14;

/* HOW EXCITABLE THE NOTETAKER'S WAVEFORM IS. Tuned DOWN from the dictation
   pill's, deliberately: the notetaker runs for an hour in the corner of a
   meeting, and anything that moves that much in peripheral vision is read as
   something demanding attention. */
export const NT_GAIN = 1.25;     // was 2 — a shout no longer pins every bar
export const NT_FLOOR = 0.08;    // room tone, fans, a laptop on a desk
export const NT_ATTACK = 0.28;   // rises in ~4 frames
export const NT_RELEASE = 0.07;  // falls over ~15, so it settles

/** One bar's envelope step. Asymmetric, the same shape a compressor has. */
export function advanceBar(prev, raw) {
  const gated = raw <= NT_FLOOR ? 0 : (raw - NT_FLOOR) / (1 - NT_FLOOR);
  const target = Math.min(1, gated);
  const k = target > prev ? NT_ATTACK : NT_RELEASE;
  return prev + (target - prev) * k;
}

const CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M5 12.5l4.2 4.1L19.5 6.8" stroke="currentColor" stroke-width="2.6"
    stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CROSS = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const TRASH = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const GLYPH = `<span class="u-nt-glyph"><i></i><i></i><i></i></span>`;

/** state: "idle" | "discard" | "completed" */
export function renderNotetaker(state = "idle") {
  let inner;
  if (state === "completed") {
    inner = `<span class="u-nt-inner">${GLYPH}
      <span class="u-nt-check">${CHECK}</span>
      <span class="u-nt-saved">Saved — preparing notes</span></span>`;
  } else if (state === "discard") {
    inner = `<button type="button" class="u-nt-close" data-action="keep"
        title="Keep recording" aria-label="Keep recording">${CROSS}</button>
      <button type="button" class="u-nt-end" data-action="end"
        title="End meeting" aria-label="End meeting">
        <span class="u-nt-end-swatch" aria-hidden="true"></span><span>End</span></button>
      <span class="u-nt-sep" aria-hidden="true"></span>
      <button type="button" class="u-nt-discard" data-action="discard"
        title="Discard recording" aria-label="Discard recording">${TRASH}<span>Discard</span></button>`;
  } else {
    inner = `<span class="u-nt-inner">
      <span class="u-nt-dot"></span>
      <span class="u-nt-wave"><span class="u-nt-bars" data-nt-bars>${"<i></i>".repeat(BAR_COUNT)}</span></span>
    </span>`;
  }
  const idle = state === "idle";
  return `<div class="u-nt" data-state="${state}"
      ${idle ? `role="button" tabindex="0" title="Note taker — click for meeting actions"` : ""}
      aria-label="${state === "completed" ? "Meeting saved — preparing notes"
        : idle ? "Note-taking in progress — tap for options" : ""}">${inner}</div>`;
}

/** Live bars off a level source. Bars below 2px are drawn at zero height. */
export function driveNotetaker(root, getLevel) {
  const state = new WeakMap();
  let raf;
  const tick = () => {
    root.querySelectorAll("[data-nt-bars]").forEach((row) => {
      let s = state.get(row);
      if (!s) { s = new Array(BAR_COUNT).fill(0); state.set(row, s); }
      const bars = row.children;
      for (let i = 0; i < bars.length; i++) {
        s[i] = advanceBar(s[i], getLevel(row, i) * NT_GAIN);
        const h = Math.round(s[i] * 20);
        bars[i].style.height = (h < 2 ? 0 : h) + "px";
        bars[i].style.opacity = (0.55 + 0.45 * s[i]).toFixed(3);
      }
    });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
