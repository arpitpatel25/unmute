/* ==========================================================================
   GLYPHS
   The app draws SF Symbols. SF Symbols are licensed for use in software for
   Apple platforms only, so they are NOT reproduced here — each of these is a
   hand-drawn equivalent built to the same 24-unit grid, the same regular
   stroke weight and the same optical proportions, so a row of them sits
   together the way the originals do.

   The ONE exception is `notePen`, which is not an SF Symbol at all: it is
   Unmute's own NotePenGlyph, and that path IS transcribed exactly, point for
   point, from PillView.swift.
   ========================================================================== */

/* SF's regular weight sits at ~1.6 units of stroke on a 24 grid. */
const SW = 1.6;

const ART = {
  /* ── Used by the pill ────────────────────────────────────────────────── */

  // av.remote — the Remote lane's glyph, swapped in for the record dot.
  "av.remote": {
    ratio: 0.62,
    d: `<rect x="7.4" y="1.9" width="9.2" height="20.2" rx="3.1" stroke="currentColor" stroke-width="${SW}" fill="none"/>
        <circle cx="12" cy="6.4" r="1.5" fill="currentColor"/>
        <rect x="9.6" y="10.8" width="1.9" height="1.9" rx="0.95" fill="currentColor"/>
        <rect x="12.5" y="10.8" width="1.9" height="1.9" rx="0.95" fill="currentColor"/>
        <rect x="9.6" y="14.4" width="1.9" height="1.9" rx="0.95" fill="currentColor"/>
        <rect x="12.5" y="14.4" width="1.9" height="1.9" rx="0.95" fill="currentColor"/>
        <rect x="9.6" y="18" width="4.8" height="1.9" rx="0.95" fill="currentColor"/>`,
  },

  checkmark: {
    ratio: 1.08,
    d: `<path d="M3.6 12.6 L9.3 18.3 L20.4 5.9" fill="none" stroke="currentColor"
          stroke-width="${SW + 0.5}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  xmark: {
    ratio: 0.94,
    d: `<path d="M5.4 5.4 L18.6 18.6 M18.6 5.4 L5.4 18.6" fill="none" stroke="currentColor"
          stroke-width="${SW + 0.4}" stroke-linecap="round"/>`,
  },

  "chevron.down": {
    ratio: 0.72,
    d: `<path d="M5.2 8.8 L12 15.6 L18.8 8.8" fill="none" stroke="currentColor"
          stroke-width="${SW + 0.9}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  "exclamationmark.triangle.fill": {
    ratio: 1.13,
    d: `<path d="M10.62 3.3 L1.7 18.6a1.6 1.6 0 0 0 1.38 2.4h17.84a1.6 1.6 0 0 0 1.38-2.4L13.38 3.3a1.6 1.6 0 0 0-2.76 0z" fill="currentColor"/>
        <path d="M12 8.6 v5.1" stroke="#000" stroke-width="1.9" stroke-linecap="round" opacity="0.92"/>
        <circle cx="12" cy="17.1" r="1.12" fill="#000" opacity="0.92"/>`,
  },

  mic: {
    ratio: 0.66,
    d: `<rect x="8.6" y="2.1" width="6.8" height="12.4" rx="3.4" fill="none"
          stroke="currentColor" stroke-width="${SW}"/>
        <path d="M5 11.2 v1.1a7 7 0 0 0 14 0 v-1.1" fill="none" stroke="currentColor"
          stroke-width="${SW}" stroke-linecap="round"/>
        <path d="M12 19.4 V22" fill="none" stroke="currentColor"
          stroke-width="${SW}" stroke-linecap="round"/>`,
  },

  "mic.fill": {
    ratio: 0.66,
    d: `<rect x="8.6" y="2.1" width="6.8" height="12.4" rx="3.4" fill="currentColor"/>
        <path d="M5 11.2 v1.1a7 7 0 0 0 14 0 v-1.1" fill="none" stroke="currentColor"
          stroke-width="${SW + 0.3}" stroke-linecap="round"/>
        <path d="M12 19.4 V22" fill="none" stroke="currentColor"
          stroke-width="${SW + 0.3}" stroke-linecap="round"/>`,
  },

  // waveform — five strokes, tallest at the centre, as SF draws it.
  waveform: {
    ratio: 1.16,
    d: `<g fill="none" stroke="currentColor" stroke-width="${SW}" stroke-linecap="round">
          <path d="M2.4 10.4 V13.6"/>
          <path d="M7.2 6.6 V17.4"/>
          <path d="M12 3.1 V20.9"/>
          <path d="M16.8 6.6 V17.4"/>
          <path d="M21.6 10.4 V13.6"/>
        </g>`,
  },

  laptopcomputer: {
    ratio: 1.19,
    d: `<rect x="4.1" y="4.3" width="15.8" height="11" rx="1.7" fill="none"
          stroke="currentColor" stroke-width="${SW}"/>
        <path d="M1.6 18.1 h20.8" fill="none" stroke="currentColor"
          stroke-width="${SW}" stroke-linecap="round"/>`,
  },

  iphone: {
    ratio: 0.6,
    d: `<rect x="6.4" y="1.8" width="11.2" height="20.4" rx="2.9" fill="none"
          stroke="currentColor" stroke-width="${SW}"/>
        <path d="M10.4 4.5 h3.2" fill="none" stroke="currentColor"
          stroke-width="1.25" stroke-linecap="round"/>`,
  },

  terminal: {
    ratio: 1.0,
    d: `<rect x="2.3" y="4" width="19.4" height="16" rx="3" fill="none"
          stroke="currentColor" stroke-width="${SW}"/>
        <path d="M6.6 9.2 L9.9 12.1 L6.6 15" fill="none" stroke="currentColor"
          stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12.4 15.4 h4.8" fill="none" stroke="currentColor"
          stroke-width="${SW}" stroke-linecap="round"/>`,
  },

  /* ── Used by the offline card (PillOfflineReason.symbol) ─────────────── */

  "person.crop.circle": {
    ratio: 1.0,
    d: `<circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="${SW}"/>
        <circle cx="12" cy="9.5" r="3.05" fill="none" stroke="currentColor" stroke-width="${SW}"/>
        <path d="M5.6 19.6a7.2 7.2 0 0 1 12.8 0" fill="none" stroke="currentColor"
          stroke-width="${SW}" stroke-linecap="round"/>`,
  },

  creditcard: {
    ratio: 1.32,
    d: `<rect x="1.6" y="4.6" width="20.8" height="14.8" rx="2.8" fill="none"
          stroke="currentColor" stroke-width="${SW}"/>
        <path d="M1.6 9.6 h20.8" fill="none" stroke="currentColor" stroke-width="${SW}"/>`,
  },

  "exclamationmark.circle": {
    ratio: 1.0,
    d: `<circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="${SW}"/>
        <path d="M12 6.9 v6.4" stroke="currentColor" stroke-width="${SW + 0.2}" stroke-linecap="round"/>
        <circle cx="12" cy="16.7" r="1.05" fill="currentColor"/>`,
  },

  "wifi.slash": {
    ratio: 1.24,
    d: `<g fill="none" stroke="currentColor" stroke-width="${SW}" stroke-linecap="round">
          <path d="M2.2 8.4a15 15 0 0 1 19.6 0"/>
          <path d="M5.6 12.3a10 10 0 0 1 12.8 0"/>
          <path d="M8.9 16.1a5.1 5.1 0 0 1 6.2 0"/>
        </g>
        <circle cx="12" cy="19.6" r="1.25" fill="currentColor"/>
        <path d="M3.4 3.4 L20.6 20.6" fill="none" stroke="currentColor"
          stroke-width="${SW + 0.4}" stroke-linecap="round"/>`,
  },
};

