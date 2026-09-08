/* ==========================================================================
   DRIVE THE REAL SURFACES, ONE STEP AT A TIME.

   Nothing here draws anything. Every pixel of the product comes from the
   replica modules, which were transcribed from the Swift; this file decides
   which state each surface is in, and the tour decides when to ask for the
   next press.
   ========================================================================== */

import { renderPill, LevelMeter, DotWave } from "../replica/pill.js";
import { notchParts } from "../replica/notch.js";
import { renderNotetaker } from "../replica/notetaker.js";
import { renderWall, renderTaskSurface, renderPocket, pocketShoulders, panel } from "../replica/expanded.js";
import { speak } from "./speech.js";

/* The display being drawn, measured the way NotchGeometry measures. */
const SCREEN = { width: 1512, barHeight: 34, cutoutWidth: 200, hasNotch: true };
SCREEN.leftUsable = SCREEN.rightUsable = (SCREEN.width - SCREEN.cutoutWidth) / 2;

const $ = (s) => document.querySelector(s);
const pillHost = $("#pill"), notchHost = $("#notch"), ntHost = $("#nt"),
      panelHost = $("#panel"), docEl = $("#doc"), keysEl = $("#keys");

const S = {
  pill: { phase: "hidden" },
  notch: "idle",
  notchModel: { working: 0, attention: 0, hasNotch: true },
  hovering: false,
  expanded: null,
  pocket: null,
  nt: null,
  held: null,
  busy: false,
};

