/* ==========================================================================
   THE NOTCH — bar level.
   Transcribed from NotchShape.swift, NotchGeometry.swift, BarContent.swift
   and NotchView.swift.
   ========================================================================== */

/* ── NotchShape ────────────────────────────────────────────────────────────
   Two kinds of corner, and both belong to this ONE path:
     * BOTTOM OUTER — convex, matching the radius macOS uses on the cutout's
       own bottom corners. Only the outer two: the middle, where the mass
       crosses the housing, is dead straight.
     * TOP OUTER — CONCAVE. Where the mass meets the menu bar the black flares
       OUTWARD in a quarter circle instead of stopping at a right angle. This
       inverted curve is what separates a surface that belongs to the screen
       from one pasted on top of it.
   The fillets live INSIDE the rect: the body is the rect inset by `topFillet`
   on each side, and the flare fills that inset back out at the top.
   ------------------------------------------------------------------------- */
export function notchPath(w, h, topFillet, bottomRadius) {
  // Nothing may exceed half the width or the whole height: a mass narrower
  // than its own corners is the collapse animation's last frame, and it must
  // degenerate cleanly rather than fold inside out.
  const f = Math.max(Math.min(topFillet, w / 2, h), 0);
  const bodyMin = f, bodyMax = w - f;
  const br = Math.max(Math.min(bottomRadius, (bodyMax - bodyMin) / 2, Math.max(h - f, 0)), 0);
  const n = (v) => Number(v.toFixed(3));
  return [
    // Top-left, out on the menu bar, then the concave flare inward + down.
    `M0,0`,
    `Q${n(bodyMin)},0 ${n(bodyMin)},${n(f)}`,
    // Down the left wall to the bottom-left convex corner.
    `L${n(bodyMin)},${n(h - br)}`,
    `Q${n(bodyMin)},${n(h)} ${n(bodyMin + br)},${n(h)}`,
    // The bottom edge — DEAD STRAIGHT across the cutout region.
    `L${n(bodyMax - br)},${n(h)}`,
    `Q${n(bodyMax)},${n(h)} ${n(bodyMax)},${n(h - br)}`,
    // Up the right wall and out through the second flare.
    `L${n(bodyMax)},${n(f)}`,
    `Q${n(bodyMax)},0 ${n(w)},0`,
    // Closed along the screen's top edge, which is where the shape hangs from.
    `Z`,
  ].join(" ");
}

/* ── BarContent metrics ───────────────────────────────────────────────────── */
export const Bar = {
  dotSize: 7,
  inset: 13,          // outer breathing room at each far end of the mass
  gap: 7,             // between elements inside a half, and half-to-middle
  wordmarkTracking: 2.1,
  wordmarkSize: 9.5,
  markHeight: 13,     // cap height of the drawn mark
  statusSize: 11,
  detailSize: 11.5,
  restingWidth: 56,   // stated, not derived: a nub carries no text
  markAspect: 126 / 78,
};
/** UnMark.width(for:) — one trailing point of air, as the app does. */
const markWidth = (h) => h * Bar.markAspect + 2;

/* NotchGeometry's overflow policy, in one place. */
export const Geom = {
  segmentGap: 18,        // when there is no cutout to separate the halves
  minRightSegment: 54,   // below this the right half is DROPPED, not ellipsised
  barEdgeKeepOut: 24,    // so the mass never collides with the clock
  filletOfBar: 0.30,
  cornerOfBar: 0.30,
  fillet: (barH) => Math.max(Math.round(barH * 0.30), 4),
  corner: (barH) => Math.max(Math.round(barH * 0.30), 4),
};

/* Text measurement through the DOM rather than canvas, so the font resolves
   exactly as it does when rendered — `-apple-system` is SF Pro here and the
   status/detail strings are measured in the very fonts they are drawn in. */
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif';
let ruler;
function measure(text, weight, size) {
  if (!ruler) {
    ruler = document.createElement("span");
    ruler.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
    document.body.appendChild(ruler);
  }
  // Set the properties individually rather than via the `font` shorthand: the
  // shorthand silently fails to parse if the family string is anything it does
  // not like, and a failed parse leaves the ruler measuring in the UA default
  // — which is how every label longer than "Working" ended up clipped.
  ruler.style.fontFamily = FONT_FAMILY;
  ruler.style.fontWeight = String(weight);
  ruler.style.fontSize = size + "px";
  ruler.style.letterSpacing = "normal";
  ruler.textContent = text;
  return ruler.getBoundingClientRect().width;
}

/** The count badge: two digits at most before it stops being a count. */
const badgeWidth = (n) => Math.ceil(measure(String(n), 600, 9.5) + 12);