/**
 * Unmute's OWN glyph — a ruled page open on the right with a pen laid across
 * it. Transcribed EXACTLY from NotePenGlyph in PillView.swift.
 *
 * The Swift shape works in a 24-unit box but offsets its ink by one unit
 * (`ox = midX - (unit/2 + 1) * s`), because the drawing spans x 4…22 rather
 * than being centred. Shifting the viewBox by that same unit reproduces the
 * offset without touching a single coordinate.
 *
 * `side` is 18 and `strokeWidth` is 1 — pinned to the measured width of a
 * regular-weight 13pt SF glyph, NOT scaled from the source artwork's 1.6.
 */
const NOTE_PEN = {
  side: 18,
  strokeWidth: 1,
  viewBox: "1 0 24 24",
  d:
    // THE PAGE — left edge only, open on the right. Both corners are true
    // quarter-circles (addArc(tangent…), radius 2), not quad curves.
    "M14 3 L6 3 A2 2 0 0 0 4 5 L4 19 A2 2 0 0 0 6 21 L14 21 " +
    // TWO RULED LINES, 4 units apart.
    "M8 8 L13 8 M8 12 L12 12 " +
    // THE PEN — parallelogram body, triangular nib at (13.5,19.5), and a
    // semicircular butt of radius √2 centred on (21,12).
    "M20 11 L14 17 L13.5 19.5 L16 19 L22 13 A1.41421 1.41421 0 0 0 20 11 Z",
};