/* ── A bus, so the tour can wait for what actually happened ───────────────── */
const listeners = new Set();
const emit = (name) => { for (const fn of [...listeners]) fn(name); };
const until = (name) => new Promise((res) => {
  const fn = (n) => { if (n === name) { listeners.delete(fn); res(); } };
  listeners.add(fn);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Rendering ────────────────────────────────────────────────────────────── */

/* The app morphs ONE surface rather than swapping two, and the width is the
   motion you actually see. A re-created element loses that, so the new one
   starts at the old one's width and travels — Theme.surfaceTransitionDuration
   on the ease SwiftUI's .easeInOut resolves to. */
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
   click about to happen. It is also the only way the width and the shape
   actually travel. */
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
  S.notchModel.pocket = S.pocket
    ? { waiting: S.pocket.slots.filter((x) => x.demanding).length,
        isOpen: S.expanded === "pocket", slots: S.pocket.slots }
    : null;
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

const drawNotetaker = () => { ntHost.innerHTML = S.nt ? renderNotetaker(S.nt) : ""; };

/* ── The document ─────────────────────────────────────────────────────────── */
const SHOT = `<span class="shot"><i></i>Screenshot</span>`;
const DOC = { paras: [], live: "" };
function drawDoc() {
  docEl.innerHTML =
    `<h1>Notes</h1>` +
    (DOC.paras.length || DOC.live
      ? DOC.paras.map((p) => `<p>${p}</p>`).join("") +
        (DOC.live ? `<p class="landing">${DOC.live}<span class="caret" data-live></span></p>` : "")
      : `<p class="placeholder">Press <b>Fn</b> and say something.<span class="caret"></span></p>`);
  docEl.scrollTop = docEl.scrollHeight;
}

/* ── Dictation ────────────────────────────────────────────────────────────
   The waveform runs on the app's own LevelMeter and DotWave; only the raw
   level differs, and it is generated from the sentence's own rhythm — so a
   flat row still means silence and the shape belongs to the words landing.
   ------------------------------------------------------------------------- */
let dictation = null, waveRaf = null, envelope = 0;

function startDictation({ kind, text, onLand, shotAt = -1, keyId }) {
  const script = speak(text);
  dictation = { script, started: performance.now(), kind, onLand, landed: 0,
                shotAt, shotDone: shotAt < 0, keyId, open: true };
  S.pill = kind === "remote"
    ? { phase: "recording", kind: "remote", agent: "Claude Code", model: "Opus 4.6",
        agentConnected: true,
        agentOptions: [{ id: "claude", label: "Claude Code", terminal: true },
                       { id: "codex", label: "Codex CLI", terminal: true }],
        modelOptions: [{ id: "opus", label: "Opus 4.6" }],
        level: 0, elapsed: 0, maxSeconds: 300 }
    : { phase: "recording", kind, level: 0, elapsed: 0, maxSeconds: 300 };
  drawPill();
  emit("dict:start");
  tickWave();
}

function tickWave() {
  cancelAnimationFrame(waveRaf);
  const step = () => {
    if (!dictation) { envelope = 0; return; }
    const ms = performance.now() - dictation.started;
    envelope = LevelMeter.advance(envelope, LevelMeter.target(dictation.script.levelAt(ms)));

    const row = pillHost.querySelector("[data-wave]");
    if (row) {
      const t = performance.now() / 1000;
      const travel = 16 / 2 - 3.5 / 2;
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
      if (!dictation.shotDone && dictation.landed === dictation.shotAt) {
        // The attachment joins the sentence where you grabbed it, and travels
        // with the words rather than as a second, separate thing.
        DOC.live += " " + SHOT;
        dictation.shotDone = true;
      }
      DOC.live = (DOC.live ? DOC.live + " " : "") + words[dictation.landed].text;
      dictation.landed++;
      if (dictation.kind !== "remote") drawDoc();
    }
    // The line is over and nobody stopped it: let it stand until they do.
    waveRaf = requestAnimationFrame(step);
  };
  waveRaf = requestAnimationFrame(step);
}

async function finishDictation() {
  if (!dictation) return;
  const d = dictation;
  dictation = null;
  cancelAnimationFrame(waveRaf);
  keysEl.querySelector(`[data-key="${d.keyId}"]`)?.removeAttribute("data-held");

  S.pill = { phase: "processing", kind: d.kind, showDiscardHint: true };
  drawPill();
  await sleep(700);
  await d.onLand?.(d);
}

/* ── The lines, and what happens when they land ───────────────────────────── */
const LINE_DICT = "Here is the crash I keep hitting when the session reconnects, and the fix I think we need.";
const LINE_REMOTE = "Tighten the typography scale across the marketing pages and show me what changed.";

async function landDictation() {
  // SILENT SUCCESS. The text is already at the cursor; anything more is the
  // pill talking about itself.
  S.pill = { phase: "output" }; drawPill();
  DOC.paras.push(DOC.live); DOC.live = ""; drawDoc();
  emit("dict:landed");
  await sleep(1000);
  S.pill = { phase: "hidden" }; drawPill();
}

async function landFormat() {
  S.pill = { phase: "output" }; drawPill();
  DOC.live = "";
  DOC.paras[DOC.paras.length - 1] =
    `The session drops on reconnect. ${SHOT} The fix is to re-key the socket before the retry, not after.`;
  drawDoc();
  emit("format:landed");
  await sleep(1000);
  S.pill = { phase: "hidden" }; drawPill();
}

/* A task, said out loud, becomes a real session — and then waits in the pocket
   rather than interrupting. */
async function landRemote() {
  DOC.live = "";
  S.pill = { phase: "hidden" }; drawPill();

  S.notchModel = { ...S.notchModel, capturePhase: "routing" };
  drawNotch();
  await sleep(1100);

  S.notchModel = { working: 1, attention: 0, hasNotch: true,
    task: { status: "processing", title: "Tighten the typography scale",
            activity: "Reading the type ramp" } };
  S.notch = "active"; drawNotch();
  await sleep(2400);

  S.notchModel = { working: 0, attention: 0, hasNotch: true };
  S.pocket = { at: 0, slots: POCKET_SLOTS };
  S.notch = "idle"; drawNotch();
  emit("remote:landed");
}

const POCKET_SLOTS = [
  { id: "p1", title: "Tighten the typography scale", backend: "claude", terminal: true,
    status: "needs-user", demanding: true,
    ask: "Apply the new scale to the whole site, or only the marketing pages?" },
  { id: "p2", title: "Reconnect crash", backend: "codex", terminal: true,
    status: "ready", demanding: true,
    ask: "Re-keyed the socket before the retry. Want the diff?" },
  { id: "p3", title: "Notch geometry audit", backend: "codex", terminal: true,
    status: "done", demanding: false,
    ask: "Every radius now derives from the measured bar." },
];

/* ── Expanding ────────────────────────────────────────────────────────────── */
const TASK = {
  status: "needs-user", title: "Tighten the typography scale",
  backend: "claude", hasTerminal: true, alive: true, kind: "session",
  elapsed: "4m", modelLabel: "opus", isOwned: true,
};
const ROWS = [
  { kind: "user", text: LINE_REMOTE },
  { kind: "work", durationMs: 38000, steps: [
    { title: "Read the type ramp", ms: 640, ok: true },
    { title: "Apply the scale to /pricing", ms: 2100, ok: true },
    { title: "Diff the marketing templates", ms: 1450, ok: true },
  ] },
  { kind: "answer", text: "The ramp is in `tokens.css` and four pages import it. **Two of them are marketing**; the other two are the app shell, where the scale is tied to the native type sizes.\n\nApply the new scale to the whole site, or only the marketing pages?" },
];

const WALL = {
  view: "today", workspace: "All workspaces", columns: 2, surfaceFill: 0.77, doorbell: true,
  groups: [
    { name: "unmute marketing", cards: [
      { id: "a", status: "needs-user", title: "Tighten the typography scale",
        activity: "Apply the new scale to the whole site, or only the marketing pages?",
        backend: "claude", kind: "session", dir: "~/site", age: "4m", qpos: 1 },
      { id: "b", status: "ready", title: "Reconnect crash",
        activity: "Re-keyed the socket before the retry. Want the diff?",
        backend: "codex", kind: "session", dir: "~/engine", age: "9m" } ] },
    { name: "engine", cards: [
      { id: "c", status: "processing", title: "Parakeet warm-start",
        activity: "Profiling the first-token path", backend: "codex", kind: "session",
        dir: "~/engine", age: "12m" },
      { id: "d", status: "done", title: "Notch geometry audit",
        activity: "Every radius now derives from the measured bar.",
        backend: "codex", kind: "oneoff", age: "3h" } ] },
  ],
  queue: [{ id: "a", status: "needs-user", name: "Tighten the typography scale" }],
  oneoffs: [{ id: "d", status: "done", name: "Notch geometry audit", age: "3h" }],
  shelf: [{ id: "f", name: "Provider mark optical scale" }],
};

function openPanel(kind) {
  S.expanded = kind;
  if (kind === "pocket") {
    const slot = S.pocket.slots[S.pocket.at ?? 0];
    const p = { ...slot, slots: S.pocket.slots.length, at: S.pocket.at ?? 0 };
    panelHost.innerHTML = panel(renderPocket(p, true), {
      width: 348, height: 34 + 6 + (p.ask ? 103 : 65) + 6,
      pocket: true, shoulders: pocketShoulders(p, SCREEN.cutoutWidth),
    });
    panelHost.dataset.open = "true";
    drawNotch(); emit("pocket:open");
    return;
  }
  const width = kind === "cockpit" ? 1180 : 900;
  const height = kind === "cockpit" ? 760 : 620;
  panelHost.innerHTML = panel(
    kind === "cockpit" ? renderWall(WALL)
      : renderTaskSurface({ task: TASK, rows: ROWS, attention: 1, surfaceFill: 0.77 }),
    { width, height });
  if (kind === "task") {
    panelHost.querySelector(".u-composer")?.insertAdjacentHTML("beforebegin",
      `<div class="answer-chips">
         <button type="button" class="u-act-btn" data-answer="Whole site">Whole site</button>
         <button type="button" class="u-key-btn" data-answer="Marketing only">Marketing only</button>
       </div>`);
  }
  panelHost.dataset.open = "true";
  S.notch = kind === "cockpit" ? "cockpit" : "task";
  drawNotch();
  emit(kind === "cockpit" ? "cockpit:open" : "task:open");
}

function closePanel() {
  S.expanded = null;
  panelHost.dataset.open = "false";
  panelHost.innerHTML = "";
  S.notch = S.notchModel.attention ? "attention" : "idle";
  drawNotch();
  emit("panel:closed");
}

function onNotchClick() {
  if (S.expanded) return;
  if (S.notch === "attention") openPanel("task");
  else if (S.pocket?.slots.some((x) => x.demanding)) openPanel("pocket");
  else openPanel("cockpit");
}

/* ── The meeting notetaker ────────────────────────────────────────────────── */
let lctrlAt = 0, ntRaf = null;
const ntLevels = new Array(14).fill(0);

function pressLeftCtrl() {
  const now = performance.now();
  // Left ⌃ TWICE. One press is nothing: stop is never a single, direct action,
  // and neither is start.
  if (now - lctrlAt > 700) { lctrlAt = now; emit("nt:armed"); return; }
  lctrlAt = 0;
  if (!S.nt) { S.nt = "idle"; drawNotetaker(); driveNtBars(); emit("nt:start"); }
  else { endMeeting(); }
}

async function endMeeting() {
  S.nt = "completed"; drawNotetaker();
  cancelAnimationFrame(ntRaf);
  emit("nt:saved");
  await sleep(1900);
  S.nt = null; drawNotetaker();
}

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
        ntLevels[i] += (Math.min(1, gated) - ntLevels[i]) * (gated > ntLevels[i] ? 0.28 : 0.07);
        const h = Math.round(ntLevels[i] * 20);
        row.children[i].style.height = (h < 2 ? 0 : h) + "px";
        row.children[i].style.opacity = (0.55 + 0.45 * ntLevels[i]).toFixed(3);
      }
    }
    ntRaf = requestAnimationFrame(step);
  };
  ntRaf = requestAnimationFrame(step);
}