/** Width the LEFT half needs to be shown WHOLE. It is never cut down to fit. */
export function leftWidth(c) {
  if (c.resting) return Bar.restingWidth;
  if (!c.dot && !c.left) return 0;
  let w = Bar.inset;
  if (c.dot) w += Bar.dotSize + Bar.gap;
  if (c.emphasis === "wordmark") w += markWidth(Bar.markHeight);
  else if (c.left) w += measure(c.left, 500, Bar.statusSize);
  if (c.badge > 1) w += Bar.gap + badgeWidth(c.badge);
  return Math.ceil(w + Bar.gap);
}

/** Width the RIGHT half WANTS. What it gets is decided by the screen. */
export function wantsRightWidth(c) {
  if (!c.right) return 0;
  return Math.ceil(Bar.gap + measure(c.right, 400, Bar.detailSize) + Bar.inset);
}

/** NotchGeometry.mass — the right segment truncates first and is dropped
 *  entirely below minRightSegment; the left is never truncated. */
export function mass(c, screen) {
  const fillet = Geom.fillet(screen.barHeight);
  const left = leftWidth(c);
  const roomRight = Math.max(screen.rightUsable - fillet - Geom.barEdgeKeepOut, 0);
  let right = Math.min(wantsRightWidth(c), roomRight);
  if (right < Geom.minRightSegment) right = 0;
  const middle = screen.cutoutWidth > 0
    ? screen.cutoutWidth
    : (left > 0 && right > 0 ? Geom.segmentGap : 0);
  return { left, middle, right, fillet, bottomRadius: Geom.corner(screen.barHeight) };
}

/* ── The state table, from the spec, in code and nowhere else ─────────────── */
const STATUS_LABEL = {
  processing: "Working", "needs-user": "Needs you", ready: "Ready",
  stuck: "Stuck", failed: "Errored", done: "Done",
};
export const STATUS_COLOR = {
  processing: "var(--c-working)", "needs-user": "var(--c-needs)", ready: "var(--c-ready)",
  stuck: "var(--c-error)", failed: "var(--c-error)", done: "var(--c-done)",
};
const AGENT_ACTIVITY = {
  listening:  ["processing", "Listening"],
  searching:  ["processing", "Searching"],
  thinking:   ["processing", "Thinking"],
  confirming: ["needs-user", "Confirming"],
  complete:   ["done", "Done"],
  failed:     ["failed", "Couldn't complete"],
};

const isExpanded = (s) => s === "task" || s === "cockpit";

/**
 * BarContent.make — ordered exactly as the source orders it. The ranking is
 * the design: routing outranks every resting state because it is happening
 * now and briefly; the pocket outranks a wordmark because something waiting
 * on you outranks an identity.
 */