/**
 * One glyph, sized the way `Image(systemName:).font(.system(size:))` sizes it.
 * SF renders a symbol a little larger than its nominal point size; 1.28 is the
 * factor that puts these at the same optical weight beside 13pt body text.
 */
export function icon(name, size, extra = "") {
  const art = ART[name];
  if (!art) return "";
  const h = size * 1.28;
  const w = h * (art.ratio ?? 1);
  return `<svg class="u-icon" width="${w.toFixed(2)}" height="${h.toFixed(2)}"
    viewBox="${(12 - 12 * (art.ratio ?? 1)).toFixed(2)} 0 ${(24 * (art.ratio ?? 1)).toFixed(2)} 24"
    aria-hidden="true" focusable="false" ${extra}>${art.d}</svg>`;
}

/** The scratchpad chip's glyph, at its one fixed size. */
export function notePenGlyph() {
  return `<svg class="u-icon" width="${NOTE_PEN.side}" height="${NOTE_PEN.side}"
    viewBox="${NOTE_PEN.viewBox}" aria-hidden="true" focusable="false">
    <path d="${NOTE_PEN.d}" fill="none" stroke="currentColor"
      stroke-width="${NOTE_PEN.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** ProviderMarkArt: the vendor logo, plus a terminal glyph when it owns one. */
const PROVIDER = {
  claude: { file: "assets/mark-claude.png", ink: 0.449, name: "Claude Code CLI", short: "Claude" },
  codex:  { file: "assets/mark-codex.png",  ink: 0.752, name: "Codex CLI",       short: "Codex" },
};
const NAMES = {
  codex: "Codex CLI",
  "codex-desktop": "Codex desktop",
  "claude-code-desktop": "Claude desktop",
};

/** Equal-area optical scale — the sparsest mark draws full size, the rest
 *  shrink to match its ink. sqrt because area grows with the square of side. */
function opticalScale(ink) {
  const lightest = Math.min(PROVIDER.claude.ink, PROVIDER.codex.ink);
  return Math.min(1, Math.sqrt(lightest / ink));
}

/** ProviderMark. `size` defaults to ProviderMark.standard — 13, everywhere. */
export function providerMark(backend, terminal, size = 13) {
  const vendor = backend === "codex" || backend === "codex-desktop" ? "codex" : "claude";
  const p = PROVIDER[vendor];
  const inner = (size * opticalScale(p.ink)).toFixed(2);
  const label = (NAMES[backend] ?? "Claude Code CLI") + (terminal ? ", terminal" : "");
  return `<span class="u-mark" role="img" aria-label="${label}"
      title="${(NAMES[backend] ?? "Claude Code CLI") + (terminal ? " · has a terminal" : "")}"
      style="--mark-size:${size}px;--mark-gap:${(size * 0.31).toFixed(2)}px">
      <span class="u-mark-box"><img src="${p.file}" alt=""
        style="width:${inner}px;height:${inner}px"></span>
      ${terminal ? `<span class="u-mark-term">${icon("terminal", size * 0.78)}</span>` : ""}
    </span>`;
}