/* ── The keys ─────────────────────────────────────────────────────────────── */
const KEYS = {
  fn: {
    code: "KeyF", cap: "Fn", what: "dictate",
    press() {
      // PRESS TO START, PRESS AGAIN TO FINISH — and holding works too.
      if (dictation) { finishDictation(); return; }
      DOC.live = "";
      startDictation({ kind: "dictation", text: LINE_DICT, onLand: landDictation,
                       shotAt: 11, keyId: "fn" });
    },
    release() { if (dictation && performance.now() - dictation.started > 380) finishDictation(); },
  },
  caps: {
    code: "CapsLock", cap: "⇪", what: "reformat",
    press() {
      if (dictation) { finishDictation(); return; }
      startDictation({ kind: "instruction", text: "tighten that and keep the screenshot",
                       onLand: landFormat, keyId: "caps" });
    },
  },
  ropt: {
    code: "AltRight", cap: "right ⌥", what: "hand off",
    press() {
      if (dictation) { finishDictation(); return; }
      // With something already holding, right ⌥ aims at the pocket rather than
      // starting a new task — your voice goes to the card you can see.
      if (S.pocket?.slots.some((x) => x.demanding) && !S.expanded) { openPanel("pocket"); return; }
      startDictation({ kind: "remote", text: LINE_REMOTE, onLand: landRemote, keyId: "ropt" });
    },
    release() { if (dictation && performance.now() - dictation.started > 380) finishDictation(); },
  },
  lctrl: { code: "ControlLeft", cap: "left ⌃ ×2", what: "meeting", press: pressLeftCtrl },
  esc: { code: "Escape", cap: "esc", what: "put away", press() { if (S.expanded) closePanel(); } },
  cmdopt: {
    code: null, cap: "⌘⌥", what: "bring it back",
    press() { if (!S.expanded) openPanel("cockpit"); },
  },
};

