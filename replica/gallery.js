/* Builds the specimen gallery. Each entry names the state it draws and the
   rule from the source that decides how it looks. */
import { renderPill, driveWaveforms, OFFLINE } from "./pill.js";
import { renderNotetaker, driveNotetaker } from "./notetaker.js";
import { renderNotch } from "./notch.js";

const CLAUDE_AGENTS = [
  { id: "claude", label: "Claude Code", terminal: true },
  { id: "codex", label: "Codex CLI", terminal: true },
  { id: "codex-desktop", label: "Codex desktop", terminal: false },
];
const CLAUDE_MODELS = [
  { id: "opus", label: "Opus 4.6" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
];
const CODEX_AXES = [
  { axis: "Model", values: ["5.6 Terra", "5.6", "5.3"], current: "5.6 Terra" },
  { axis: "Effort", values: ["Low", "Medium", "High", "Extra High"], current: "Extra High" },
  { axis: "Speed", values: ["Standard", "Priority"], current: "Priority" },
];
const REMOTE = {
  kind: "remote", agent: "Claude Code", model: "Opus 4.6",
  agentOptions: CLAUDE_AGENTS, modelOptions: CLAUDE_MODELS, agentConnected: true,
};

function specimen(name, why, html, stageClass = "on-desk") {
  return `<div class="specimen">
    <div class="meta"><div class="name">${name}</div><div class="why">${why}</div></div>
    <div class="stage ${stageClass}">${html}</div></div>`;
}

/* ── 1 · Every phase ─────────────────────────────────────────────────────── */
const phases = [
  ["hidden", "Nothing is drawn at all — <code>EmptyView()</code>.",
    { phase: "hidden" }],
  ["recording", "The waveform, and nothing else at rest. No dot, no stop button: the trigger key already stops.",
    { phase: "recording", level: 0.16 }],
  ["paused", "Stopped with the scratchpad armed. Amber dot; the same key resumes the same dictation.",
    { phase: "paused" }],
  ["processing", "The one resting state that carries a word. Breathing dot, then three bouncing dots.",
    { phase: "processing" }],
  ["output", "Silent success. A green tick in a square frame — anything more is the pill talking about itself.",
    { phase: "output" }],
  ["output-fallback", "Pasted, but formatting was unavailable. Tinted orange, and it echoes what landed.",
    { phase: "output-fallback", outputPreview: "the new direction feels right" }],
  ["too-short", "Nothing captured. No API call was made.",
    { phase: "too-short" }],
  ["cancelled", "Discarded by the user — and this is where Undo lives.",
    { phase: "cancelled" }],
  ["error", "Tinted red, with the retry route underneath.",
    { phase: "error", message: "Transcription failed" }],
];
document.getElementById("phases").innerHTML = phases
  .map(([n, w, s]) => specimen(n, w, renderPill(s) || '<span class="hint-note">(nothing on screen)</span>'))
  .join("");

/* ── 2 · The three kinds ─────────────────────────────────────────────────── */
document.getElementById("kinds").innerHTML = [
  ["dictation", "Untitled and untinted: the plain white rim.",
    { phase: "recording", kind: "dictation", level: 0.2 }],
  ["instruction — Caps Lock", "Indigo, because red is an error and this mode runs many times a day.",
    { phase: "recording", kind: "instruction", level: 0.2 }],
  ["remote", "The remote glyph replaces the dot, and the agent control rides beside it.",
    { phase: "recording", ...REMOTE, level: 0.2 }],
  ["recording — last 15s", "The waveform gives way to a countdown: there, seconds remaining IS the information.",
    { phase: "recording", elapsed: 292, maxSeconds: 300 }],
  ["recording — Remote, iPhone mic + armed pad", "Every chip the cluster can carry at once.",
    { phase: "recording", ...REMOTE, level: 0.3, mic: "iphone-arpit",
      micOptions: [{ id: "mac", label: "MacBook Pro" }, { id: "iphone-arpit", label: "iPhone" }],
      scratchpadEnabled: true, armed: true }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 3 · Processing ──────────────────────────────────────────────────────── */
document.getElementById("processing").innerHTML = [
  ["plain", "No affordance earned yet.", { phase: "processing" }],
  ["+ discard hint", "Shown only when the hint is earned.", { phase: "processing", showDiscardHint: true }],
  ["+ engine notice", "Label becomes “On-device”, and the trailing text says so twice over.",
    { phase: "processing", engineNotice: true }],
  ["+ draft offer", "Label becomes “Taking longer…”, and the one action outranks both notices.",
    { phase: "processing", draftOffer: true }],
  ["instruction lane", "Still tinted while the capture is live.",
    { phase: "processing", kind: "instruction", showDiscardHint: true }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 4 · Terminal states ─────────────────────────────────────────────────── */
document.getElementById("terminal").innerHTML = [
  ["too-short, default", "“Didn't catch that”.", { phase: "too-short" }],
  ["too-short, muted", "The engine may send its own words.",
    { phase: "too-short", mutedText: "Muted — nothing was captured" }],
  ["output-fallback, no preview", "The message alone when nothing is echoed.",
    { phase: "output-fallback" }],
  ["error, generic", "Two lines: what happened, then how to retry.",
    { phase: "error", message: "Something went wrong" }],
  ["error, limit reached", "The retry line is suppressed — retrying will not help.",
    { phase: "error", message: "Monthly limit reached" }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 5 · Agent control ───────────────────────────────────────────────────── */
document.getElementById("agent").innerHTML = [
  ["Claude Code, connected", "Mark at full strength, model beside it, chevron closed.",
    { phase: "recording", ...REMOTE, level: 0.1 }],
  ["Codex CLI, axes", "The chip shows the picked model; the axes summarise inside the panel.",
    { phase: "recording", kind: "remote", agent: "Codex CLI", model: "5.6 Terra",
      agentOptions: CLAUDE_AGENTS, modelAxes: CODEX_AXES, level: 0.1 }],
  ["not reachable", "The mark fades to 0.45 and the label says “· connect”.",
    { phase: "recording", ...REMOTE, agentConnected: false, level: 0.1 }],
  ["Codex desktop — no terminal", "The terminal glyph is a capability, not a name.",
    { phase: "recording", kind: "remote", agent: "Codex desktop", model: "5.6",
      agentOptions: CLAUDE_AGENTS, modelOptions: CLAUDE_MODELS, level: 0.1 }],
  ["the Agent lane", "Nothing to choose, so: teal, no chevron, and not a button.",
    { phase: "recording", kind: "remote", agent: "Unmute Agent",
      agentOptions: [], modelOptions: [], level: 0.1 }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 6 · Selector panel ──────────────────────────────────────────────────── */
document.getElementById("selector").innerHTML = [
  ["a flat list — Claude", "Agent column, then the catalog.",
    { phase: "recording", ...REMOTE, selectorOpen: true, level: 0.1 }],
  ["axes — Codex", "Model · Effort · Speed, all visible at once.",
    { phase: "recording", kind: "remote", agent: "Codex CLI",
      agentOptions: CLAUDE_AGENTS, modelAxes: CODEX_AXES, selectorOpen: true, level: 0.1 }],
  ["nothing to choose", "An honest empty state, in the engine's own words.",
    { phase: "recording", kind: "remote", agent: "Codex CLI", agentOptions: CLAUDE_AGENTS,
      modelOptions: [], modelEmpty: "Open Codex to choose a model", selectorOpen: true, level: 0.1 }],
  ["addressed to a task", "The Agent column is dropped: the lane is already decided.",
    { phase: "recording", ...REMOTE, taskId: "t-41", selectorOpen: true, level: 0.1 }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 7 · Chips ───────────────────────────────────────────────────────────── */
const MICS = [{ id: "mac", label: "MacBook Pro" }, { id: "iphone-arpit", label: "iPhone" }];
document.getElementById("chips").innerHTML = [
  ["mic — Mac", "Tap to hand over to the iPhone.",
    { phase: "recording", mic: "mac", micOptions: MICS, level: 0.1 }],
  ["mic — iPhone", "Teal, because the capture has moved off this machine.",
    { phase: "recording", mic: "iphone-arpit", micOptions: MICS, level: 0.1 }],
  ["scratchpad — off", "Unmute's own glyph: a ruled page with a pen laid across it.",
    { phase: "recording", scratchpadEnabled: true, armed: false, level: 0.1 }],
  ["scratchpad — armed", "Stopping now holds the work on the pad instead of delivering it.",
    { phase: "recording", scratchpadEnabled: true, armed: true, level: 0.1 }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 8 · Hints ───────────────────────────────────────────────────────────── */
document.getElementById("hints").innerHTML = [
  ["mic narration", "Orange, and it outranks both others: it describes something that just changed.",
    { phase: "recording", micStatus: "Switching to iPhone — from the next dictation", level: 0.1 }],
  ["coaching — quiet", "Blue, with the mic glyph.",
    { phase: "recording", coaching: { condition: "Very quiet", remedy: "move a little closer", level: "quiet" }, level: 0.04 }],
  ["coaching — noise", "Amber, with the waveform glyph. Noise wins over quiet.",
    { phase: "recording", coaching: { condition: "Noisy room", remedy: "we may miss words", level: "warn" }, level: 0.4 }],
].map(([n, w, s]) => specimen(n, w, renderPill(s))).join("");

/* ── 9 · Offline card ────────────────────────────────────────────────────── */
document.getElementById("offline").innerHTML = Object.keys(OFFLINE)
  .map((reason) => specimen(
    reason.replace(/_/g, " "),
    OFFLINE[reason].recoverable
      ? "Recoverable — so it takes the tint and the one control that fixes it."
      : "Stated, dismissible, untinted.",
    renderPill({ phase: "recording", offline: reason, level: 0.1 })))
  .join("");

/* ── 10 · Notetaker ──────────────────────────────────────────────────────── */
document.getElementById("notetaker").innerHTML = [
  ["recording", "A pulsing red dot and fourteen bars in 55pt. Silence is a line, not a row of dots.", "idle"],
  ["actions open", "Two zones in one shape — stop is never a single, direct action.", "discard"],
  ["saved", "The rim and the contents say “saved”; the fill never changes.", "completed"],
].map(([n, w, s]) => specimen(n, w, renderNotetaker(s))).join("");

/* ── 11 · Light desktop ──────────────────────────────────────────────────── */
document.getElementById("light").innerHTML = [
  specimen("recording", "The rim holds against a bright ground.",
    renderPill({ phase: "recording", ...REMOTE, level: 0.25 }), "on-desk on-light"),
  specimen("formatter", "The tinted rim is the mode marker, at full presence.",
    renderPill({ phase: "recording", kind: "instruction", level: 0.25 }), "on-desk on-light"),
  specimen("notetaker", "Same black, same rule.",
    renderNotetaker("idle"), "on-desk on-light"),
].join("");

/* ── Live behaviour ──────────────────────────────────────────────────────── */

/* A stand-in for the mic. The engine sends min(1, rms × 4) every 70ms and
   speech lands around 0.08–0.16, so this drives the envelope through the same
   range the real signal occupies rather than through a full-scale sweep. */
const speech = (seed) => {
  const t = performance.now() / 1000 + seed;
  const syllable = Math.max(0, Math.sin(t * 3.4) * 0.5 + 0.5) ** 1.6;
  const phrase = Math.max(0, Math.sin(t * 0.42 + seed) * 0.5 + 0.62);
  return Math.min(1, 0.02 + syllable * phrase * 0.28);
};
const seeds = new WeakMap();
let n = 0;
const seedOf = (el) => {
  if (!seeds.has(el)) seeds.set(el, (n++ % 7) * 1.7);
  return seeds.get(el);
};

/* Each specimen carries its own declared level so the still ones stay still —
   a row that wobbles regardless would look like proof of something it is not
   checking. Only the ones asked to be live are driven. */
driveWaveforms(document.body, (row) => {
  const pill = row.closest(".u-pill");
  return pill?.dataset.phase === "recording" ? speech(seedOf(row)) : 0;
});
driveNotetaker(document.body, (row, i) => {
  const t = performance.now() / 1000 + i * 0.09;
  return Math.max(0, 0.06 + Math.sin(t * 2.6 + i * 0.7) * 0.16 + Math.sin(t * 0.5) * 0.08);
});

/* Interactions the real surfaces have. */
document.body.addEventListener("click", (e) => {
  const nt = e.target.closest(".u-nt");
  const act = e.target.closest("[data-action]");

  // The notetaker: tapping the recording pill opens the actions in place.
  if (nt && !act && nt.dataset.state === "idle") {
    nt.outerHTML = renderNotetaker("discard");
    return;
  }
  if (!act) return;
  const action = act.dataset.action;

  if (action === "keep") { act.closest(".u-nt").outerHTML = renderNotetaker("idle"); return; }
  if (action === "end")  { act.closest(".u-nt").outerHTML = renderNotetaker("completed"); return; }
  if (action === "discard") { act.closest(".u-nt").outerHTML = renderNotetaker("idle"); return; }

  // The agent control toggles its panel; the chips toggle in place.
  if (action === "toggleSelector") {
    act.setAttribute("aria-expanded", act.getAttribute("aria-expanded") !== "true");
    return;
  }
  if (action === "toggleArm") {
    act.dataset.on = act.dataset.on !== "true";
    return;
  }
  if (action === "pickMic") {
    const on = act.dataset.on !== "true";
    act.dataset.on = on;
    act.title = on ? "Capturing from iPhone — tap for the Mac mic"
                   : "Capturing from the Mac — tap for iPhone";
    return;
  }
  // A selector row: exactly one on per column.
  if (action === "pick") {
    const col = act.closest(".u-selector-col");
    col.querySelectorAll(".u-selector-row").forEach((r) =>
      r.setAttribute("aria-selected", r === act));
  }
});

document.body.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const nt = e.target.closest?.(".u-nt");
  if (nt && nt.dataset.state === "idle") { e.preventDefault(); nt.outerHTML = renderNotetaker("discard"); }
});

/* ── 12 / 13 · The notch ──────────────────────────────────────────────────── */

/* The four numbers macOS reports, for the machine each stage is drawing. */
const STAGE_W = 720;
const MACHINES = {
  mbp14:    { barHeight: 34, cutoutWidth: 200 },
  air13:    { barHeight: 32, cutoutWidth: 168 },
  external: { barHeight: 24, cutoutWidth: 0 },
};
function screenFor(key) {
  const m = MACHINES[key];
  const usable = (STAGE_W - m.cutoutWidth) / 2;
  return { ...m, width: STAGE_W, leftUsable: usable, rightUsable: usable, hasNotch: m.cutoutWidth > 0 };
}

function stage(model, state, hovering, machine = "mbp14", light = false) {
  const scr = screenFor(machine);
  return `<div class="u-notch-stage" data-machine="${machine}" style="width:${STAGE_W}px">
    <div class="u-desk" ${light ? "data-light" : ""}>
      <div class="u-menubar">
        <span class="u-menubar-left"><b>Unmute</b><span>File</span><span>Edit</span><span>View</span></span>
        <span class="u-menubar-right"><span>100%</span><span>Thu 12:04</span></span>
      </div>
      ${scr.hasNotch ? '<div class="u-cutout"></div>' : ""}
      ${renderNotch({ ...model, hasNotch: scr.hasNotch }, state, hovering, scr)}
    </div></div>`;
}

const TASK_RUN = { status: "processing", title: "Rewrite the onboarding copy", activity: "Editing three files" };
const TASK_ASK = { status: "needs-user", title: "Ship the pricing change",
  question: { text: "Replace the annual price everywhere, or only on /pricing?" } };

document.getElementById("notch").innerHTML = [
  ["dormant", "Nothing. Not a hairline, not a sliver — an always-visible idle indicator stops being an indicator. On a notched Mac the window IS the cutout, so the black adds no pixel you can see while keeping a target the pointer can find.",
    stage({}, "dormant")],
  ["idle", "The identity is the mark, not the word. On a notched display it reads as the notch saying something rather than as a badge on the desktop.",
    stage({ working: 0 }, "idle")],
  ["active", "One word for one state. The count moves to the badge; the right half carries what is actually happening.",
    stage({ working: 1, task: TASK_RUN }, "active")],
  ["active, several", "The badge is “and N more like this”, and it is only ever drawn above 1. With more than one running there is no single activity to name, so the right half is empty.",
    stage({ working: 4 }, "active")],
  ["attention", "The one state that glows: the status hue takes the label and the badge, and the right half carries the question itself, in full ink rather than dim.",
    stage({ attention: 2, task: TASK_ASK }, "attention")],
  ["waiting in the pocket", "Ranked above every resting state, because something waiting on you outranks a wordmark. It counts what is <em>waiting</em>, never everything held.",
    stage({ pocket: { waiting: 3, isOpen: false, slots: [{ title: "Ship the pricing change" }] } }, "idle")],
  ["waiting — exactly one", "Singular, because “1 waiting on you” is a sentence and “1 waiting on you” with an s is not.",
    stage({ pocket: { waiting: 1, isOpen: false, slots: [{ title: "Ship the pricing change" }] } }, "idle")],
  ["routing", "Between the pill vanishing and the task existing, the router is deciding where the words go. The surface used to say nothing at all here.",
    stage({ capturePhase: "routing" }, "idle")],
  ["agent — thinking", "Ephemeral Agent progress, deliberately separate from tasks.",
    stage({ agentActivity: { state: "thinking", summary: "Reading last week's meetings" } }, "idle")],
  ["agent — confirming", "Confirming and failed are the two that take the alarm.",
    stage({ agentActivity: { state: "confirming", summary: "Send the note to Priya?" } }, "idle")],
  ["a toast", "Feedback stays visible at the surface where the action began; collapsed errors used to be logged and otherwise disappear.",
    stage({ toast: "the session had already closed" }, "idle")],
].map(([n, w, html]) => specimen(n, w, html, "")).join("");

document.getElementById("notch2").innerHTML = [
  ["idle, off-notch", "No cutout, no landmark — so the surface must stay findable. A nub, not a nameplate: drawn small, hit big, and softened from pure black because there is no hardware here to match.",
    stage({ working: 0 }, "idle", false, "external")],
  ["…hovered", "One more level of detail, and the mass grows to fit it.",
    stage({ working: 0 }, "idle", true, "external")],
  ["active, hovered", "Hovering a running task shows its NAME — the one thing the activity line does not carry.",
    stage({ working: 1, task: TASK_RUN }, "active", true)],
  ["waiting, hovered", "Hovering names the one your voice would reach, which is the only question a bare count raises.",
    stage({ pocket: { waiting: 3, isOpen: false, slots: [{ title: "Ship the pricing change" }] } }, "idle", true)],
  ["13″ Air", "168 × 32, so the fillet and radius derive to 10 as well — the shape scales with the bar rather than looking bolted on.",
    stage({ attention: 2, task: TASK_ASK }, "attention", false, "air13")],
  ["external display", "The menu bar has moved, so the mass is centred on the screen and the two halves sit either side of an 18pt gap instead of the hole.",
    stage({ attention: 2, task: TASK_ASK }, "attention", false, "external")],
  ["over a light desktop", "The mass is opaque black in every bar-level state: the Fixed / Live glass setting does not reach this surface at all.",
    stage({ working: 1, task: TASK_RUN }, "active", false, "mbp14", true)],
].map(([n, w, html]) => specimen(n, w, html, "")).join("");

/* Hover reveals — the mass re-resolves its content and re-measures its width. */
document.querySelectorAll("#notch .u-notch, #notch2 .u-notch").forEach((el) => {
  el.style.transition = "width var(--morph)";
});
