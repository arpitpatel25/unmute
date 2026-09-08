/* ==========================================================================
   DRIVE THE REAL SURFACES.

   Nothing here draws anything. Every pixel comes from the replica modules,
   which were transcribed from the Swift; this file only decides WHICH STATE
   each surface is in and when, exactly as AppController does in the app.
   ========================================================================== */

import { renderPill, LevelMeter, DotWave } from "../replica/pill.js";
import { notchParts } from "../replica/notch.js";
import { renderNotetaker } from "../replica/notetaker.js";
import { renderWall, renderTaskSurface, renderPocket, pocketShoulders, panel } from "../replica/expanded.js";
import { speak } from "./speech.js";

/* ── The display we are drawing, measured the way NotchGeometry measures ──── */
const SCREEN = { width: 1512, barHeight: 34, cutoutWidth: 200, hasNotch: true };
SCREEN.leftUsable = SCREEN.rightUsable = (SCREEN.width - SCREEN.cutoutWidth) / 2;

const $ = (s) => document.querySelector(s);
const pillHost = $("#pill"), notchHost = $("#notch"), ntHost = $("#nt"),
      panelHost = $("#panel"), docEl = $("#doc"), narratorEl = $("#narrator"),
      keysEl = $("#keys");

/* ── State ────────────────────────────────────────────────────────────────── */
const S = {
  pill: { phase: "hidden" },
  notch: "idle",
  notchModel: { working: 0, attention: 0, hasNotch: true },
  hovering: false,
  expanded: null,           // null | "task" | "cockpit" | "pocket"
  nt: null,                 // null | "idle" | "discard" | "completed"
  held: null,               // which key is down
  busy: false,              // a scripted beat is running
};

/* ── Rendering: re-render, but carry the capsule's width across ──────────────
   The app morphs one surface rather than swapping two, and the width is the
   motion you actually see. Re-creating the element loses that, so the new one
   starts at the old one's width and travels — 240ms on the ease SwiftUI's
   .easeInOut resolves to, which is Theme.surfaceTransitionDuration exactly.
   -------------------------------------------------------------------------- */
function morphFrom(host, prevWidth, sel) {
  const el = host.querySelector(sel);
  if (!el || prevWidth == null) return;
  const w = el.getBoundingClientRect().width;
  if (Math.abs(w - prevWidth) < 0.5) return;
  el.style.width = prevWidth + "px";
  el.getBoundingClientRect();
  el.style.transition = "width 240ms cubic-bezier(0.42, 0, 0.58, 1)";
  el.style.width = w + "px";
  setTimeout(() => { el.style.width = ""; el.style.transition = ""; }, 260);
}

function drawPill() {
  const prev = pillHost.querySelector(".u-pill")?.getBoundingClientRect().width;
  pillHost.innerHTML = renderPill(S.pill);
  morphFrom(pillHost, prev, ".u-pill");
}

/* MOUNTED ONCE, THEN PATCHED. The mass grows on hover, so re-rendering it on
   mouseenter detaches the very node the pointer is over — which cancels the
   click that was about to happen and leaves the notch unclickable. It is also
   the only way the width and the shape actually travel: both are animatable
   here exactly as `animatableData` makes them animatable in the Swift. */
let notchEl, shapeEl, rowEl;
function mountNotch() {
  notchHost.innerHTML =
    `<div class="u-notch" role="button" tabindex="0">
       <div class="u-notch-shape"></div><div class="u-bar-slot"></div>
     </div>`;
  notchEl = notchHost.querySelector(".u-notch");
  shapeEl = notchHost.querySelector(".u-notch-shape");
  rowEl = notchHost.querySelector(".u-bar-slot");
  notchEl.addEventListener("mouseenter", () => { S.hovering = true; drawNotch(); });
  notchEl.addEventListener("mouseleave", () => { S.hovering = false; drawNotch(); });
  notchEl.addEventListener("click", onNotchClick);
  notchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNotchClick(); }
  });
}