keysEl.innerHTML = Object.entries(KEYS).map(([id, k]) =>
  `<button type="button" class="keycap" data-key="${id}">
     <span class="keycap-key">${k.cap}</span>
     <span class="keycap-what">${k.what}</span>
   </button>`).join("");

function fire(id) {
  const k = KEYS[id];
  if (!k) return;
  const cap = keysEl.querySelector(`[data-key="${id}"]`);
  cap?.setAttribute("data-held", "");
  if (!k.release) setTimeout(() => cap?.removeAttribute("data-held"), 160);
  S.held = k.release ? id : null;
  k.press();
}

keysEl.addEventListener("pointerdown", (e) => {
  const cap = e.target.closest(".keycap");
  if (cap) { e.preventDefault(); fire(cap.dataset.key); }
});
window.addEventListener("pointerup", () => {
  if (!S.held) return;
  const id = S.held; S.held = null;
  keysEl.querySelector(`[data-key="${id}"]`)?.removeAttribute("data-held");
  KEYS[id].release?.();
});

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.metaKey && e.altKey && !e.ctrlKey) { e.preventDefault(); fire("cmdopt"); return; }
  const id = Object.keys(KEYS).find((k) => KEYS[k].code === e.code);
  if (id) { e.preventDefault(); fire(id); }
});
window.addEventListener("keyup", (e) => {
  const id = Object.keys(KEYS).find((k) => KEYS[k].code === e.code);
  if (id && S.held === id) {
    S.held = null;
    keysEl.querySelector(`[data-key="${id}"]`)?.removeAttribute("data-held");
    KEYS[id].release?.();
  }
});