export function makeBarContent(m, state, hovering) {
  // Feedback must remain visible at the surface where the action began.
  if (m.toast && !isExpanded(state)) {
    return { dot: "failed", left: "Couldn't complete", right: m.toast, alarm: "failed" };
  }
  if (m.agentActivity && !isExpanded(state)) {
    const [status, label] = AGENT_ACTIVITY[m.agentActivity.state];
    return {
      dot: status, left: label, emphasis: "status", right: m.agentActivity.summary,
      alarm: (m.agentActivity.state === "confirming" || m.agentActivity.state === "failed") ? status : null,
    };
  }
  // Between the pill vanishing and the task appearing, the router is deciding
  // where the words go — so the surface says so rather than saying nothing.
  if (m.capturePhase === "routing" && !isExpanded(state)) {
    return { dot: "processing", left: "Sending", emphasis: "status" };
  }
  // ONLY WHAT IS WAITING MAY SPEAK FROM THE CLOSED SURFACE — `waiting`, not
  // `taskCount`, or a pocket holding work you had already settled would
  // announce it in the your-move colour as though it were new.
  if (m.pocket?.waiting > 0 && !isExpanded(state) && !m.pocket.isOpen) {
    const n = m.pocket.waiting;
    const c = {
      dot: "needs-user",
      left: n === 1 ? "1 waiting on you" : `${n} waiting on you`,
      emphasis: "status", alarm: "needs-user",
    };
    // Hovering names the one your voice would reach.
    if (hovering && m.pocket.slots?.[0]) c.right = m.pocket.slots[0].title;
    return c;
  }
  switch (state) {
    case "dormant":
      // Nothing. Not a hairline, not a sliver — an always-visible idle
      // indicator stops being an indicator.
      return {};
    case "idle":
      // OFF-NOTCH AND UNTOUCHED: a nub, not a nameplate.
      if (!m.hasNotch && !hovering) return { resting: true };
      return { left: "unmute", emphasis: "wordmark" };
    case "active": {
      const c = { dot: "processing", left: STATUS_LABEL.processing, emphasis: "status", badge: m.working };
      if (m.working === 1 && m.task?.status === "processing") {
        c.right = hovering ? m.task.title : (m.task.activity ?? m.task.title);
      }
      return c;
    }
    case "attention": {
      const status = m.task?.status ?? "needs-user";
      const c = {
        dot: status, left: STATUS_LABEL[status], emphasis: "status",
        badge: m.attention, alarm: status,
      };
      if (m.task) c.right = m.task.question?.text ?? m.task.activity ?? m.task.title;
      return c;
    }
    default:
      return {};   // the expanded panel carries its own chrome
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/** The bar row. THE MIDDLE IS EMPTY BY CONSTRUCTION — on a notched display
 *  there is no screen behind it, and the mass is drawn through it by the
 *  shape, not by anything here. */
function barRow(c, p, working) {
  // The mark is not tinted with leftInk: it carries the brand's own colours.
  const leftInk = c.emphasis === "wordmark"
    ? `rgba(255,255,255,${working > 0 ? 0.92 : 0.85})`
    : (c.alarm ? STATUS_COLOR[c.alarm] : "var(--text)");

  let left = "";
  if (c.dot || c.left) {
    left = `${c.dot ? `<span class="u-bar-dot" style="background:${STATUS_COLOR[c.dot]}"
        ${c.dot === "processing" ? "data-breathing" : ""}></span>` : ""}
      ${c.emphasis === "wordmark"
        ? `<img class="u-bar-mark" src="assets/unmark.png" alt="Unmute"
             style="width:${(Bar.markHeight * Bar.markAspect).toFixed(2)}px">`
        : c.left ? `<span class="u-bar-status" style="color:${leftInk}">${esc(c.left)}</span>` : ""}
      ${c.badge > 1 ? `<span class="u-badge"
          style="--badge-color:${STATUS_COLOR[c.alarm ?? c.dot ?? "needs-user"]}">${c.badge}</span>` : ""}`;
  }
  const right = (c.right && p.right > 0)
    ? `<span class="u-bar-detail">${esc(c.right)}</span>` : "";

  // A half with no width carries no inset either. NotchView's leftHalf/rightHalf
  // are @ViewBuilders that render NOTHING when there is nothing to say — so
  // their padding does not exist to push the middle off the housing, which is
  // exactly what a zero-width border-box with 13pt of padding would do.
  const half = (w) => `width:${w}px${w ? "" : ";padding:0"}`;
  return `<div class="u-bar-row">
      <div class="u-bar-left" style="${half(p.left)}">${p.left ? left : ""}</div>
      <div class="u-bar-mid" style="width:${p.middle}px"></div>
      <div class="u-bar-right" style="${half(p.right)}">${p.right ? right : ""}</div>
    </div>`;
}

/**
 * Render one notch onto a stage.
 * `screen` is the measured display: { barHeight, cutoutWidth, leftUsable,
 * rightUsable } — the four numbers macOS reports and NotchGeometry never
 * invents.
 */
export function renderNotch(model, state, hovering, screen) {
  const c = makeBarContent(model, state, hovering);
  const p = mass(c, screen);
  const w = p.left + p.middle + p.right + 2 * p.fillet;
  const h = screen.barHeight;

  // The nub is drawn small and hit big: the window stays a full menu-bar tall.
  const nub = c.resting;
  const shapeH = nub ? 7 : h;
  const path = notchPath(w, shapeH, nub ? 3 : p.fillet, nub ? 4 : p.bottomRadius);

  // ANCHORED ON THE HOLE, not on the screen: the mass's middle must sit
  // exactly over the cutout or the whole illusion collapses. Centring the
  // whole mass instead lets the middle drift off the housing the moment the
  // two halves differ in width — which is every state that says anything.
  // With no cutout the anchor is the screen's own centre.
  const anchorX = screen.width / 2;
  const midStart = screen.cutoutWidth > 0
    ? anchorX - screen.cutoutWidth / 2
    : anchorX - p.middle / 2;
  const x = midStart - p.left - p.fillet;

  return `<div class="u-notch" data-state="${state}" ${nub ? "data-resting" : ""}
      style="width:${w}px;left:${x}px" role="button" tabindex="0"
      aria-label="${esc([c.left, c.right].filter(Boolean).join(" — ") || "Unmute")}">
      <div class="u-notch-shape" style="clip-path:path('${path}');height:${shapeH}px"></div>
      ${nub ? "" : barRow(c, p, model.working ?? 0)}
    </div>`;
}