function drawNotch() {
  const n = notchParts(S.notchModel, S.notch, S.hovering, SCREEN);
  notchEl.dataset.state = n.state;
  notchEl.toggleAttribute("data-resting", n.nub);
  notchEl.setAttribute("aria-label", n.label);
  notchEl.style.width = n.width + "px";
  notchEl.style.left = n.left + "px";
  shapeEl.style.clipPath = `path('${n.path}')`;
  shapeEl.style.height = n.shapeH + "px";
  if (rowEl.dataset.sig !== n.row) { rowEl.innerHTML = n.row; rowEl.dataset.sig = n.row; }
}

function drawNotetaker() {
  ntHost.innerHTML = S.nt ? renderNotetaker(S.nt) : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── The document ─────────────────────────────────────────────────────────── */
const DOC = { title: "Notes", paras: [], live: "" };
function drawDoc() {
  docEl.innerHTML =
    `<h1>${DOC.title}</h1>` +
    (DOC.paras.length || DOC.live
      ? DOC.paras.map((p) => `<p>${p}</p>`).join("") +
        (DOC.live ? `<p class="landing">${DOC.live}<span class="caret" data-live></span></p>`
                  : `<p><span class="caret"></span></p>`)
      : `<p class="placeholder">Hold <b>Fn</b> and say something.<span class="caret"></span></p>`);
  docEl.scrollTop = docEl.scrollHeight;
}

function narrate(html) {
  narratorEl.innerHTML = html;
  narratorEl.removeAttribute("data-hidden");
}

/* ── Dictation ────────────────────────────────────────────────────────────
   The waveform is driven by the SAME LevelMeter + DotWave the app uses; the
   only difference is where the raw level comes from. Here it is generated from
   the sentence's own rhythm (see speech.js), so a flat row still means silence
   and the shape still belongs to the words.
   -------------------------------------------------------------------------- */
let dictation = null;

function startDictation({ kind, text, onLand }) {
  const script = speak(text);
  const started = performance.now();
  dictation = { script, started, kind, text, onLand, landed: 0, cancelled: false };

  S.pill = kind === "remote"
    ? { phase: "recording", kind: "remote", agent: "Claude Code", model: "Opus 4.6",
        agentConnected: true,
        agentOptions: [{ id: "claude", label: "Claude Code", terminal: true },
                       { id: "codex", label: "Codex CLI", terminal: true }],
        modelOptions: [{ id: "opus", label: "Opus 4.6" }, { id: "sonnet", label: "Sonnet 4.6" }],
        level: 0, elapsed: 0, maxSeconds: 300 }
    : { phase: "recording", kind, level: 0, elapsed: 0, maxSeconds: 300 };
  drawPill();
  tickWave();
}

/* One clock for the row, and none at all while it is silent. */
let waveRaf = null, envelope = 0;
function tickWave() {
  cancelAnimationFrame(waveRaf);
  const step = () => {
    if (!dictation) { envelope = 0; return; }
    const ms = performance.now() - dictation.started;
    const raw = dictation.script.levelAt(ms);
    envelope = LevelMeter.advance(envelope, LevelMeter.target(raw));

    const row = pillHost.querySelector("[data-wave]");
    if (row) {
      const t = performance.now() / 1000;
      const travel = 16 / 2 - 3.5 / 2;                 // height/2 − dotSize/2
      for (let i = 0; i < row.children.length; i++) {
        const y = DotWave.offset(i, row.children.length, t, envelope);
        row.children[i].style.transform = `translateY(${(y * travel).toFixed(3)}px)`;
        row.children[i].style.opacity = (0.4 + 0.6 * envelope).toFixed(3);
      }
    }
    // Words land at the cursor as they are spoken — dictation is not a
    // transcript that arrives at the end.
    const words = dictation.script.words;
    while (dictation.landed < words.length && ms >= words[dictation.landed].endMs - 40) {
      DOC.live = (DOC.live ? DOC.live + " " : "") + words[dictation.landed].text;
      dictation.landed++;
      if (dictation.kind !== "remote") drawDoc();
    }
    waveRaf = requestAnimationFrame(step);
  };
  waveRaf = requestAnimationFrame(step);
}

async function endDictation() {
  if (!dictation) return;
  const d = dictation;
  dictation = null;
  cancelAnimationFrame(waveRaf);

  // Nothing captured — too short or silent. No API call was made.
  const heldFor = performance.now() - d.started;
  if (heldFor < 420) {
    S.pill = { phase: "too-short" }; drawPill();
    DOC.live = ""; drawDoc();
    await sleep(1300);
    S.pill = { phase: "hidden" }; drawPill();
    return;
  }

  S.pill = { phase: "processing", kind: d.kind, showDiscardHint: true };
  drawPill();
  await sleep(760);
  await d.onLand?.(d);
}

/* ── The four keys ────────────────────────────────────────────────────────── */
const LINE_1 = "The new direction feels right. Let's give the typography more room and keep the interactions simple.";
const LINE_2 = "Tighten the typography scale across the marketing pages and show me what changed.";

const KEYS = {
  fn: {
    code: "KeyF", cap: "Fn", what: "dictate",
    down() {
      DOC.live = "";
      narrate("Speaking. The waveform is the level, so a <b>flat row means silence</b> — nothing here wobbles for decoration.");
      startDictation({ kind: "dictation", text: LINE_1, onLand: land });
    },
    up: endDictation,
  },
  caps: {
    code: "CapsLock", cap: "⇪ Caps Lock", what: "format",
    enabled: () => DOC.paras.length > 0,
    down() {
      // The formatter transforms what you say instead of typing it verbatim —
      // a different axis from Remote, so it takes its own hue.
      DOC.selection = true; drawDoc();
      narrate("The formatter. Same voice, but it <b>rewrites</b> instead of typing — so the capsule takes indigo, the one hue nothing else here uses.");
      startDictation({ kind: "instruction", text: "make that tighter and drop the second clause", onLand: format });
    },
    up: endDictation,
  },
  ropt: {
    code: "AltRight", cap: "right ⌥", what: "hand off",
    down() {
      narrate("Remote. The glyph replaces the dot because this is a <b>lane</b>, not a recording state — these words go to a session, not to your cursor.");
      startDictation({ kind: "remote", text: LINE_2, onLand: handOff });
    },
    up: endDictation,
  },
  lctrl: {
    code: "ControlLeft", cap: "left ⌃ ×2", what: "meeting",
    press: toggleMeeting,
  },
};

/* ── What happens when a capture lands ────────────────────────────────────── */

async function land() {
  // SILENT SUCCESS. The text is already at the cursor; anything more is the
  // pill talking about itself.
  S.pill = { phase: "output" }; drawPill();
  DOC.paras.push(DOC.live); DOC.live = ""; drawDoc();
  narrate("A green tick, and nothing else — <b>the text is already at your cursor</b>. Now try <b>⇪ Caps Lock</b> to reformat it.");
  await sleep(1100);
  S.pill = { phase: "hidden" }; drawPill();
  refreshKeys();
}

async function format() {
  S.pill = { phase: "output" }; drawPill();
  DOC.live = "";
  DOC.paras[DOC.paras.length - 1] =
    "The new direction feels right — give the typography more room.";
  DOC.selection = false; drawDoc();
  narrate("Rewritten in place. Now hold <b>right ⌥</b> and hand something to an agent instead.");
  await sleep(1100);
  S.pill = { phase: "hidden" }; drawPill();
}

async function handOff() {
  DOC.live = "";
  S.pill = { phase: "hidden" }; drawPill();

  // Between the pill vanishing and the task existing, the router is deciding
  // where the words go. The surface used to say nothing at all here.
  S.notch = "idle";
  S.notchModel = { ...S.notchModel, capturePhase: "routing" };
  drawNotch();
  narrate("The pill is gone and the task does not exist yet — so the notch says <b>Sending</b> rather than nothing.");
  await sleep(1150);

  S.notchModel = { ...S.notchModel, capturePhase: null, working: 1,
    task: { status: "processing", title: "Tighten the typography scale",
            activity: "Reading the type ramp" } };
  S.notch = "active";
  drawNotch();
  narrate("Working. One word for one state, the count in the badge — and the right half carries what is <b>actually happening</b>. Hover it.");
  await sleep(2600);

  S.notchModel = { ...S.notchModel,
    task: { ...S.notchModel.task, activity: "Applying the scale to /pricing" } };
  drawNotch();
  await sleep(2600);

  S.notchModel = { working: 0, attention: 1, hasNotch: true,
    task: { status: "needs-user", title: "Tighten the typography scale",
            question: { text: "Apply the new scale to the whole site, or only the marketing pages?" } } };
  S.notch = "attention";
  drawNotch();
  narrate("It needs you. The <b>one state that glows</b> — and the question itself is in the bar. <b>Click the notch.</b>");
}

/* ── Expanding ────────────────────────────────────────────────────────────── */

const TASK = {
  status: "needs-user", title: "Tighten the typography scale",
  backend: "claude", hasTerminal: true, alive: true, kind: "session",
  elapsed: "4m", modelLabel: "opus", isOwned: true,
};
const ROWS = [
  { kind: "user", text: LINE_2 },
  { kind: "work", durationMs: 38000, steps: [
    { title: "Read the type ramp", ms: 640, ok: true },
    { title: "Apply the scale to /pricing", ms: 2100, ok: true },
    { title: "Diff the marketing templates", ms: 1450, ok: true },
  ] },
  { kind: "answer", text: "The ramp is in `tokens.css` and four pages import it. **Two of them are marketing**; the other two are the app shell, where the scale is tied to the native type sizes.\n\nApply the new scale to the whole site, or only the marketing pages?" },
];

function openPanel(kind) {
  S.expanded = kind;
  const width = kind === "cockpit" ? 1180 : 900;
  const height = kind === "cockpit" ? 760 : 620;
  const inner = kind === "cockpit"
    ? renderWall(WALL)
    : renderTaskSurface({ task: TASK, rows: ROWS, attention: 1, surfaceFill: 0.77 });
  panelHost.innerHTML = panel(inner, { width, height });
  panelHost.dataset.open = "true";
  // The reply the question is waiting for.
  if (kind === "task") {
    const composer = panelHost.querySelector(".u-composer");
    if (composer) {
      composer.insertAdjacentHTML("beforebegin",
        `<div class="answer-chips">
           <button type="button" class="u-act-btn" data-answer="Whole site">Whole site</button>
           <button type="button" class="u-key-btn" data-answer="Marketing only">Marketing only</button>
         </div>`);
    }
  }
  S.notch = kind === "cockpit" ? "cockpit" : "task";
  drawNotch();
}

function closePanel() {
  S.expanded = null;
  panelHost.dataset.open = "false";
  panelHost.innerHTML = "";
}

function onNotchClick() {
  if (S.expanded) return;
  // A tap on a notch that says "3 in your pocket" and getting the task surface
  // would answer a different question than the one it just asked.
  if (S.notch === "attention") { openPanel("task"); narrate("The whole panel is one shape with the mass — same path, same concave shoulders. <b>Answer it.</b>"); }
  else { openPanel("cockpit"); narrate("Everything at once. Click a card to focus it; drag the size track; <b>Esc</b> to close."); }
}

const WALL = {
  view: "today", workspace: "All workspaces", columns: 2, surfaceFill: 0.77, doorbell: true,
  groups: [
    { name: "unmute marketing", cards: [
      { id: "a", status: "needs-user", title: "Tighten the typography scale",
        activity: "Apply the new scale to the whole site, or only the marketing pages?",
        backend: "claude", kind: "session", dir: "~/site", age: "4m", qpos: 1 },
      { id: "b", status: "done", title: "Rewrite the onboarding copy",
        activity: "Three files edited. Here's where it landed.",
        backend: "claude", kind: "session", dir: "~/site", age: "1h" } ] },
    { name: "engine", cards: [
      { id: "c", status: "processing", title: "Parakeet warm-start",
        activity: "Profiling the first-token path", backend: "codex", kind: "session",
        dir: "~/engine", age: "12m" },
      { id: "d", status: "done", title: "Notch geometry audit",
        activity: "Every radius now derives from the measured bar.",
        backend: "codex", kind: "oneoff", age: "3h" } ] },
  ],
  queue: [{ id: "a", status: "needs-user", name: "Tighten the typography scale" }],
  oneoffs: [
    { id: "d", status: "done", name: "Notch geometry audit", age: "3h" },
    { id: "e", status: "done", name: "Waveform envelope tuning", age: "5h" },
  ],
  shelf: [{ id: "f", name: "Provider mark optical scale" }],
};

/* ── The meeting notetaker ────────────────────────────────────────────────── */
let lctrlLast = 0;
async function toggleMeeting() {
  const now = performance.now();
  if (S.nt) return;
  if (now - lctrlLast > 600) {           // left ⌃ TWICE — one press is nothing
    lctrlLast = now;
    narrate("Once more — <b>left ⌃ twice</b> starts the meeting. Stop is never a single, direct action.");
    return;
  }
  lctrlLast = 0;
  S.nt = "idle"; drawNotetaker();
  narrate("Recording the room. Bottom-left, its baseline flush with the pill's. <b>Click it</b> for the actions.");
  driveNtBars();
}

let ntRaf = null, ntLevels = new Array(14).fill(0);
function driveNtBars() {
  cancelAnimationFrame(ntRaf);
  const step = () => {
    const row = ntHost.querySelector("[data-nt-bars]");
    if (row) {
      const t = performance.now() / 1000;
      for (let i = 0; i < row.children.length; i++) {
        const raw = Math.max(0, 0.05 + Math.sin(t * 2.4 + i * 0.66) * 0.15
                                + Math.sin(t * 0.47 + i * 0.2) * 0.09) * 1.25;
        const gated = raw <= 0.08 ? 0 : (raw - 0.08) / 0.92;
        const target = Math.min(1, gated);
        ntLevels[i] += (target - ntLevels[i]) * (target > ntLevels[i] ? 0.28 : 0.07);
        const h = Math.round(ntLevels[i] * 20);
        row.children[i].style.height = (h < 2 ? 0 : h) + "px";
        row.children[i].style.opacity = (0.55 + 0.45 * ntLevels[i]).toFixed(3);
      }
    }
    ntRaf = requestAnimationFrame(step);
  };
  ntRaf = requestAnimationFrame(step);
}

/* ── Input ────────────────────────────────────────────────────────────────── */

function keyDown(id) {
  const k = KEYS[id];
  if (!k || S.held || S.busy || S.expanded) return;
  if (k.enabled && !k.enabled()) return;
  if (k.press) { k.press(); return; }
  S.held = id;
  keysEl.querySelector(`[data-key="${id}"]`)?.setAttribute("data-held", "");
  k.down();
}
function keyUp(id) {
  if (S.held !== id) return;
  S.held = null;
  keysEl.querySelector(`[data-key="${id}"]`)?.removeAttribute("data-held");
  KEYS[id].up?.();
}

function refreshKeys() {
  for (const [id, k] of Object.entries(KEYS)) {
    const cap = keysEl.querySelector(`[data-key="${id}"]`);
    if (!cap) continue;
    cap.toggleAttribute("data-disabled", !!(k.enabled && !k.enabled()));
  }
}

keysEl.innerHTML = Object.entries(KEYS).map(([id, k]) =>
  `<button type="button" class="keycap" data-key="${id}">
     <span class="keycap-key">${k.cap}</span>
     <span class="keycap-what">${k.what}</span>
   </button>`).join("");

keysEl.addEventListener("pointerdown", (e) => {
  const cap = e.target.closest(".keycap");
  if (cap) { e.preventDefault(); keyDown(cap.dataset.key); }
});
window.addEventListener("pointerup", () => { if (S.held) keyUp(S.held); });

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "Escape" && S.expanded) { closePanel(); S.notch = S.notchModel.attention ? "attention" : "idle"; drawNotch(); return; }
  const id = Object.keys(KEYS).find((k) => KEYS[k].code === e.code);
  if (id) { e.preventDefault(); keyDown(id); }
});
window.addEventListener("keyup", (e) => {
  const id = Object.keys(KEYS).find((k) => KEYS[k].code === e.code);
  if (id) keyUp(id);
});