/* ── Clicks inside the surfaces ───────────────────────────────────────────── */
document.addEventListener("click", async (e) => {
  const answer = e.target.closest("[data-answer]");
  if (answer) {
    closePanel();
    S.pocket.slots = S.pocket.slots.filter((x) => x.id !== "p1");
    S.notchModel = { working: 1, attention: 0, hasNotch: true,
      task: { status: "processing", title: "Tighten the typography scale",
              activity: answer.dataset.answer === "Whole site" ? "Applying to 4 pages" : "Applying to 2 pages" } };
    S.notch = "active"; drawNotch();
    emit("answered");
    await sleep(2600);
    S.notchModel = { working: 0, attention: 0, hasNotch: true };
    S.notch = "idle"; drawNotch();
    return;
  }
  if (e.target.closest('.u-round-btn[aria-label="Close"]')) { closePanel(); return; }

  if (S.expanded === "pocket") {
    const pip = e.target.closest(".u-pocket-pip");
    if (pip) {
      S.pocket.at = [...pip.parentElement.children].indexOf(pip);
      openPanel("pocket"); return;
    }
    if (e.target.closest('.u-pocket-shoulders .u-round-btn[title^="Open the dashboard"]')) {
      panelHost.dataset.open = "false"; openPanel("cockpit"); return;
    }
    if (e.target.closest('.u-pocket-shoulders .u-round-btn[title^="Close"]')) { closePanel(); return; }
    if (e.target.closest(".u-pocket")) { panelHost.dataset.open = "false"; openPanel("task"); return; }
  }
  if (e.target.closest(".u-quiet-btn") && e.target.textContent.includes("Open dashboard")) {
    panelHost.dataset.open = "false"; openPanel("cockpit"); return;
  }
  const card = e.target.closest(".u-card");
  if (card && S.expanded === "cockpit") { panelHost.dataset.open = "false"; openPanel("task"); return; }

  const nt = e.target.closest(".u-nt");
  const act = e.target.closest("[data-action]");
  if (nt && !act && S.nt === "idle") { S.nt = "discard"; drawNotetaker(); return; }
  if (act && ntHost.contains(act)) {
    const a = act.dataset.action;
    if (a === "keep") { S.nt = "idle"; drawNotetaker(); driveNtBars(); }
    if (a === "discard") { S.nt = null; drawNotetaker(); cancelAnimationFrame(ntRaf); }
    if (a === "end") endMeeting();
  }
});

/* ── The tour ─────────────────────────────────────────────────────────────
   Guided, and it waits for what actually happened rather than for a timer.
   ------------------------------------------------------------------------- */
const TOUR = [
  { key: "fn", wait: "dict:start",
    say: "Press <b>Fn</b> to start listening.",
    why: "On your Mac that is the key beside ⌃. macOS never reports it to a browser, so here it is <b>F</b> — or click the cap." },
  { key: "fn", wait: "dict:landed",
    say: "Say your piece, then press <b>Fn</b> again to finish.",
    why: "Watch the screenshot join the sentence half-way through — it travels with the words and lands in the same paste." },
  { key: "caps", wait: "format:landed",
    say: "Press <b>⇪ Caps Lock</b> to have it rewrite that instead.",
    why: "Same voice, but the words are an instruction rather than the text. The capsule takes indigo — the one hue nothing else here uses." },
  { key: "ropt", wait: "remote:landed",
    say: "Now hold <b>right ⌥</b> and hand some work off.",
    why: "The glyph replaces the dot because this is a lane, not a recording state: these words go to a Claude Code session, on your own plan, not to your cursor." },
  { key: "ropt", wait: "pocket:open",
    say: "It is waiting in your pocket. Press <b>right ⌥</b> again to open it.",
    why: "The closed surface counts only what is waiting on you — never everything it holds." },
  { key: null, wait: "task:open",
    say: "Click the card to open the task.",
    why: "The pocket hands over to the whole surface. Same shape, more of it." },
  { key: null, wait: "cockpit:open",
    say: "Click <b>Open dashboard</b>, at the bottom left of the panel.",
    why: "Every task at once — the Orchestrator. A card that needs you carries a whisper of its own status hue." },
  { key: "esc", wait: "panel:closed",
    say: "Press <b>esc</b> to put it away.",
    why: "It collapses back into the notch it grew out of. One surface, not two." },
  { key: "cmdopt", wait: "cockpit:open",
    say: "Press <b>⌘⌥</b> to bring it straight back.",
    why: "You never had to find a window, because there was never a window to find." },
  { key: "lctrl", wait: "nt:start",
    say: "Press <b>left ⌃</b> twice to start taking meeting notes.",
    why: "One press is nothing. The widget sits bottom-left, its baseline level with the pill's." },
  { key: "lctrl", wait: "nt:saved",
    say: "Press <b>left ⌃</b> twice again to end it.",
    why: "Or click the widget for End and Discard. Stop is never a single, direct action." },
];

const stepEl = $("#guide-step"), sayEl = $("#guide-say"), whyEl = $("#guide-why"),
      dotsEl = $("#guide-dots");
dotsEl.innerHTML = TOUR.map(() => "<i></i>").join("");

function showStep(i) {
  const s = TOUR[i];
  stepEl.textContent = `Step ${i + 1} of ${TOUR.length}`;
  sayEl.innerHTML = s.say;
  whyEl.innerHTML = s.why;
  [...dotsEl.children].forEach((d, n) => {
    d.toggleAttribute("data-done", n < i);
    d.toggleAttribute("data-now", n === i);
  });
  keysEl.querySelectorAll(".keycap").forEach((cap) => {
    cap.toggleAttribute("data-next", cap.dataset.key === s.key);
    cap.toggleAttribute("data-idle", !!s.key && cap.dataset.key !== s.key);
  });
}

async function runTour() {
  for (let i = 0; i < TOUR.length; i++) {
    showStep(i);
    await until(TOUR[i].wait);
    await sleep(320);
  }
  stepEl.textContent = "That is the whole thing";
  sayEl.innerHTML = "You just used Unmute without installing it.";
  whyEl.innerHTML = "Everything above is the real interface, rebuilt in the browser from the app's own source — the same shape, the same radii, the same 240ms morph. Carry on pressing keys; nothing resets.";
  [...dotsEl.children].forEach((d) => { d.setAttribute("data-done", ""); d.removeAttribute("data-now"); });
  keysEl.querySelectorAll(".keycap").forEach((c) => {
    c.removeAttribute("data-next"); c.removeAttribute("data-idle");
  });
}

/* ── Fit ──────────────────────────────────────────────────────────────────── */
function fit() {
  const m = document.querySelector(".machine");
  const w = m.offsetWidth || 1536, h = m.offsetHeight || 1007;
  // The guide is fixed, so the machine only has to clear it — not the whole
  // block of prose that used to sit under it.
  const k = Math.min((innerWidth - 44) / w, (innerHeight - 150) / h, 1.15);
  document.querySelector(".machine-fit").style.setProperty("--k", k.toFixed(4));
  // The scaled element still occupies its unscaled box in layout, so the slot
  // reserves what the SCALED machine actually needs.
  $("#slot").style.setProperty("--slot-h", Math.ceil(h * k) + "px");
}
addEventListener("resize", fit);

/* ── Go ───────────────────────────────────────────────────────────────────── */
drawDoc(); mountNotch(); drawNotch(); drawPill(); fit(); runTour();