/* Everything inside the panel that has to do something. */
document.addEventListener("click", async (e) => {
  const answer = e.target.closest("[data-answer]");
  if (answer) {
    closePanel();
    S.notchModel = { working: 1, attention: 0, hasNotch: true,
      task: { status: "processing", title: "Tighten the typography scale",
              activity: answer.dataset.answer === "Whole site" ? "Applying to 4 pages" : "Applying to 2 pages" } };
    S.notch = "active"; drawNotch();
    narrate("Answered. It carries on — and the surface goes back to saying one quiet thing.");
    await sleep(3200);
    S.notchModel = { working: 0, attention: 0, hasNotch: true };
    S.notch = "idle"; drawNotch();
    narrate("Done. <b>Click the notch</b> for everything at once, or start again with <b>Fn</b>.");
    return;
  }
  if (e.target.closest('.u-round-btn[aria-label="Close"]')) {
    closePanel(); S.notch = S.notchModel.attention ? "attention" : "idle"; drawNotch(); return;
  }
  // The notetaker: tapping the recording pill opens the actions in place.
  const nt = e.target.closest(".u-nt");
  const act = e.target.closest("[data-action]");
  if (nt && !act && S.nt === "idle") { S.nt = "discard"; drawNotetaker(); return; }
  if (act && ntHost.contains(act)) {
    const a = act.dataset.action;
    if (a === "keep") { S.nt = "idle"; drawNotetaker(); driveNtBars(); }
    if (a === "discard") { S.nt = null; drawNotetaker(); narrate("Discarded. Nothing was kept."); }
    if (a === "end") {
      S.nt = "completed"; drawNotetaker();
      narrate("The rim and the contents say saved; <b>the fill never changes</b>.");
      await sleep(1800);
      S.nt = null; drawNotetaker();
    }
  }
  // A card on the wall focuses that task — the voice address.
  const card = e.target.closest(".u-card");
  if (card && S.expanded === "cockpit") { closePanel(); openPanel("task"); }
});

/* ── Fit the machine to the viewport ──────────────────────────────────────── */
function fit() {
  const m = document.querySelector(".machine");
  const pad = 56;
  const k = Math.min((innerWidth - pad) / (m.offsetWidth || 1534),
                     (innerHeight - pad) / (m.offsetHeight || 1004));
  document.querySelector(".machine-fit").style.setProperty("--k", Math.min(k, 1).toFixed(4));
}
addEventListener("resize", fit);

/* ── Go ───────────────────────────────────────────────────────────────────── */
drawDoc(); mountNotch(); drawNotch(); drawPill(); refreshKeys(); fit();
narrate("This is the real interface, rebuilt in the browser. <b>Hold Fn</b> — or press and hold <b>F</b> — and watch the notch.");
