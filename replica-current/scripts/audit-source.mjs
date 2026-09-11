import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const SOURCE_ROOT = "/Users/zodpatel/tools/unmute/unmute-cloud";
export const SOURCE_REVISION = "20dfd8fe5135371b7c4b5178a4124225a2e15662";
const TS_FILES = new Set(["desktop/electron/remote/notch/pill-controller.ts", "desktop/electron/remote/notetakerWidget.ts", "desktop/engine-overrides/renderer/widget/pillBridge.ts"]);
const TS_PREFIX = "desktop/engine-overrides/renderer/notetaker/";
const SYMBOL = /(?:systemName|systemImage|systemSymbolName)\s*:\s*"([^"]+)"/g;
const METRIC = /(?:frame|padding|spacing|cornerRadius|font|opacity|offset|width|height|size|radius|inset|duration|delay|lineLimit|minimumScaleFactor)/i;
const TOKEN = /(?:Color\.|NSColor\.|foregroundStyle|foregroundColor|background|fill\(|stroke\(|Material|material\b|shadow\(|opacity\()/;

async function git(args) {
  return (await execFile("git", ["-C", SOURCE_ROOT, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
}
function occurrence(category, source, line, value, symbol, ordinal = 1, kind) {
  return { id: `${category}:${source}:${line}:${ordinal}`, source, line, symbol, value, ...(kind ? { kind } : {}) };
}
function sourceStatements(text) {
  const lines = text.split("\n");
  const result = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = i;
    let value = lines[i].trim();
    if (/^(?:}\s*)?(?:if|else\s+if|guard)\b/.test(value) && !/[{]|\)\s*(?:return|$)/.test(value)) {
      while (i + 1 < lines.length && !/[{]/.test(value)) value += ` ${lines[++i].trim()}`;
    } else if (/[?&|]$/.test(value) || (/^(?:return\s+)/.test(value) && /^\s*[?:.]/.test(lines[i + 1] ?? ""))) {
      while (i + 1 < lines.length && !/[;]$/.test(value) && !/^}/.test(lines[i + 1].trim())) value += ` ${lines[++i].trim()}`;
    }
    result.push({ line: start + 1, value: value.replace(/\s+/g, " ") });
  }
  return result;
}

export function scanSourceText(source, text, language = source.endsWith(".swift") ? "swift" : "typescript") {
  const result = { enumCases: [], branches: [], sfSymbols: [], metrics: [], tokens: [] };
  const lines = text.split("\n");
  const scopes = [{ depth: -1, symbol: "file scope" }];
  const enumScopes = [];
  const symbolByLine = [];
  let depth = 0;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const closes = line.match(/^}+/)?.[0].length ?? 0;
    while (scopes.length > 1 && depth - closes <= scopes.at(-1).depth) scopes.pop();
    while (enumScopes.length && depth - closes <= enumScopes.at(-1).depth) enumScopes.pop();
    const declaration = line.match(/\b(?:struct|class|enum|actor|protocol|extension|func|var|let|typealias)\s+([A-Za-z_$][\w$]*)/);
    const symbol = declaration?.[1] ?? scopes.at(-1).symbol;
    if (declaration && raw.includes("{")) scopes.push({ depth: depth - closes, symbol });
    const enumDeclaration = line.match(/\benum\s+([A-Za-z_$][\w$]*)/);
    if (enumDeclaration) enumScopes.push({ depth: depth - closes, symbol: enumDeclaration[1] });
    symbolByLine[index + 1] = symbol;
    if (enumScopes.length && depth === enumScopes.at(-1).depth + 1 && /^case\s+/.test(line)) splitEnumCases(line.replace(/^case\s+/, "")).forEach((part, item) => {
      const value = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (value) result.enumCases.push(occurrence("enum", source, index + 1, value, enumScopes.at(-1).symbol, item + 1));
    });
    let match; let item = 0;
    while ((match = SYMBOL.exec(raw))) result.sfSymbols.push(occurrence("sf-symbol", source, index + 1, match[1], symbol, ++item));
    SYMBOL.lastIndex = 0;
    if (METRIC.test(line)) (line.match(/(?<![\w.])-?\d+(?:\.\d+)?/g) ?? []).forEach((value, n) => result.metrics.push(occurrence("metric", source, index + 1, value, symbol, n + 1)));
    if (TOKEN.test(line)) (line.match(/(?:Color|NSColor)\.[A-Za-z]+|\.(?:ultraThin|thin|regular|thick|ultraThick)Material|\.(?:primary|secondary|tertiary|quaternary)\b/g) ?? []).forEach((value, n) => result.tokens.push(occurrence("token", source, index + 1, value, symbol, n + 1)));
    depth += (raw.match(/{/g) ?? []).length - (raw.match(/}/g) ?? []).length;
  });
  for (const statement of sourceStatements(text)) {
    const { value } = statement; const candidates = []; let match;
    if ((match = value.match(/(?:^|}\s*)else\s+if\s*\((.+?)\)/))) candidates.push(["else-if", match[1]]);
    else if ((match = value.match(/(?:^|}\s*)if\s*\((.+?)\)/))) candidates.push(["if", match[1]]);
    else if ((match = value.match(/(?:^|}\s*)else\s+if\s+(.+?)\s*{/))) candidates.push(["else-if", match[1]]);
    else if ((match = value.match(/(?:^|}\s*)if\s+(.+?)\s*{/))) candidates.push(["if", match[1]]);
    else if ((match = value.match(/^guard\s+(.+?)\s+else\s*{/))) candidates.push(["guard", match[1]]);
    else if (/^}\s*else\s*{/.test(value)) candidates.push(["else", "else"]);
    else if ((match = value.match(/^case\s+(.+?):(?:\s|$)/))) candidates.push(["switch-case", match[1]]);
    else if (/^default\s*:/.test(value)) candidates.push(["switch-default", "default"]);
    if (language === "typescript") {
      const expression = value.replace(/^(?:return|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=)\s*/, "");
      if (expression.includes("&&") && !candidates.some(([kind]) => kind === "if" || kind === "else-if")) candidates.push(["logical-and", expression.split("?")[0].trim()]);
      const questions = expression.match(/(?<!\?)\?(?![?.])/g) ?? [];
      questions.forEach(() => candidates.push(["ternary", expression.split("?")[0].trim().split(":").at(-1).replace(/^[{()\s]+/, "")]));
    } else {
      for (const ternary of value.matchAll(/([A-Za-z_][\w.]*|[A-Za-z_][\w.]*\s*<=\s*-?\d+(?:\.\d+)?)\s+\?\s+/g)) candidates.push(["ternary", ternary[1]]);
      const paused = value.match(/\bpaused:\s*([^,)]+)/);
      if (paused) candidates.push(["conditional-argument", paused[1].trim()]);
    }
    candidates.forEach(([kind, condition], n) => result.branches.push(occurrence("branch", source, statement.line, condition.trim(), symbolByLine[statement.line] ?? "file scope", n + 1, kind)));
  }
  return result;
}

export function scanPillControlEmitSites(text) {
  const eventTypes = { cancel: "pillCancel", stop: "pillStop", acceptDraft: "pillAcceptDraft", undo: "pillUndo", pickModel: "pillPickModel", pickAxis: "pillPickAxis", pickAgent: "pillPickAgent", pickMic: "pillPickMic", openBillingPortal: "pillOpenBillingPortal", dismissOffline: "pillDismissOffline", scratchpadArm: "scratchpadArm", scratchpadRemove: "scratchpadRemove", scratchpadDeliver: "scratchpadDeliver", scratchpadDiscard: "scratchpadDiscard" };
  const sites = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/(?:model|scratch)\.emit\(\.([A-Za-z]+)/g)) if (eventTypes[match[1]]) sites.push({ type: eventTypes[match[1]], line: index + 1 });
    if (line.includes("selectorOpen = false")) sites.push({ type: "viewSelectorClose", line: index + 1 });
    if (line.includes("open.toggle()")) sites.push({ type: "viewSelectorOpen", line: index + 1 }, { type: "viewSelectorClose", line: index + 1 });
  });
  return sites;
}

export async function controlEmitSites() {
  return scanPillControlEmitSites(await git(["show", `${SOURCE_REVISION}:${swift("PillView.swift")}`]));
}

export function scanNotchControlEmitSites(text) {
  const source = swift("NotchView.swift");
  const sites = [];
  text.split("\n").forEach((line, index) => {
    if (/model\.emit\(model\.pocket\.taskCount > 0 \? \.pocketOpen : \.tap\)/.test(line)) {
      sites.push({ type: "pocketOpen", source, line: index + 1 }, { type: "tap", source, line: index + 1 });
    }
    if (/model\.onHover\(hovering\)/.test(line)) sites.push({ type: "hover", source, line: index + 1 });
  });
  return sites;
}

export function scanAppControllerNotchEmitSites(text) {
  const source = swift("AppController.swift");
  const sites = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/model\.emit\(\.((?:userLeft|userReturned))\b/g)) sites.push({ type: match[1], source, line: index + 1 });
  });
  return sites;
}

export async function notchControlEmitSites() {
  const [view, controller] = await Promise.all([
    git(["show", `${SOURCE_REVISION}:${swift("NotchView.swift")}`]),
    git(["show", `${SOURCE_REVISION}:${swift("AppController.swift")}`]),
  ]);
  return [...scanNotchControlEmitSites(view), ...scanAppControllerNotchEmitSites(controller)];
}

function splitEnumCases(value) {
  const parts = []; let depth = 0; let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") depth -= 1;
    else if (value[index] === "," && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts;
}

const B = (source, line, contribution) => ({ source, line, contribution });
const swift = (name) => `desktop/native-notch/Sources/unmute-notch/${name}`;
const CONTROL_LINES = {
  pillCancel: 537, pillStop: 553, pillAcceptDraft: 595, pillUndo: 637,
  pillPickModel: 986, pillPickAxis: 980, pillPickAgent: 1049, pillPickMic: 415,
  pillOpenBillingPortal: 316, pillDismissOffline: 317, scratchpadArm: 433,
  scratchpadRemove: 375, scratchpadDeliver: 376, scratchpadDiscard: 377,
  viewSelectorOpen: 853, viewSelectorClose: 853,
};
const control = (id, event, result, options = {}) => ({ id, event, result, ...(CONTROL_LINES[result.type] ? { provenance: { source: swift("PillView.swift"), line: options.line ?? CONTROL_LINES[result.type] } } : {}), ...options.metadata });
const none = (reason) => ({ kind: "none", reason });
const interactive = (...controls) => ({ kind: "interactive", controls });
const pillBase = (state) => ({ surface: "pill", state });
const pillDefaults = {
  phase: "hidden", kind: "dictation", taskId: null, level: 0, elapsed: 0, maxSeconds: 300,
  message: null, draftOffer: false, engineNotice: false, showDiscardHint: false,
  outputPreview: null, fallbackMessage: null, mutedText: null, model: null,
  modelOptions: [], modelAxes: [], modelEmpty: null, agent: null, agentOptions: [],
  agentConnected: true, micStatus: null, raw: false, micOptions: [], mic: null,
  coaching: null, offline: null, canUndo: false,
};
const pillState = (id, line, state, interactions, extra = {}) => ({
  id, family: "pill", cite: B(swift("PillView.swift"), line, id.startsWith("pill-recording-countdown") ? "Switches from waveform to countdown during the final 15 seconds." : `Defines the ${id.replace(/^pill-/, "").replaceAll("-", " ")} Pill rendering.`),
  input: {
    ...pillBase({ ...pillDefaults, ...state }),
    viewState: {
      selectorOpen: extra.openMenu != null,
      padExpanded: extra.presentation?.padExpanded ?? true,
      ...(extra.presentation?.cancelHover ? { hover: { pillRoundButton: { value: true, provenance: { source: swift("PillView.swift"), line: 746 } } } } : {}),
      ...(extra.presentation?.selectorRow ? { hover: { selectorRow: { value: true, provenance: { source: swift("PillView.swift"), line: 1065 } } } } : {}),
    },
    scratchpad: { enabled: false, armed: false, delivering: false, pad: null, destinations: { openTask: null }, ...(extra.scratchpad ?? {}) },
  }, interactions, ...(extra.providerMark ? { expectations: { providerMark: extra.providerMark } } : {}),
});
const recordControls = interactive(control("discard", "click discard", { type: "pillCancel" }), control("finish", "click finish", { type: "pillStop" }));
const agentOptions = [
  { id: "claude", label: "Claude Code", detail: "Anthropic CLI", available: true, terminal: true },
  { id: "codex-desktop", label: "Codex", detail: "OpenAI desktop", available: false, terminal: false },
];
const modelOptions = [{ id: "sonnet", label: "Claude Sonnet 4.5" }, { id: "opus", label: "Claude Opus 4.1" }];
const modelAxes = [
  { axis: "Model", current: "gpt-5.3-codex", values: ["gpt-5.3-codex", "gpt-5.2-codex"] },
  { axis: "Effort", current: "high", values: ["medium", "high"] },
];
const micOptions = [
  { id: "mac", label: "Mac microphone", detail: "MacBook Pro Microphone", available: true, terminal: null },
  { id: "iphone", label: "iPhone microphone", detail: "Zod's iPhone", available: true, terminal: null },
];
const PILL_STATES = [
  pillState("pill-hidden", 491, { phase: "hidden" }, none("The hidden phase deliberately renders no Pill or source-defined control.")),
  pillState("pill-recording-waveform-zero", 540, { phase: "recording", level: 0, elapsed: 0 }, recordControls),
  pillState("pill-recording-waveform-16", 540, { phase: "recording", level: 0.64, elapsed: 284 }, recordControls),
  pillState("pill-recording-cancel-hover", 758, { phase: "recording", level: 0.64, elapsed: 24 }, recordControls, { presentation: { cancelHover: true } }),
  pillState("pill-recording-countdown-15", 538, { phase: "recording", level: 0.64, elapsed: 285 }, recordControls),
  pillState("pill-recording-countdown-zero", 538, { phase: "recording", elapsed: 300 }, recordControls),
  pillState("pill-recording-instruction", 481, { phase: "recording", kind: "instruction", level: 0.42, elapsed: 8 }, recordControls),
  pillState("pill-recording-remote-warning", 396, { phase: "recording", kind: "remote", taskId: "task-42", level: 0.64, elapsed: 286, agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions, micOptions, mic: "mac" }, recordControls),
  pillState("pill-paused", 562, { phase: "paused", elapsed: 18 }, none("Paused shows only its amber status dot and label; the source defines no phase action.")),
  pillState("pill-processing-default", 580, { phase: "processing", elapsed: 12 }, none("Default processing is an animated status with no source-defined control.")),
  pillState("pill-processing-draft", 594, { phase: "processing", kind: "instruction", elapsed: 12, draftOffer: true }, interactive(control("quick-draft", "click Use quick draft", { type: "pillAcceptDraft" }))),
  pillState("pill-processing-on-device", 596, { phase: "processing", engineNotice: true }, none("On-device processing exposes an informational engine notice, not a control.")),
  pillState("pill-processing-discard-hint", 598, { phase: "processing", showDiscardHint: true }, none("Esc to discard is keyboard guidance; this Pill phase has no clickable action.")),
  pillState("pill-output", 605, { phase: "output" }, none("Output is a transient success acknowledgment with no source-defined control.")),
  pillState("pill-output-fallback-default", 613, { phase: "output-fallback" }, none("Fallback output reports raw paste completion and has no source-defined control.")),
  pillState("pill-output-fallback-preview", 619, { phase: "output-fallback", fallbackMessage: "Formatting unavailable — pasted raw", outputPreview: "Ship the checkout update" }, none("The preview is output text, not an interactive control.")),
  pillState("pill-too-short-default", 626, { phase: "too-short" }, none("The default capture failure acknowledgment has no source-defined control.")),
  pillState("pill-too-short-custom", 626, { phase: "too-short", mutedText: "No speech detected" }, none("Custom muted text is an acknowledgment with no source-defined control.")),
  pillState("pill-cancelled", 632, { phase: "cancelled", canUndo: true }, interactive(control("undo", "click Undo", { type: "pillUndo" }))),
  pillState("pill-error-default", 642, { phase: "error" }, none("The default error exposes retry guidance but no clickable Pill control.")),
  pillState("pill-error", 649, { phase: "error", message: "Transcription failed" }, none("Retry is keyboard guidance; the source defines no clickable Pill control.")),
  pillState("pill-error-limit", 649, { phase: "error", message: "Daily limit reached" }, none("Limit-reached errors suppress retry guidance and expose no control.")),
  pillState("pill-offline-not-signed-in", 314, { phase: "recording", offline: "not_signed_in" }, interactive(control("dismiss", "click dismiss", { type: "pillDismissOffline" }))),
  pillState("pill-offline-no-subscription", 314, { phase: "recording", offline: "no_subscription" }, interactive(control("dismiss", "click dismiss", { type: "pillDismissOffline" }))),
  pillState("pill-payment-failed", 1268, { phase: "recording", offline: "payment_failed" }, interactive(control("update-card", "click Update card", { type: "pillOpenBillingPortal" }), control("dismiss", "click dismiss", { type: "pillDismissOffline" }))),
  pillState("pill-offline-cloud-unreachable", 314, { phase: "recording", offline: "cloud_unreachable" }, interactive(control("dismiss", "click dismiss", { type: "pillDismissOffline" }))),
  pillState("pill-offline-on-device", 314, { phase: "recording", offline: "chose_on_device" }, interactive(control("dismiss", "click dismiss", { type: "pillDismissOffline" }))),
  pillState("pill-hint-mic", 441, { phase: "recording", micStatus: "AirPods" }, recordControls),
  pillState("pill-hint-mic-precedence", 441, { phase: "recording", micStatus: "AirPods — Move closer", coaching: { condition: "Quiet voice", remedy: "Speak louder", level: "quiet" } }, recordControls),
  pillState("pill-hint-coaching-quiet", 449, { phase: "recording", coaching: { condition: "Quiet voice", remedy: "Speak louder", level: "quiet" } }, recordControls),
  pillState("pill-hint-coaching-noisy", 449, { phase: "recording", coaching: { condition: "Noisy room", remedy: "Move somewhere quieter", level: "warn" } }, recordControls),
  pillState("pill-selector-closed", 250, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("selector", "click Agent and model", { type: "viewSelectorOpen", value: true }))),
  pillState("pill-selector-list", 983, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("model-opus", "click Claude Opus 4.1", { type: "pillPickModel", value: "opus" }), control("agent-codex", "click Codex", { type: "pillPickAgent", value: "codex-desktop" }), control("selector-toggle-close", "click Agent and model", { type: "viewSelectorClose", value: false }, { metadata: { visibility: { predicate: "selectorShowing", outcome: true } } }), control("selector-outside-close", "click outside selector", { type: "viewSelectorClose", value: false }, { line: 253, metadata: { visibility: { predicate: "selectorShowing", outcome: true } } })), { openMenu: "model" }),
  pillState("pill-selector-row-unselected-hover", 1088, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("model-opus", "click Claude Opus 4.1", { type: "pillPickModel", value: "opus" })), { openMenu: "model", presentation: { selectorRow: "unselected-hover" } }),
  pillState("pill-selector-codex-axes", 977, { phase: "recording", kind: "remote", agent: "Codex", agentOptions, model: "GPT-5.3 Codex · High", modelAxes }, interactive(control("axis-model", "click GPT-5.2 Codex", { type: "pillPickAxis", axis: "Model", value: "gpt-5.2-codex" }), control("axis-effort", "click Medium", { type: "pillPickAxis", axis: "Effort", value: "medium" })), { openMenu: "model" }),
  pillState("pill-selector-empty", 989, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, modelEmpty: "No models available" }, interactive(control("agent-claude", "click Claude Code", { type: "pillPickAgent", value: "claude" })), { openMenu: "model" }),
  pillState("pill-selector-task-addressed", 972, { phase: "recording", kind: "remote", taskId: "task-42", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("model-opus", "click Claude Opus 4.1", { type: "pillPickModel", value: "opus", taskId: "task-42" })), { openMenu: "model" }),
  pillState("pill-agent-disconnected", 865, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, agentConnected: false, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("agent-claude", "click Claude Code", { type: "pillPickAgent", value: "claude" })), { openMenu: "model" }),
  pillState("pill-agent-lane-processing", 896, { phase: "processing", kind: "remote", agent: "Codex", agentOptions: [], modelOptions: [] }, none("Agent lane disables selector hit testing while PillState.isAgentLane derives the full-cluster rim.")),
  pillState("pill-provider-claude-cli", 865, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, modelOptions }, interactive(control("selector", "click Agent and model", { type: "viewSelectorOpen", value: true })), { providerMark: { backend: "claude", vendor: "claude", name: "Claude Code CLI", terminal: true, art: "embedded" } }),
  pillState("pill-provider-claude-desktop", 1077, { phase: "recording", kind: "remote", agent: "Claude desktop", agentOptions: [{ id: "claude-code-desktop", label: "Claude desktop", detail: null, available: true, terminal: false }], modelOptions }, interactive(control("agent", "click Claude desktop", { type: "pillPickAgent", value: "claude-code-desktop" })), { openMenu: "model", providerMark: { backend: "claude-code-desktop", vendor: "claude", name: "Claude desktop", terminal: false, art: "embedded" } }),
  pillState("pill-provider-codex-cli", 1077, { phase: "recording", kind: "remote", agent: "Codex CLI", agentOptions: [{ id: "codex", label: "Codex CLI", detail: null, available: true, terminal: true }], modelAxes }, interactive(control("agent", "click Codex CLI", { type: "pillPickAgent", value: "codex" })), { openMenu: "model", providerMark: { backend: "codex", vendor: "codex", name: "Codex CLI", terminal: true, art: "embedded" } }),
  pillState("pill-provider-codex-desktop", 1077, { phase: "recording", kind: "remote", agent: "Codex desktop", agentOptions: [{ id: "codex-desktop", label: "Codex desktop", detail: null, available: true, terminal: false }], modelAxes }, interactive(control("agent", "click Codex desktop", { type: "pillPickAgent", value: "codex-desktop" })), { openMenu: "model", providerMark: { backend: "codex-desktop", vendor: "codex", name: "Codex desktop", terminal: false, art: "embedded" } }),
  pillState("pill-mic-iphone", 414, { phase: "recording", micOptions, mic: "iphone" }, interactive(control("mic", "click iPhone mic", { type: "pillPickMic", value: "mac" }))),
  pillState("pill-mic-mac", 1113, { phase: "recording", micOptions, mic: "mac" }, interactive(control("mic", "click Mac mic", { type: "pillPickMic", value: "iphone" }))),
  pillState("pill-mic-single-suppressed", 414, { phase: "recording", micOptions: [micOptions[0]], mic: "mac" }, recordControls),
  pillState("pill-scratchpad-armed", 431, { phase: "paused" }, interactive(control("scratchpad", "click scratchpad", { type: "scratchpadArm", on: false })), { scratchpad: { enabled: true, armed: true, pad: { id: "pad-7", origin: "dictation", entries: [] } } }),
  pillState("pill-scratchpad-unarmed", 1154, { phase: "recording" }, interactive(control("scratchpad", "click scratchpad", { type: "scratchpadArm", on: true })), { scratchpad: { enabled: true, armed: false, pad: null } }),
  pillState("pill-scratchpad-expanded", 348, { phase: "paused", offline: "cloud_unreachable" }, interactive(control("remove", "click remove entry", { type: "scratchpadRemove", id: "entry-1" }), control("deliver", "click deliver", { type: "scratchpadDeliver", dest: "openTask" }), control("discard", "click discard pad", { type: "scratchpadDiscard" })), { presentation: { padExpanded: true }, scratchpad: { enabled: true, armed: true, destinations: { openTask: { id: "task-42", name: "Deploy checkout" } }, delivering: false, pad: { id: "pad-7", origin: "dictation", entries: [{ id: "entry-1", type: "insert", text: "", kind: "line", content: "Keep this thought", startMs: 0, endMs: 0, atMs: 2400 }] } } }),
];
const PILL_PHASE_LINKS = { hidden: "pill-hidden", recording: "pill-recording-waveform-16", paused: "pill-paused", processing: "pill-processing-default", output: "pill-output", outputFallback: "pill-output-fallback-default", tooShort: "pill-too-short-default", cancelled: "pill-cancelled", error: "pill-error-default" };
const PILL_KIND_LINKS = { dictation: "pill-recording-waveform-16", instruction: "pill-recording-instruction", remote: "pill-recording-remote-warning" };
const PILL_OFFLINE_LINKS = { notSignedIn: "pill-offline-not-signed-in", noSubscription: "pill-offline-no-subscription", paymentFailed: "pill-payment-failed", cloudUnreachable: "pill-offline-cloud-unreachable", choseOnDevice: "pill-offline-on-device" };
const PILL_VIEW_LINKS = {
  54: "pill-recording-waveform-16", 55: "pill-recording-waveform-16", 65: "pill-recording-waveform-16", 69: "pill-recording-waveform-16", 73: "pill-recording-waveform-16", 102: "pill-recording-waveform-16", 169: "pill-agent-lane-processing",
  250: "pill-selector-list", 309: "pill-recording-waveform-16", 310: "pill-selector-list", 314: "pill-payment-failed", 348: "pill-scratchpad-expanded", 359: "pill-scratchpad-expanded", 368: "pill-scratchpad-expanded", 383: "pill-scratchpad-expanded", 396: "pill-recording-remote-warning", 413: "pill-mic-iphone", 414: "pill-mic-iphone", 431: "pill-scratchpad-armed", 441: "pill-hint-mic-precedence", 449: "pill-hint-coaching-quiet",
  466: "pill-agent-lane-processing", 472: "pill-error-default", 473: "pill-output-fallback-default", 481: "pill-recording-instruction", 482: "pill-recording-instruction", 483: "pill-output", 491: "pill-hidden", 494: "pill-recording-waveform-16", 538: "pill-recording-countdown-15", 540: "pill-recording-waveform-16", 562: "pill-paused", 580: "pill-processing-default", 594: "pill-processing-draft", 596: "pill-processing-on-device", 598: "pill-processing-discard-hint", 605: "pill-output", 613: "pill-output-fallback-default", 619: "pill-output-fallback-preview", 626: "pill-too-short-custom", 632: "pill-cancelled", 642: "pill-error-default", 649: "pill-error-limit", 661: "pill-processing-draft", 662: "pill-processing-on-device", 675: "pill-processing-default", 690: "pill-processing-default", 707: "pill-recording-countdown-15", 710: "pill-recording-countdown-15", 758: "pill-recording-cancel-hover", 761: "pill-recording-cancel-hover", 762: "pill-recording-cancel-hover", 782: "pill-processing-draft", 783: "pill-cancelled", 786: "pill-processing-draft", 787: "pill-cancelled", 788: "pill-cancelled",
  865: "pill-agent-disconnected", 867: "pill-agent-disconnected", 869: "pill-agent-disconnected", 882: "pill-agent-disconnected", 884: "pill-selector-closed", 896: "pill-selector-list", 900: "pill-selector-list", 957: "pill-selector-codex-axes", 972: "pill-selector-list", 977: "pill-selector-codex-axes", 983: "pill-selector-list", 985: "pill-selector-list", 989: "pill-selector-empty", 1017: "pill-selector-codex-axes", 1072: "pill-selector-list", 1077: "pill-provider-claude-desktop", 1083: "pill-selector-list", 1087: "pill-selector-list", 1088: "pill-selector-row-unselected-hover", 1098: "pill-mic-iphone", 1113: "pill-mic-mac", 1150: "pill-scratchpad-armed", 1154: "pill-scratchpad-unarmed", 1242: "pill-selector-list", 1263: "pill-payment-failed", 1266: "pill-payment-failed", 1268: "pill-payment-failed", 1282: "pill-payment-failed",
};
const PROVIDER_LINKS = { 21: "pill-provider-claude-cli", 37: "pill-provider-claude-cli", 51: "pill-provider-claude-cli", 61: "pill-provider-claude-cli", 62: "pill-provider-codex-cli", 63: "pill-provider-claude-cli", 67: "pill-provider-claude-cli", 68: "pill-provider-claude-cli", 69: "pill-provider-claude-cli", 72: "pill-provider-claude-cli", 79: "pill-provider-claude-cli", 87: "pill-provider-codex-cli", 88: "pill-provider-codex-desktop", 89: "pill-provider-claude-desktop", 90: "pill-provider-claude-cli" };
const WAVEFORM_LINKS = { 77: "pill-recording-waveform-zero", 86: "pill-recording-waveform-zero", 142: "pocket-agent-listening", 144: "pocket-agent-listening", 150: "pocket-agent-listening", 151: "pocket-agent-listening", 152: "pocket-agent-listening", 154: "pocket-agent-listening", 155: "pocket-agent-listening" };
const EVALUABLE_PILL_LINES = new Set([250, 309, 310, 314, 348, 359, 368, 383, 396, 414, 431, 441, 449, 466, 472, 473, 481, 482, 483, 491, 494, 538, 540, 562, 580, 594, 596, 598, 605, 613, 619, 626, 632, 642, 649, 661, 662, 865, 867, 869, 882, 884, 896, 900, 957, 972, 977, 983, 989, 1017, 1072, 1077, 1083, 1087, 1088, 1098, 1113, 1150, 1154, 1242, 1263, 1266, 1268, 1282]);
const pocketSlot = { id: "task-42", title: "Deploy checkout", kind: null, ask: "Which environment should I deploy to?", status: "needs-user", demanding: true, backend: "codex-desktop", terminal: false };
const taskBase = { id: "task-42", title: "Deploy checkout", origin: null, agentRunId: null, status: "needs-user", kind: "session", alive: true, shelved: false, dir: "/Users/zodpatel/work/checkout", age: "2m", elapsed: "00:42", warmup: null, note: null, activity: "Which environment should I deploy to?", result: null, error: null, mcpGap: null, deliveryError: null, sending: false, modelLabel: "GPT-5.3 Codex High", agentCanRetry: false, backend: "codex-desktop", conversation: [], blocks: [], usage: { inputTokens: 1240, outputTokens: 318, contextWindow: 200000 }, project: "checkout", terminal: false, resumable: true, owned: true, resuming: false, resumeError: null };

const notchControl = (id, event, result, source, line) => ({ id, event, result, provenance: { source: swift(source), line } });
const notchModel = (overrides = {}) => ({
  state: "idle", hovering: false, silenced: [], attention: 0, working: 0,
  agentActivity: null, task: null, capturePhase: null, captureTarget: null,
  pocket: { mode: "closed", at: 0, waiting: 0, remoteKey: "right-option", slots: [] },
  hasNotch: true, ...overrides,
});
const notchGeometry = (hasNotch = true, overrides = {}) => ({
  screenFrame: { x: 0, y: 0, width: 1512, height: 982 }, hasNotch,
  cutout: hasNotch ? { x: 656, y: 948, width: 200, height: 34 } : null,
  barHeight: hasNotch ? 34 : 24, leftUsable: hasNotch ? 656 : 756,
  rightUsable: hasNotch ? 656 : 756, ...overrides,
});
const STATUS = {
  processing: { isYourMove: false, label: "Working", color: "systemGreen" },
  "needs-user": { isYourMove: true, label: "Needs you", color: "systemOrange" },
  ready: { isYourMove: true, label: "Ready", color: "systemTeal" },
  stuck: { isYourMove: true, label: "Stuck", color: "systemRed" },
  done: { isYourMove: false, label: "Done", color: "systemGray" },
  failed: { isYourMove: true, label: "Errored", color: "systemRed" },
};
const DETAIL_WIDTH = new Map([
  ["Tests", 28.9521484375],
  ["Running the exceptionally long checkout integration test suite before release", 417.565673828125],
  ["Running checkout tests", 127.976806640625], ["Deploy checkout", 91.2587890625],
  ["Which environment should I deploy to?", 211.16650390625], ["Choose the release environment", 175.908447265625],
  ["listening release work", 118.150146484375], ["searching release work", 125.41064453125],
  ["thinking release work", 115.769287109375], ["confirming release work", 130.537353515625],
  ["complete release work", 122.866943359375], ["failed release work", 102.124267578125],
  ["Could not send answer", 124.703125], ["Release checklist", 94.476318359375],
]);
const STATUS_WIDTH = { Working: 44.240819334983826, "Needs you": 56.668625473976135, Ready: 33.226372718811035, Stuck: 30.749499917030334, Done: 27.94700849056244, Errored: 40.04375410079956, Sending: 43.83958971500397, Listening: 49.1507385969162, Searching: 53.86199164390564, Thinking: 46.246041655540466, Confirming: 59.51544809341431, "Couldn't complete": 98.85295975208282, "1 waiting on you": 85.98001897335052, "2 waiting on you": 87.48266899585724 };
function resolveBar(model) {
  const expanded = ["task", "cockpit"].includes(model.state);
  let selected = "state"; let dot = null; let left = null; let right = null; let badge = null; let alarm = null; let resting = false;
  if (model.toast && !expanded) { selected = "toast"; dot = "failed"; left = "Couldn't complete"; right = model.toast; alarm = "failed"; }
  else if (model.agentActivity && !expanded) {
    selected = "agentActivity";
    const mapping = { listening: ["processing", "Listening"], searching: ["processing", "Searching"], thinking: ["processing", "Thinking"], confirming: ["needs-user", "Confirming"], complete: ["done", "Done"], failed: ["failed", "Couldn't complete"] };
    [dot, left] = mapping[model.agentActivity.state]; right = model.agentActivity.summary;
    if (["confirming", "failed"].includes(model.agentActivity.state)) alarm = dot;
  } else if (model.capturePhase === "routing" && !expanded) { selected = "routing"; dot = "processing"; left = "Sending"; }
  else if (model.pocket.waiting > 0 && !expanded && model.pocket.mode !== "open") {
    selected = "pocket"; dot = "needs-user"; left = `${model.pocket.waiting} waiting on you`; alarm = "needs-user";
    if (model.hovering && model.pocket.slots[0]) right = model.pocket.slots[0].title;
  } else if (model.state === "idle") {
    if (!model.hasNotch && !model.hovering) resting = true; else left = "unmute";
  } else if (model.state === "active") {
    dot = "processing"; left = "Working"; badge = model.working;
    if (model.working === 1 && model.task?.status === "processing") right = model.hovering ? model.task.title : (model.task.activity ?? model.task.title);
  } else if (model.state === "attention") {
    dot = model.task?.status ?? "needs-user"; left = STATUS[dot].label; badge = model.attention; alarm = dot;
    right = model.task ? model.task.question?.text ?? model.task.activity ?? model.task.title : null;
  }
  const signature = `${dot ?? "-"}|${left ?? ""}|${right ?? ""}|${badge ?? 0}`;
  const silenced = !model.hovering && !expanded && model.silenced.includes(signature);
  if (silenced) return { selected: "silenced", dot: null, left: null, right: null, badge: null, alarm: null, resting: !model.hasNotch, signature };
  return { selected, dot, left, right, badge, alarm, resting, signature };
}
function geometryExpectation(model, geometry, bar) {
  const fillet = Math.max(Math.round(geometry.barHeight * 0.3), 4);
  const bottomRadius = fillet;
  let leftWidth = 0;
  if (bar.resting) leftWidth = 56;
  else if (bar.dot || bar.left) {
    const measuredLeft = bar.left === "unmute" ? 13 * (126 / 78) + 2 : STATUS_WIDTH[bar.left];
    if (bar.left && measuredLeft == null) throw new Error(`Missing deterministic AppKit status width for '${bar.left}'`);
    leftWidth = 13 + (bar.dot ? 14 : 0) + (measuredLeft ?? 0);
    if (bar.badge > 1) leftWidth += 7 + Math.ceil(({ 2: 6.115148901939392, 3: 6.352493524551392, 4: 6.519021391868591 }[bar.badge] ?? 12) + 12);
    leftWidth = Math.ceil(leftWidth + 7);
  }
  const textWidth = bar.right ? DETAIL_WIDTH.get(bar.right) : 0;
  if (bar.right && textWidth == null) throw new Error(`Missing deterministic AppKit detail width for '${bar.right}'`);
  const wantedRightWidth = bar.right ? Math.ceil(7 + textWidth + 13) : 0;
  const roomRight = Math.max(geometry.rightUsable - fillet - 24, 0);
  let allocatedRightWidth = Math.min(wantedRightWidth, roomRight);
  if (allocatedRightWidth < 54) allocatedRightWidth = 0;
  const middle = geometry.cutout?.width ?? (leftWidth > 0 && allocatedRightWidth > 0 ? 18 : 0);
  const width = Math.min(fillet + leftWidth + middle + allocatedRightWidth + fillet, geometry.screenFrame.width);
  let x = geometry.cutout ? (geometry.cutout.x + geometry.cutout.width / 2) - middle / 2 - leftWidth - fillet : geometry.screenFrame.x + geometry.screenFrame.width / 2 - width / 2;
  x = Math.min(Math.max(x, geometry.screenFrame.x), geometry.screenFrame.x + geometry.screenFrame.width - width);
  return { path: geometry.hasNotch ? "notched" : "no-notch", textWidth, wantedRightWidth, roomRight, allocatedRightWidth, leftWidth, fillet, bottomRadius, middle, frame: { x: Math.round(x), y: Math.round(geometry.screenFrame.y + geometry.screenFrame.height - geometry.barHeight), width: Math.round(width), height: Math.round(geometry.barHeight) } };
}
const notchState = (id, line, modelOverrides, options = {}) => {
  const model = notchModel(modelOverrides); const hasNotch = model.hasNotch;
  const geometry = notchGeometry(hasNotch, options.geometry); const bar = resolveBar(model);
  const expandedFrame = ["task", "cockpit"].includes(model.state) ? { x: Math.round(geometry.screenFrame.width * (1 - (options.appearance?.fill ?? 0.8)) / 2), y: Math.round(geometry.screenFrame.height * (1 - (options.appearance?.fill ?? 0.8))), width: Math.round(geometry.screenFrame.width * (options.appearance?.fill ?? 0.8)), height: Math.round(geometry.screenFrame.height * (options.appearance?.fill ?? 0.8)) } : null;
  return {
    id, family: "notch", cite: B(swift(options.source ?? "BarContent.swift"), line, options.contribution ?? `Defines the ${id.replace(/^notch-/, "").replaceAll("-", " ")} notch rendering.`),
    input: {
      surface: "notch", model,
      viewState: { pointerRegion: model.hovering ? "bar" : null, transitionPocket: false },
      geometry,
      appearance: { preference: options.appearance?.preference ?? "system", tone: options.appearance?.tone ?? "spaceGray", fill: options.appearance?.fill ?? 0.8 },
      controller: { commandedState: options.controller?.commandedState ?? model.state, restedFrom: options.controller?.restedFrom ?? null, autoPresent: options.controller?.autoPresent ?? true, lastGestureAgeSeconds: options.controller?.lastGestureAgeSeconds ?? null, surfaceIsAlreadyExpanded: options.controller?.surfaceIsAlreadyExpanded ?? ["task", "cockpit"].includes(model.state), departureTransition: options.controller?.departureTransition ?? { phase: "idle" } },
      expectation: { bar, geometry: geometryExpectation(model, geometry, bar), ...(model.task ? { taskStatus: STATUS[model.task.status] } : {}), ...(model.agentActivity ? { agentTiming: { terminal: ["complete", "failed"].includes(model.agentActivity.state), clearAfterSeconds: ["complete", "failed"].includes(model.agentActivity.state) ? 2.2 : null } } : {}), ...(expandedFrame ? { expandedFrame } : {}) },
    },
    interactions: options.interactions ?? (["task", "cockpit"].includes(model.state) || model.pocket.mode === "open"
      ? none("This specimen has no visible bar; controls belong to its expanded or Pocket family and are outside this gate.")
      : interactive(notchControl("open", "click bar", { type: model.pocket.slots.length > 0 ? "pocketOpen" : "tap" }, "NotchView.swift", 89))),
    ...(options.expectations ? { expectations: options.expectations } : {}),
  };
};
const agentActivity = (state) => ({ state, summary: `${state} release work`, interactionId: "interaction-7", agentRunId: "run-3", provider: "codex" });
const task = (status, overrides = {}) => ({
  canEditLatestMessage: false, olderMessages: 0, id: "task-42", title: "Deploy checkout",
  origin: null, agentRunId: null, status, kind: "session", alive: true, shelved: false,
  dir: "/Users/zodpatel/work/checkout", age: "2m", elapsed: "00:42", warmup: null,
  note: null, activity: "Which environment should I deploy to?", question: null,
  questionAcknowledgment: null, history: null, turnOutcome: null, mcpStatuses: null,
  result: null, error: null, mcpGap: null, deliveryError: null, sending: false,
  modelLabel: "GPT-5.3 Codex High", agentCanRetry: false, backend: "codex-desktop",
  conversation: [], blocks: [], usage: { inputTokens: 1240, outputTokens: 318, contextWindow: 200000 },
  project: "checkout", model: "gpt-5.3-codex", ...overrides,
});
const NOTCH_STATES = [
  notchState("notch-dormant-hardware", 230, { state: "dormant" }, { interactions: interactive(notchControl("reveal", "pointer enters bar", { type: "hover", hovering: true }, "NotchView.swift", 100)) }),
  notchState("notch-idle-wordmark", 235, { state: "idle" }),
  notchState("notch-idle-resting-nub", 247, { state: "idle", hasNotch: false }, { interactions: interactive(notchControl("reveal", "pointer enters bar", { type: "hover", hovering: true }, "NotchView.swift", 100)) }),
  notchState("notch-idle-hover", 247, { state: "idle", hasNotch: false, hovering: true }, { interactions: interactive(notchControl("leave", "pointer exits bar", { type: "hover", hovering: false }, "NotchView.swift", 100)) }),
  notchState("notch-active-task-activity", 257, { state: "active", working: 1, task: task("processing", { activity: "Running checkout tests" }) }),
  notchState("notch-active-task-hover-title", 270, { state: "active", hovering: true, working: 1, task: task("processing", { activity: "Running checkout tests" }) }),
  notchState("notch-active-multiple-badge", 257, { state: "active", working: 4 }),
  notchState("notch-active-live-capture", 257, { state: "active", working: 1, capturePhase: "listening", captureTarget: "task-42" }),
  ...["processing", "needs-user", "ready", "stuck", "done", "failed"].map((status) => notchState(`notch-attention-${status}`, 275, { state: "attention", attention: status === "processing" ? 1 : 3, task: task(status, status === "needs-user" ? { question: { reference: null, acknowledgment: null, text: "Choose the release environment", details: null, kind: "choice", choices: ["Staging", "Production"], irreversible: false } } : {}) })),
  notchState("notch-task-expanded", 285, { state: "task", task: task("needs-user") }, { source: "BarContent.swift", appearance: { tone: "black" } }),
  notchState("notch-cockpit-expanded", 285, { state: "cockpit" }, { source: "BarContent.swift" }),
  notchState("notch-toast-collapsed", 158, { state: "idle", toast: "Could not send answer" }),
  notchState("notch-precedence-toast", 158, { state: "attention", toast: "Could not send answer", agentActivity: agentActivity("thinking"), capturePhase: "routing", attention: 1, task: task("ready"), pocket: { mode: "closed", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }),
  notchState("notch-toast-expanded-suppressed", 158, { state: "task", toast: "Could not send answer", task: task("needs-user") }),
  ...["listening", "searching", "thinking", "confirming", "complete", "failed"].map((state, index) => notchState(`notch-agent-${state}`, 165 + index, { state: state === "confirming" ? "attention" : "active", agentActivity: agentActivity(state) })),
  notchState("notch-precedence-activity", 161, { state: "attention", agentActivity: agentActivity("thinking"), capturePhase: "routing", attention: 1, task: task("ready"), pocket: { mode: "closed", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }),
  notchState("notch-agent-expanded-suppressed", 161, { state: "cockpit", agentActivity: agentActivity("thinking") }),
  notchState("notch-routing", 189, { state: "idle", capturePhase: "routing", captureTarget: "Deploy checkout" }),
  notchState("notch-precedence-routing", 189, { state: "attention", capturePhase: "routing", attention: 1, task: task("ready"), pocket: { mode: "closed", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }),
  notchState("notch-routing-expanded-suppressed", 189, { state: "task", capturePhase: "routing", task: task("processing") }),
  notchState("notch-pocket-waiting-one", 210, { state: "idle", pocket: { mode: "closed", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }),
  notchState("notch-precedence-pocket", 210, { state: "attention", attention: 1, task: task("ready"), pocket: { mode: "closed", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }),
  notchState("notch-pocket-waiting-hover-detail", 224, { state: "attention", hovering: true, attention: 2, pocket: { mode: "closed", at: 0, waiting: 2, remoteKey: "right-option", slots: [pocketSlot, { ...pocketSlot, id: "task-43", title: "Release checklist" }] } }, { interactions: interactive(notchControl("leave", "pointer exits bar", { type: "hover", hovering: false }, "NotchView.swift", 100)) }),
  notchState("notch-pocket-open-does-not-announce", 210, { state: "idle", pocket: { mode: "open", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }),
  notchState("notch-silenced-hardware-empty", 145, { state: "attention", attention: 1, task: task("needs-user"), silenced: ["needs-user|Needs you|Which environment should I deploy to?|1"] }),
  notchState("notch-silenced-off-notch-nub", 145, { state: "active", hasNotch: false, working: 2, silenced: ["processing|Working||2"] }),
  notchState("notch-silenced-hover-exempt", 145, { state: "active", hovering: true, working: 2, silenced: ["processing|Working||2"] }),
  notchState("notch-right-segment-fit", 270, { state: "active", working: 1, task: task("processing", { activity: "Running checkout tests" }) }),
  notchState("notch-right-segment-truncated", 270, { state: "active", working: 1, task: task("processing", { activity: "Running the exceptionally long checkout integration test suite before release" }) }, { geometry: { rightUsable: 118 } }),
  notchState("notch-right-segment-boundary-54", 270, { state: "active", working: 1, task: task("processing", { activity: "Running checkout tests" }) }, { geometry: { rightUsable: 88 } }),
  notchState("notch-right-segment-dropped", 270, { state: "active", working: 1, task: task("processing", { activity: "Running checkout tests" }) }, { geometry: { rightUsable: 87 } }),
  notchState("notch-right-segment-fit-no-notch", 270, { state: "active", hasNotch: false, working: 1, task: task("processing", { activity: "Running checkout tests" }) }),
  notchState("notch-right-segment-truncated-no-notch", 270, { state: "active", hasNotch: false, working: 1, task: task("processing", { activity: "Running the exceptionally long checkout integration test suite before release" }) }, { geometry: { rightUsable: 118 } }),
  notchState("notch-right-segment-boundary-54-no-notch", 270, { state: "active", hasNotch: false, working: 1, task: task("processing", { activity: "Running checkout tests" }) }, { geometry: { rightUsable: 85 } }),
  notchState("notch-right-segment-dropped-no-notch", 270, { state: "active", hasNotch: false, working: 1, task: task("processing", { activity: "Running checkout tests" }) }, { geometry: { rightUsable: 84 } }),
  notchState("notch-expanded-glass-tone", 224, { state: "task", task: task("ready") }, { source: "NotchView.swift", appearance: { preference: "glass", tone: "glass" } }),
  notchState("notch-collapsed-glass-remains-black", 224, { state: "active", working: 2 }, { source: "NotchView.swift", appearance: { preference: "glass", tone: "glass" } }),
  notchState("notch-expanded-solid-space-gray-fill", 173, { state: "cockpit" }, { source: "Theme.swift", appearance: { preference: "solid", tone: "spaceGray", fill: 0.7 } }),
  notchState("notch-auto-present-allowed", 1100, { state: "task", task: task("needs-user") }, { source: "AppController.swift", controller: { autoPresent: true } }),
  notchState("notch-auto-present-held-collapsed", 1100, { state: "attention", attention: 1, task: task("needs-user") }, { source: "AppController.swift", controller: { commandedState: "task", autoPresent: false } }),
  notchState("notch-auto-present-explicit-gesture", 1100, { state: "task", task: task("needs-user") }, { source: "AppController.swift", controller: { autoPresent: false, lastGestureAgeSeconds: 5.999, surfaceIsAlreadyExpanded: false } }),
  notchState("notch-departure-expanded-hide", 1857, { state: "task", task: task("processing") }, { source: "AppController.swift", controller: { departureTransition: { phase: "awaitingCompact" } }, interactions: interactive(notchControl("leave-app", "activate another application", { type: "userLeft", reason: "blur" }, "AppController.swift", 1862)) }),
  notchState("notch-departure-collapsed-noop", 1857, { state: "active", working: 1 }, { source: "AppController.swift", controller: { departureTransition: { phase: "idle" } } }),
  notchState("notch-departure-return", 1821, { state: "task", task: task("processing") }, { source: "AppController.swift", controller: { departureTransition: { phase: "returning" } }, interactions: interactive(notchControl("return-app", "reactivate Unmute", { type: "userReturned" }, "AppController.swift", 1831)) }),
];

const STATES = [
  { id: "foundations-theme-status", family: "foundations", cite: B(swift("Theme.swift"), 77, "Maps processing status to the exact green status color."), input: { surface: "foundations", component: "status", status: "processing", label: "Working" }, interactions: none("A status token specimen has no source-defined control.") },
  { id: "foundations-waveform-level", family: "foundations", cite: B(swift("Waveform.swift"), 44, "Fixes each of the eleven waveform bars at the source-defined 3pt width while level 0.64 controls height."), input: { surface: "foundations", component: "waveform", level: 0.64, barCount: 11, barWidth: 3, gap: 2.5 }, interactions: none("The waveform visualizes input level and is not directly interactive.") },
  ...PILL_STATES,
  ...NOTCH_STATES,
  { id: "pocket-task-question", family: "pocket", cite: B(swift("PocketView.swift"), 139, "The task ask replaces its coarse status on the open Pocket face."), input: { surface: "pocket", capturePhase: null, hasNotch: false, pocket: { mode: "open", at: 0, waiting: 1, remoteKey: "right-option", slots: [pocketSlot] } }, interactions: interactive(control("expand", "click task card", { type: "pocketExpand", id: "task-42" }), control("close", "click close", { type: "pocketClose" })) },
  { id: "pocket-agent-listening", family: "pocket", cite: B(swift("PocketView.swift"), 321, "Replaces Pocket status with the live aimed-capture chip."), input: { surface: "pocket", capturePhase: "listening", hasNotch: true, pocket: { mode: "open", at: 0, waiting: 0, remoteKey: "fn", slots: [{ id: "unmute-agent", title: "Unmute", kind: "agent", ask: null, status: "processing", demanding: false, backend: "codex", terminal: false }] } }, interactions: interactive(control("close", "click close", { type: "pocketClose" })) },
  { id: "conversation-question-choice", family: "conversation", cite: B(swift("TaskSurfaceView.swift"), 62, "Renders a source QuestionP only for a Needs User task."), input: { surface: "conversation", task: { ...taskBase, question: { reference: { requestId: "request-9", questionId: "question-2" }, acknowledgment: null, text: "Which environment should I deploy to?", details: "Production changes customer traffic.", kind: "choice", choices: ["Staging", "Production"], irreversible: true } } }, interactions: interactive(control("choice-production", "click Production", { type: "questionAnswer", id: "task-42", answer: "Production" })) },
  { id: "conversation-composer-attachment", family: "conversation", cite: B(swift("TaskSurfaceView.swift"), 73, "Selects the composable footer for a live writable task."), input: { surface: "conversation", task: { ...taskBase, status: "processing", question: null, draft: { text: "Use this screenshot", attachments: [{ id: "attachment-1", path: "/tmp/checkout.png", mimeType: "image/png", name: "checkout.png", reservationOrder: 0 }], clientRevision: 3, stagingCount: 0, error: null, operations: [], tool: "image" }, chatConfig: { provider: "codex", providerLabel: "Codex", model: "gpt-5.3-codex", modelLabel: "GPT-5.3 Codex", providers: [{ id: "codex", label: "Codex", description: null }], models: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: null }], efforts: [{ id: "high", label: "High", description: null }], effort: "high", permissions: [{ id: "workspace-write", label: "Workspace write", description: null }], permission: "workspace-write", permissionScope: "/Users/zodpatel/work/checkout", cwd: "/Users/zodpatel/work/checkout", mutable: true, busy: false, error: null, dictation: null, dictationError: null }, canCompose: true } }, interactions: interactive(control("send", "click Send", { type: "taskMessage", id: "task-42", text: "Use this screenshot" }), control("remove-attachment", "click remove attachment", { type: "draftRemoveAttachment", id: "attachment-1" })) },
  { id: "conversation-session-not-running", family: "conversation", cite: B(swift("TaskSurfaceView.swift"), 90, "Selects SessionNotRunning for a resumable stopped session."), input: { surface: "conversation", task: { ...taskBase, status: "ready", alive: false, question: null, canCompose: false, resumable: true, resumeError: "Codex process exited" } }, interactions: interactive(control("resume", "click Resume", { type: "resume", id: "task-42" })) },
  { id: "cockpit-needs-you", family: "cockpit", cite: B(swift("WallView.swift"), 169, "Selects the exact Needs you wall subtitle."), input: { surface: "cockpit", view: "needsYou", cockpit: { projects: [{ name: "Checkout", path: "/Users/zodpatel/work/checkout" }], groups: [{ name: "Checkout", cards: [{ id: "task-42", title: "Deploy checkout", status: "needs-user", activity: "Which environment should I deploy to?", qpos: 1, backend: "codex-desktop" }], hidden: 0 }], hiddenTotal: 0, showingAll: false, todayOnly: false, queue: [], oneoffs: [], unmuteSkills: [], skills: [], shelf: [], importable: [], digest: "While you were away: deployment is ready", doorbell: true, routeOffer: null, tmuxAvailable: true } }, interactions: interactive(control("focus-task", "click Deploy checkout", { type: "focusTask", id: "task-42" })) },
  { id: "cockpit-route-offer", family: "cockpit", cite: B(swift("WallView.swift"), 620, "Renders the route-offer action from exact RouteOfferP data."), input: { surface: "cockpit", view: "allWork", cockpit: { projects: [], groups: [], hiddenTotal: 0, showingAll: false, todayOnly: false, queue: [], oneoffs: [], unmuteSkills: [], skills: [], shelf: [], importable: [], digest: null, doorbell: false, routeOffer: { newTaskId: "task-44", altTaskId: "task-43", altName: "Release checklist" }, tmuxAvailable: false } }, interactions: interactive(control("accept-route", "click Route to Release checklist", { type: "offerAccept", newTaskId: "task-44" })) },
  { id: "scratchpad-entry", family: "scratchpad", cite: B(swift("ScratchpadView.swift"), 312, "Expands the full transcript text only after the segment row is toggled."), input: { surface: "scratchpad", scratchpad: { enabled: true, armed: true, delivering: false, pad: { id: "pad-7", origin: "dictation", entries: [{ id: "segment-1", type: "segment", text: "Ship the checkout update", kind: null, content: null, startMs: 1200, endMs: 4800, atMs: 4800 }] }, destinations: { openTask: { id: "task-42", name: "Deploy checkout" } } } }, interactions: interactive(control("remove-entry", "click remove", { type: "scratchRemoveEntry", id: "segment-1" }), control("expand-entry", "click segment", { type: "scratchToggleEntry", id: "segment-1" })) },
  { id: "scratchpad-delivering", family: "scratchpad", cite: B(swift("ScratchpadView.swift"), 341, "Uses the disabled ink when delivery disables every destination and discard action."), input: { surface: "scratchpad", scratchpad: { enabled: true, armed: false, delivering: true, pad: { id: "pad-7", origin: "dictation", entries: [{ id: "text-1", type: "text", text: "Ship the checkout update", kind: null, content: null, startMs: null, endMs: null, atMs: 4800 }] }, destinations: { openTask: { id: "task-42", name: "Deploy checkout" } } } }, interactions: none("Delivery is in flight; source disables destination and discard controls until it settles.") },
  { id: "notetaker-recording", family: "notetaker", cite: B("desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx", 520, "Defines recording as neither completed nor showing discard actions."), input: { surface: "notetaker", widget: { sessionId: 7, completed: false, showDiscard: false, levels: [0, 0.12, 0.35, 0.64, 0.88, 0.64, 0.35, 0.12, 0, 0, 0] } }, interactions: interactive(control("meeting-actions", "click recording pill", { showDiscard: true })) },
  { id: "notetaker-discard", family: "notetaker", cite: B("desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx", 575, "Selects the in-pill End/Discard action row."), input: { surface: "notetaker", widget: { sessionId: 7, completed: false, showDiscard: true, levels: Array(11).fill(0) } }, interactions: interactive(control("keep", "click Keep recording", { showDiscard: false }), control("end", "click End", { event: "notetakerEndRequested" }), control("discard", "click Discard", { event: "notetakerDiscardRequested" })) },
  { id: "notetaker-completed", family: "notetaker", cite: B("desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx", 562, "Selects the exact Saved — preparing notes acknowledgment."), input: { surface: "notetaker", widget: { sessionId: 7, completed: true, showDiscard: false, levels: Array(11).fill(0) } }, interactions: none("The saved acknowledgment is shown for about 900ms before the host hides it.") },
  { id: "notetaker-meeting-notes-pending", family: "notetaker", cite: B("desktop/engine-overrides/renderer/notetaker/MeetingsList.tsx", 44, "Maps pending summary status to the exact Writing notes progress label."), input: { surface: "notetaker", page: "meetings", meeting: { id: "meeting-7", title: "Product sync", started_at: 1789101000000, ended_at: 1789102800000, duration_ms: 1800000, status: "ready", transcript_path: "/tmp/meeting-7.txt", audio_mic_path: "/tmp/meeting-7-mic.wav", audio_system_path: "/tmp/meeting-7-system.wav", cleanup_status: "success", summary_status: "pending", cleaned_transcript_path: "/tmp/meeting-7-clean.txt", notes_path: null } }, interactions: interactive(control("open-meeting", "click Product sync", { selectedId: "meeting-7" })) },
  { id: "notetaker-settings-unavailable", family: "notetaker", cite: B("desktop/engine-overrides/renderer/notetaker/NotetakerSettings.tsx", 65, "Shows provider guidance when neither Claude nor Codex is available."), input: { surface: "notetaker", page: "settings", settings: { enabled: true, provider: "claude", summary_prompt: null, availability: { claude: false, codex: false } } }, interactions: none("Both source provider buttons are disabled because neither provider is available.") },
  { id: "new-conversation-managed-preview", family: "new-conversation", cite: B(swift("NewConversationSetup.swift"), 62, "Shows effective access from an allocated managed-workspace preview."), input: { surface: "new-conversation", form: { provider: "codex", folder: null, query: "", submitted: false, permission: "maximum" }, pending: false, error: null, preview: { allocationId: "allocation-7", path: "/Users/zodpatel/.unmute/workspaces/allocation-7", permission: "workspace", permissionReason: "Managed workspace grants write access without approval prompts." } }, interactions: interactive(control("create", "click Create conversation", { type: "newChat", provider: "codex", cwd: null, allocationId: "allocation-7", permission: "maximum" })) },
  { id: "new-conversation-project-requested", family: "new-conversation", cite: B(swift("NewConversationSetup.swift"), 66, "Shows requested access until a selected project is validated at creation."), input: { surface: "new-conversation", form: { provider: "claude", folder: "/Users/zodpatel/work/checkout", query: "check", submitted: false, permission: "ask" }, pending: false, error: null, preview: null }, interactions: interactive(control("create", "click Create conversation", { type: "newChat", provider: "claude", cwd: "/Users/zodpatel/work/checkout", allocationId: null, permission: "ask" }), control("browse", "click Browse folder", { action: "openDirectoryPanel" })) },
  { id: "new-conversation-pending", family: "new-conversation", cite: B(swift("NewConversationSetup.swift"), 77, "Shows progress and disables cancel/create while creation is pending."), input: { surface: "new-conversation", form: { provider: "codex", folder: null, query: "", submitted: true, permission: "maximum" }, pending: true, error: null, preview: { allocationId: "allocation-7", path: "/Users/zodpatel/.unmute/workspaces/allocation-7", permission: "workspace", permissionReason: null } }, interactions: none("Creation is pending; source disables Cancel and Create conversation.") },
  { id: "new-conversation-error", family: "new-conversation", cite: B(swift("NewConversationSetup.swift"), 70, "Renders the exact host error and refresh-preview recovery control."), input: { surface: "new-conversation", form: { provider: "codex", folder: null, query: "", submitted: true, permission: "maximum" }, pending: false, error: "Managed workspace allocation expired", preview: null }, interactions: interactive(control("refresh", "click Refresh project preview", { type: "previewChat", provider: "codex", permission: "maximum" })) },
];

export async function auditSource() {
  const productHead = (await git(["rev-parse", "HEAD"])).trim();
  const listed = (await git(["ls-tree", "-r", "--name-only", SOURCE_REVISION])).trim().split("\n");
  const files = listed.filter((source) => (source.startsWith("desktop/native-notch/Sources/") && source.endsWith(".swift")) || TS_FILES.has(source) || (source.startsWith(TS_PREFIX) && /\.(?:ts|tsx)$/.test(source) && !/\.(?:test|spec)\./.test(source)));
  const report = { sourceRevision: SOURCE_REVISION, productHead, sourceDrift: productHead !== SOURCE_REVISION, files, enumCases: [], branches: [], sfSymbols: [], metrics: [], tokens: [], pillControlEmitSites: await controlEmitSites(), notchControlEmitSites: await notchControlEmitSites() };
  for (const source of files) {
    const scanned = scanSourceText(source, await git(["show", `${SOURCE_REVISION}:${source}`]));
    for (const category of ["enumCases", "branches", "sfSymbols", "metrics", "tokens"]) report[category].push(...scanned[category]);
  }
  return report;
}

export function pillPredicateOutcomes(input) {
  const s = input.state; const scratch = input.scratchpad;
  const chipsVisible = ["recording", "processing", "paused"].includes(s.phase);
  const isAgentLane = s.kind === "remote" && (s.agentOptions?.length ?? 0) === 0 && (s.modelOptions?.length ?? 0) === 0;
  return {
    selectorShowing: chipsVisible && input.viewState.selectorOpen && s.kind === "remote",
    "micOptions.count > 1": (s.micOptions?.length ?? 0) > 1,
    "!isAgentLane": !isAgentLane,
    "taskId == nil": s.taskId == null,
    "scratchpad enabled and visible/live": Boolean(scratch.enabled && (chipsVisible || (scratch.pad?.entries?.length ?? 0) > 0)),
    "waveform envelope <= 0": s.level <= 0,
  };
}

function pillReachability(input) {
  const s = input.state; const scratch = input.scratchpad; const p = pillPredicateOutcomes(input);
  const chipsVisible = ["recording", "processing", "paused"].includes(s.phase);
  return {
    chipsVisible,
    selectorShowing: p.selectorShowing,
    agentModelControl: chipsVisible && s.kind === "remote",
    micChip: chipsVisible && p["micOptions.count > 1"],
    scratchpadChip: p["scratchpad enabled and visible/live"],
    pad: (scratch.pad?.entries?.length ?? 0) > 0,
    waveform: s.phase === "recording" && s.maxSeconds - s.elapsed > 15,
    offlineCard: chipsVisible && s.offline != null,
  };
}

function branchCoverage(item, input) {
  const p = pillPredicateOutcomes(input); const r = pillReachability(input); let predicate = item.value; let outcome = true; const ancestors = [];
  if (item.source.endsWith("/PillView.swift")) {
    if (item.line === 250) { predicate = "selectorShowing"; outcome = p.selectorShowing; }
    else if (item.line === 414) { predicate = "micOptions.count > 1"; outcome = p["micOptions.count > 1"]; ancestors.push({ predicate: "chipsVisible", outcome: r.chipsVisible }); }
    else if (item.line === 896) { predicate = "!isAgentLane"; outcome = p["!isAgentLane"]; ancestors.push({ predicate: "agentModelControl", outcome: r.agentModelControl }); }
    else if (item.line === 972) { predicate = "taskId == nil"; outcome = p["taskId == nil"]; ancestors.push({ predicate: "selectorShowing", outcome: r.selectorShowing }); }
    else if (item.line >= 927 && item.line <= 1095) ancestors.push({ predicate: "selectorShowing", outcome: r.selectorShowing });
    else if (item.line >= 844 && item.line <= 921) ancestors.push({ predicate: "agentModelControl", outcome: r.agentModelControl });
    else if (item.line >= 1097 && item.line <= 1116) ancestors.push({ predicate: "micChip", outcome: r.micChip });
    else if (item.line >= 1254) ancestors.push({ predicate: "offlineCard", outcome: r.offlineCard });
    else if ([309, 314, 396, 413, 441, 449].includes(item.line)) ancestors.push({ predicate: "chipsVisible", outcome: r.chipsVisible });
    else if ([359, 368, 383].includes(item.line)) ancestors.push({ predicate: "pad", outcome: r.pad });
    if (item.line === 900) outcome = input.viewState.selectorOpen;
    if (item.line === 348) outcome = input.viewState.padExpanded;
    if (item.line === 540) outcome = input.state.maxSeconds - input.state.elapsed > 15;
    if ([758, 761, 762].includes(item.line)) outcome = input.viewState.hover?.pillRoundButton?.value ?? false;
    if (item.line === 431) { predicate = "scratchpad enabled and visible/live"; outcome = p["scratchpad enabled and visible/live"]; }
    const phaseAt = { 491: "hidden", 494: "recording", 562: "paused", 580: "processing", 605: "output", 613: "output-fallback", 626: "too-short", 632: "cancelled", 642: "error" };
    if (phaseAt[item.line]) outcome = input.state.phase === phaseAt[item.line];
    if (item.line === 538) outcome = input.state.maxSeconds - input.state.elapsed <= 15;
    if (item.line === 594 || item.line === 661) outcome = input.state.draftOffer;
    if (item.line === 596 || item.line === 662) outcome = !input.state.draftOffer && input.state.engineNotice;
    if (item.line === 598) outcome = !input.state.draftOffer && !input.state.engineNotice && input.state.showDiscardHint;
    if (item.line === 619) outcome = Boolean(input.state.outputPreview);
    if (item.line === 649) outcome = !(input.state.message ?? "").includes("limit reached");
    if (item.line === 441) outcome = Boolean(input.state.micStatus);
    if (item.line === 449) outcome = !input.state.micStatus && Boolean(input.state.coaching);
    if (item.line === 466) outcome = !p["!isAgentLane"];
    if (item.line === 481 || item.line === 482) outcome = ["recording", "processing"].includes(input.state.phase) && input.state.kind === "instruction";
    if (item.line === 957 || item.line === 977) outcome = (input.state.modelAxes?.length ?? 0) > 0;
    if (item.line === 983) outcome = !(input.state.modelAxes?.length ?? 0) && (input.state.modelOptions?.length ?? 0) > 0;
    if (item.line === 989) outcome = !(input.state.modelAxes?.length ?? 0) && !(input.state.modelOptions?.length ?? 0);
    if (item.line === 1017) outcome = (input.state.modelAxes ?? []).some(({ current }) => current != null);
    if (item.line === 1098 || item.line === 1113) outcome = (input.state.mic ?? "").includes("iphone");
    if (item.line === 1150 || item.line === 1154) outcome = input.scratchpad.armed;
    if (item.line === 1242) outcome = Boolean(input.state.coaching?.remedy || input.state.micStatus?.includes(" — "));
    if ([1263, 1266, 1268, 1282].includes(item.line)) outcome = input.state.offline === "payment_failed";
  } else if (item.source.endsWith("/Waveform.swift") && item.line <= 121) {
    predicate = "waveform envelope <= 0"; outcome = p["waveform envelope <= 0"]; ancestors.push({ predicate: "waveform", outcome: r.waveform });
  } else if (item.source.endsWith("/ProviderMark.swift") || item.source.endsWith("/ProviderMarkArt.swift")) {
    const provider = providerExpectation(input); predicate = item.value;
    if (item.source.endsWith("/ProviderMark.swift")) {
      if (item.line === 51 || item.line === 62 || item.line === 63) outcome = provider?.terminal ?? false;
      else if (item.line === 67) outcome = provider?.art === "embedded";
      else if (item.line === 79) outcome = provider?.art !== "embedded";
    } else if ([87, 88, 89, 90].includes(item.line)) outcome = providerNameCaseOutcome(provider?.backend, item.line);
  }
  return { predicate, outcome, ancestors };
}

export function providerExpectation(input) {
  const selected = input.state.agentOptions?.find((option) => option.label === (input.state.agent ?? ""));
  if (!selected) return null;
  const backend = selected.id; const vendor = backend === "codex" || backend === "codex-desktop" ? "codex" : "claude";
  const names = { codex: "Codex CLI", "codex-desktop": "Codex desktop", "claude-code-desktop": "Claude desktop" };
  return { backend, vendor, name: names[backend] ?? "Claude Code CLI", terminal: selected.terminal ?? true, art: "embedded" };
}

export function providerNameCaseOutcome(backend, line) {
  if (line === 87) return backend === "codex";
  if (line === 88) return backend === "codex-desktop";
  if (line === 89) return backend === "claude-code-desktop";
  if (line === 90) return !["codex", "codex-desktop", "claude-code-desktop"].includes(backend);
  throw new Error(`Unknown ProviderMarkArt.name branch line: ${line}`);
}

function notchPredicateOutcomes(input) {
  const { model, geometry, controller } = input;
  const collapsed = !["task", "cockpit"].includes(model.state);
  const resolved = resolveBar({ ...model, silenced: [] });
  const hasRecentGesture = controller.lastGestureAgeSeconds != null && controller.lastGestureAgeSeconds < 6;
  return {
    "toast visible while collapsed": Boolean(model.toast && model.toast.length > 0 && collapsed),
    "agent activity visible while collapsed": Boolean(model.agentActivity && collapsed),
    "capturePhase == routing while collapsed": model.capturePhase === "routing" && collapsed,
    "pocket waiting while closed and collapsed": model.pocket.waiting > 0 && collapsed && model.pocket.mode !== "open",
    hovering: model.hovering,
    "content signature silenced": !model.hovering && collapsed && model.silenced.includes(resolved.signature),
    hasNotch: geometry.hasNotch,
    "right segment fits": input.expectation.geometry.allocatedRightWidth === input.expectation.geometry.wantedRightWidth,
    "auto-present permits expansion": controller.autoPresent || controller.surfaceIsAlreadyExpanded || hasRecentGesture,
    "expanded automatic departure": ["task", "cockpit"].includes(model.state) && controller.departureTransition.phase === "awaitingCompact",
  };
}

const NOTCH_STATE_CASES = new Map([[230, ["dormant"]], [235, ["idle"]], [257, ["active"]], [275, ["attention"]], [285, ["task", "cockpit"]]]);
function earlyReturnAncestors(input) {
  return [
    { predicate: "toast branch not selected", outcome: input.expectation.bar.selected !== "toast" },
    { predicate: "agent activity branch not selected", outcome: input.expectation.bar.selected !== "agentActivity" },
    { predicate: "routing branch not selected", outcome: input.expectation.bar.selected !== "routing" },
    { predicate: "pocket branch not selected", outcome: input.expectation.bar.selected !== "pocket" },
  ];
}
function selectedCaseAncestor(input) {
  return { predicate: `NotchState case ${input.model.state} selected`, outcome: true };
}
export function evaluateNotchBranch(item, input) {
  const p = notchPredicateOutcomes(input); let predicate = item.value; let outcome = false; const ancestors = [];
  if (item.source.endsWith("/BarContent.swift")) {
    if (item.line === 145) { predicate = "content signature silenced"; outcome = p[predicate]; }
    if (item.line === 158) { predicate = "toast visible while collapsed"; outcome = p[predicate]; }
    if (item.line === 161 || (item.line >= 165 && item.line <= 170)) { predicate = item.line === 161 ? "agent activity visible while collapsed" : item.value; outcome = item.line === 161 ? p["agent activity visible while collapsed"] : input.model.agentActivity?.state === ["listening", "searching", "thinking", "confirming", "complete", "failed"][item.line - 165]; ancestors.push({ predicate: "toast branch not selected", outcome: input.expectation.bar.selected !== "toast" }); if (item.line !== 161) ancestors.push({ predicate: "agent activity visible while collapsed", outcome: p["agent activity visible while collapsed"] }); }
    if (item.line === 189) { predicate = "capturePhase == routing while collapsed"; outcome = p[predicate]; ancestors.push({ predicate: "toast branch not selected", outcome: input.expectation.bar.selected !== "toast" }, { predicate: "agent activity branch not selected", outcome: input.expectation.bar.selected !== "agentActivity" }); }
    if (item.line === 210 || item.line === 224) { predicate = item.line === 224 ? "hovering && first slot exists" : "pocket waiting while closed and collapsed"; outcome = item.line === 224 ? input.model.hovering && input.model.pocket.slots.length > 0 : p["pocket waiting while closed and collapsed"]; ancestors.push({ predicate: "toast branch not selected", outcome: input.expectation.bar.selected !== "toast" }, { predicate: "agent activity branch not selected", outcome: input.expectation.bar.selected !== "agentActivity" }, { predicate: "routing branch not selected", outcome: input.expectation.bar.selected !== "routing" }); if (item.line === 224) ancestors.push({ predicate: "pocket waiting while closed and collapsed", outcome: p["pocket waiting while closed and collapsed"] }); }
    if (item.line === 247) { predicate = "!hasNotch && !hovering"; outcome = input.model.state === "idle" && !p.hasNotch && !p.hovering; ancestors.push(...earlyReturnAncestors(input), selectedCaseAncestor(input)); }
    if (item.line === 270) { predicate = "single processing task"; outcome = input.model.state === "active" && input.model.working === 1 && input.model.task?.status === "processing"; ancestors.push(...earlyReturnAncestors(input), selectedCaseAncestor(input)); }
    if (NOTCH_STATE_CASES.has(item.line)) {
      const accepted = NOTCH_STATE_CASES.get(item.line);
      predicate = accepted.map((state) => `state == .${state}`).join(" || ");
      outcome = accepted.includes(input.model.state);
      ancestors.push(...earlyReturnAncestors(input), selectedCaseAncestor(input));
    }
  } else if (item.source.endsWith("/NotchView.swift")) {
    if (item.line === 224) { predicate = "expanded or open-pocket glass tone"; outcome = (["task", "cockpit"].includes(input.model.state) || input.model.pocket.mode === "open") && input.appearance.tone === "glass"; }
  } else if (item.source.endsWith("/AppController.swift")) {
    if (item.line === 1096 || item.line === 1100) { predicate = "auto-present permits expansion"; outcome = p[predicate]; }
    if (item.line === 1821) { predicate = "return from automatic departure"; outcome = input.controller.departureTransition.phase === "returning"; }
    if (item.line === 1857) { predicate = "expanded automatic departure"; outcome = p[predicate]; }
  }
  return { predicate, outcome, ancestors };
}

const notchBranchCoverage = evaluateNotchBranch;

export function createInventory(raw) {
  const occurrences = ["enumCases", "branches", "sfSymbols", "metrics", "tokens"].flatMap((category) => raw[category]);
  const occurrenceByLocation = new Map(occurrences.map((item) => [`${item.source}:${item.line}`, item]));
  const fixtures = {}; const entries = []; const linked = new Map();
  const nonvisual = new Map([
    [`${swift("PillModel.swift")}:276`, "Serializes PillEvent.stop to the pillStop IPC payload; this branch transports an event and does not render pixels."],
    [`${swift("PillModel.swift")}:277`, "Serializes PillEvent.cancel to the pillCancel IPC payload; this branch transports an event and does not render pixels."],
    [`${swift("PillModel.swift")}:278`, "Serializes PillEvent.undo to the pillUndo IPC payload; this branch transports an event and does not render pixels."],
    ["desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx:446", "Handles the zero-sample divisor while calculating waveform amplitude from audio samples; it protects DSP math and does not select a UI state."],
    ["desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx:451", "Applies the 0.08 audio noise floor before waveform amplitude reaches rendering; this is DSP normalization, not a render state."],
    ["desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx:459", "Chooses attack or release smoothing for audio samples; it changes waveform motion data but does not select a UI state."],
  ]);
  for (const state of STATES) {
    const auditItem = occurrenceByLocation.get(`${state.cite.source}:${state.cite.line}`);
    if (!auditItem) throw new Error(`Missing curated citation for ${state.id}: ${state.cite.source}:${state.cite.line}`);
    const fixture = `fixture-${state.id}`;
    fixtures[fixture] = { stateId: state.id, input: state.input };
    const primaryCoverage = state.family === "pill" && auditItem.id.startsWith("branch:") ? branchCoverage(auditItem, state.input) : state.family === "notch" && auditItem.id.startsWith("branch:") ? notchBranchCoverage(auditItem, state.input) : {};
    entries.push({ id: state.id, family: state.family, source: auditItem.source, symbol: auditItem.symbol, condition: auditItem.value, fixture, interactions: state.interactions, ...(state.expectations ? { expectations: state.expectations } : {}), baseline: { status: "pending", reason: "Task 2 creates and verifies the native baseline artifact." }, audit: [{ id: auditItem.id, contribution: state.cite.contribution, ...primaryCoverage }] });
    const links = linked.get(auditItem.id) ?? []; links.push({ stateId: state.id, contribution: state.cite.contribution }); linked.set(auditItem.id, links);
  }
  for (const entry of entries.filter(({ family }) => family === "pill")) {
    const input = fixtures[entry.fixture].input; const outcomes = pillPredicateOutcomes(input); const reachable = pillReachability(input);
    entry.predicates = [
      { predicate: "selectorShowing", outcome: outcomes.selectorShowing, source: swift("PillView.swift"), line: 229 },
      ...(reachable.chipsVisible ? [{ predicate: "micOptions.count > 1", outcome: outcomes["micOptions.count > 1"], source: swift("PillView.swift"), line: 414 }] : []),
      ...(reachable.agentModelControl ? [{ predicate: "!isAgentLane", outcome: outcomes["!isAgentLane"], source: swift("PillView.swift"), line: 896 }] : []),
      ...(reachable.selectorShowing ? [{ predicate: "taskId == nil", outcome: outcomes["taskId == nil"], source: swift("PillView.swift"), line: 972 }] : []),
      { predicate: "scratchpad enabled and visible/live", outcome: outcomes["scratchpad enabled and visible/live"], source: swift("PillView.swift"), line: 431 },
      ...(reachable.waveform ? [{ predicate: "waveform envelope <= 0", outcome: outcomes["waveform envelope <= 0"], source: swift("Waveform.swift"), line: 77 }] : []),
    ];
  }
  for (const entry of entries.filter(({ family }) => family === "notch")) {
    const input = fixtures[entry.fixture].input; const outcomes = notchPredicateOutcomes(input);
    entry.predicates = Object.entries(outcomes).map(([predicate, outcome]) => ({ predicate, outcome, source: predicate.includes("departure") || predicate.includes("auto-present") ? swift("AppController.swift") : predicate === "hasNotch" || predicate === "right segment fits" ? swift("NotchGeometry.swift") : swift("BarContent.swift"), line: predicate.includes("departure") ? 1857 : predicate.includes("auto-present") ? 1097 : predicate === "hasNotch" ? 185 : predicate === "right segment fits" ? 214 : predicate === "hovering" ? 224 : predicate.includes("silenced") ? 145 : predicate.startsWith("toast") ? 158 : predicate.startsWith("agent") ? 161 : predicate.startsWith("capture") ? 189 : 210 }));
  }
  const attach = (item, stateId, contribution) => {
    const entry = entries.find(({ id }) => id === stateId);
    if (!entry || entry.audit.some(({ id }) => id === item.id)) return;
    const coverage = entry.family === "pill" && item.id.startsWith("branch:") ? branchCoverage(item, fixtures[entry.fixture].input) : {};
    entry.audit.push({ id: item.id, contribution, ...coverage });
    const links = linked.get(item.id) ?? []; links.push({ stateId, contribution }); linked.set(item.id, links);
  };
  for (const item of raw.enumCases) {
    const notchEnumLinks = {
      NotchState: { dormant: "notch-dormant-hardware", idle: "notch-idle-wordmark", active: "notch-active-task-activity", attention: "notch-attention-needs-user", task: "notch-task-expanded", cockpit: "notch-cockpit-expanded" },
      TaskStatus: { processing: "notch-attention-processing", needsUser: "notch-attention-needs-user", ready: "notch-attention-ready", stuck: "notch-attention-stuck", done: "notch-attention-done", failed: "notch-attention-failed" },
      AgentActivityState: { listening: "notch-agent-listening", searching: "notch-agent-searching", thinking: "notch-agent-thinking", confirming: "notch-agent-confirming", complete: "notch-agent-complete", failed: "notch-agent-failed" },
    };
    const stateId = item.symbol === "PillPhase" ? PILL_PHASE_LINKS[item.value] : item.symbol === "PillKind" ? PILL_KIND_LINKS[item.value] : item.symbol === "PillOfflineReason" ? PILL_OFFLINE_LINKS[item.value] : notchEnumLinks[item.symbol]?.[item.value] ?? null;
    if (stateId) attach(item, stateId, `The source enum input ${item.symbol}.${item.value} selects the concrete ${stateId} fixture.`);
  }
  for (const item of raw.branches) {
    let stateId = null;
    if (item.source.endsWith("/PillView.swift") && EVALUABLE_PILL_LINES.has(item.line)) stateId = PILL_VIEW_LINKS[item.line];
    else if (item.source.endsWith("/Waveform.swift")) stateId = WAVEFORM_LINKS[item.line];
    else if (item.source.endsWith("/ProviderMark.swift") || item.source.endsWith("/ProviderMarkArt.swift")) stateId = PROVIDER_LINKS[item.line];
    if (stateId) attach(item, stateId, `The source render condition '${item.value}' contributes the visible configuration captured by ${stateId}.`);
  }
  const classifications = occurrences.map((item) => {
    const links = linked.get(item.id) ?? [];
    if (links.length) return { occurrenceId: item.id, kind: "render-affecting", stateIds: links.map(({ stateId }) => stateId), reason: links.map(({ stateId, contribution }) => `${stateId}: ${contribution}`).join(" ") };
    const category = item.id.split(":", 1)[0];
    const nonvisualReason = nonvisual.get(`${item.source}:${item.line}`);
    if (nonvisualReason) return { occurrenceId: item.id, kind: "non-rendering", stateIds: [], reason: `${nonvisualReason} Audited occurrence: ${item.kind ?? category} '${item.value}' in ${item.symbol} at ${item.source}:${item.line}.` };
    if (["sf-symbol", "metric", "token"].includes(category)) return { occurrenceId: item.id, kind: "render-affecting", stateIds: [], reason: `${category} '${item.value}' in ${item.symbol} at ${item.source}:${item.line} is shared visual evidence; it changes asset, geometry, typography, color, or material but does not independently define a state.` };
    if (category === "enum") return { occurrenceId: item.id, kind: "render-input", stateIds: [], reason: `Enum case '${item.value}' of ${item.symbol} at ${item.source}:${item.line} is retained as a source-model input; no standalone fixture is claimed without a render predicate.` };
    return { occurrenceId: item.id, kind: "render-input", stateIds: [], reason: `Conditional ${item.kind} '${item.value}' in ${item.symbol} at ${item.source}:${item.line} is retained as a source-model input or composition predicate; no standalone state or backlink is claimed without hand-curated evidence.` };
  });
  return { manifest: { sourceRevision: raw.sourceRevision, fixtures, entries }, evidence: { ...raw, classifications } };
}

export function validateManifest(manifest, evidence) {
  const errors = []; const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const occurrences = ["enumCases", "branches", "sfSymbols", "metrics", "tokens"].flatMap((category) => evidence[category] ?? []);
  const occurrenceById = new Map(occurrences.map((item) => [item.id, item]));
  const classificationById = new Map((evidence.classifications ?? []).map((item) => [item.occurrenceId, item]));
  const entryById = new Map(); const fixtures = manifest.fixtures ?? {};
  if (!manifest.sourceRevision) errors.push("Missing source revision");
  else if (manifest.sourceRevision !== evidence.sourceRevision) errors.push("Source revision does not match audit evidence");
  if (evidence.sourceDrift) errors.push(`Product source drift: expected ${evidence.sourceRevision}, found ${evidence.productHead}`);
  for (const entry of entries) {
    if (entryById.has(entry.id)) errors.push(`Duplicate entry id: ${entry.id}`); entryById.set(entry.id, entry);
    if (!entry.source || !entry.symbol || !entry.condition) errors.push(`Absent citation on entry: ${entry.id}`);
    const fixture = fixtures[entry.fixture];
    if (!fixture) errors.push(`Unknown fixture id ${entry.fixture} on entry ${entry.id}`);
    else { if (fixture.stateId !== entry.id) errors.push(`Fixture backlink mismatch for ${entry.id}`); if (!fixture.input || typeof fixture.input.surface !== "string" || Object.keys(fixture.input).length < 2) errors.push(`Invalid fixture input for ${entry.id}`); }
    if (!entry.interactions || !["interactive", "none"].includes(entry.interactions.kind)) errors.push(`Invalid interactions for ${entry.id}`);
    else if (entry.interactions.kind === "interactive" && (!entry.interactions.controls?.length || !entry.interactions.controls.every((item) => item.id && item.event && item.result && typeof item.result === "object"))) errors.push(`Invalid interactions for ${entry.id}`);
    else if (entry.interactions.kind === "none" && !entry.interactions.reason) errors.push(`Invalid interactions reason for ${entry.id}`);
    if (!entry.baseline || entry.baseline.status !== "pending" || !entry.baseline.reason) errors.push(`Invalid baseline for ${entry.id}`);
    if (!entry.audit?.length) errors.push(`Missing audit backlink for ${entry.id}`);
    for (const link of entry.audit ?? []) { const id = link?.id; const item = occurrenceById.get(id); if (!item) errors.push(`Unknown audit id ${id ?? link} on ${entry.id}`); if (!link?.contribution) errors.push(`Missing audit contribution for ${entry.id}`); if (!classificationById.get(id)?.stateIds.includes(entry.id)) errors.push(`Audit backlink mismatch for ${entry.id}: ${id}`); }
    const primary = occurrenceById.get(entry.audit?.[0]?.id); if (primary && (entry.source !== primary.source || entry.symbol !== primary.symbol || entry.condition !== primary.value)) errors.push(`Citation agreement failure for ${entry.id}`);
    if (entry.family === "pill" && fixture) {
      const input = fixture.input; const s = input.state ?? {};
      const allowedViewKeys = new Set(["selectorOpen", "padExpanded", "hover"]);
      if (!input.viewState || typeof input.viewState.selectorOpen !== "boolean" || Object.keys(input.viewState ?? {}).some((key) => !allowedViewKeys.has(key)) || Object.values(input.viewState?.hover ?? {}).some((hover) => typeof hover.value !== "boolean" || hover.provenance?.source !== swift("PillView.swift") || !Number.isInteger(hover.provenance?.line)) || "openMenu" in input || "presentation" in input) errors.push(`Invalid Pill local view state for ${entry.id}`);
      if (s.coaching && (typeof s.coaching.condition !== "string" || !("remedy" in s.coaching) || !("level" in s.coaching) || "kind" in s.coaching)) errors.push(`Invalid Pill coaching schema for ${entry.id}`);
      if (!(s.modelAxes ?? []).every((axis) => typeof axis.axis === "string" && Array.isArray(axis.values) && "current" in axis && !("id" in axis) && !("options" in axis))) errors.push(`Invalid Pill axis schema for ${entry.id}`);
      if (!(s.micOptions ?? []).every((option) => option && typeof option === "object" && typeof option.id === "string" && typeof option.label === "string")) errors.push(`Invalid Pill mic option schema for ${entry.id}`);
      if (!(entry.predicates ?? []).every((item) => typeof item.predicate === "string" && typeof item.outcome === "boolean" && item.source && Number.isInteger(item.line))) errors.push(`Invalid Pill predicate coverage for ${entry.id}`);
      const outcomes = pillPredicateOutcomes(input);
      for (const item of entry.predicates ?? []) if (outcomes[item.predicate] !== item.outcome) errors.push(`Pill predicate outcome mismatch for ${entry.id}:${item.predicate}`);
      for (const link of entry.audit.filter(({ id }) => id.startsWith("branch:"))) {
        const occurrence = occurrenceById.get(link.id); const expected = occurrence && branchCoverage(occurrence, input);
        if (!expected || link.predicate !== expected.predicate || link.outcome !== expected.outcome || JSON.stringify(link.ancestors) !== JSON.stringify(expected.ancestors) || link.ancestors.some(({ outcome }) => !outcome)) errors.push(`Pill branch outcome or ancestor reachability mismatch for ${entry.id}:${link.id}`);
      }
      if (entry.expectations?.providerMark && JSON.stringify(entry.expectations.providerMark) !== JSON.stringify(providerExpectation(input))) errors.push(`Provider expectation mismatch for ${entry.id}`);
      for (const item of entry.interactions.controls ?? []) if (!(evidence.pillControlEmitSites ?? []).some((site) => site.type === item.result.type && site.line === item.provenance?.line) || item.provenance?.source !== swift("PillView.swift")) errors.push(`Invalid Pill control provenance for ${entry.id}:${item.id}`);
    }
    if (entry.family === "notch" && fixture) {
      const input = fixture.input; const allowed = ["appearance", "controller", "expectation", "geometry", "model", "surface", "viewState"];
      if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(allowed.sort()) || input.surface !== "notch") errors.push(`Invalid Notch fixture partition for ${entry.id}`);
      if (!input.model || !input.geometry || !input.appearance || !input.controller || !input.viewState) errors.push(`Incomplete Notch fixture for ${entry.id}`);
      if (input.model.state === "dormant" && !input.geometry.hasNotch) errors.push(`Unreachable stable off-notch dormant fixture for ${entry.id}`);
      const expectedBar = resolveBar(input.model); const expectedGeometry = geometryExpectation(input.model, input.geometry, expectedBar);
      if (JSON.stringify(input.expectation?.bar) !== JSON.stringify(expectedBar) || JSON.stringify(input.expectation?.geometry) !== JSON.stringify(expectedGeometry)) errors.push(`Notch derived expectation mismatch for ${entry.id}`);
      if (input.model.task && JSON.stringify(input.expectation?.taskStatus) !== JSON.stringify(STATUS[input.model.task.status])) errors.push(`Notch TaskStatus behavior mismatch for ${entry.id}`);
      if (input.model.agentActivity) { const terminal = ["complete", "failed"].includes(input.model.agentActivity.state); if (JSON.stringify(input.expectation?.agentTiming) !== JSON.stringify({ terminal, clearAfterSeconds: terminal ? 2.2 : null })) errors.push(`Notch Agent timing mismatch for ${entry.id}`); }
      if ("rightAllocation" in input.geometry || "recentExplicitGesture" in input.controller || "departure" in input.controller || "reduceTransparency" in input.appearance) errors.push(`Invented Notch projection for ${entry.id}`);
      const outcomes = notchPredicateOutcomes(input);
      for (const item of entry.predicates ?? []) if (typeof item.outcome !== "boolean" || outcomes[item.predicate] !== item.outcome) errors.push(`Notch predicate outcome mismatch for ${entry.id}:${item.predicate}`);
      for (const link of entry.audit.filter(({ id }) => id.startsWith("branch:"))) {
        const occurrence = occurrenceById.get(link.id); const expected = occurrence && notchBranchCoverage(occurrence, input);
        if (!expected || link.predicate !== expected.predicate || link.outcome !== expected.outcome || JSON.stringify(link.ancestors) !== JSON.stringify(expected.ancestors) || link.ancestors.some(({ outcome }) => !outcome)) errors.push(`Notch branch outcome or ancestor reachability mismatch for ${entry.id}:${link.id}`);
      }
      for (const item of entry.interactions.controls ?? []) if (!(evidence.notchControlEmitSites ?? []).some((site) => site.type === item.result.type && site.source === item.provenance?.source && site.line === item.provenance?.line)) errors.push(`Invalid Notch control provenance for ${entry.id}:${item.id}`);
    }
  }
  for (const [id, fixture] of Object.entries(fixtures)) if (!entryById.has(fixture.stateId) || entryById.get(fixture.stateId).fixture !== id) errors.push(`Orphan fixture: ${id}`);
  for (const item of occurrences) { const classification = classificationById.get(item.id); if (!classification) errors.push(`Unclassified audited occurrence: ${item.id}`); else { if (!classification.reason) errors.push(`Missing classification reason: ${item.id}`); for (const stateId of classification.stateIds) { const entry = entryById.get(stateId); if (!entry) errors.push(`Unknown state backlink ${stateId} on ${item.id}`); else if (!entry.audit.some((link) => link.id === item.id)) errors.push(`Missing audit backlink ${item.id} on ${stateId}`); } } }
  for (const classification of evidence.classifications ?? []) if (!occurrenceById.has(classification.occurrenceId)) errors.push(`Classification references unknown audit id: ${classification.occurrenceId}`);
  return errors;
}

async function main() {
  const inventory = createInventory(await auditSource());
  if (process.argv.includes("--write")) { const directory = new URL("../fixtures/", import.meta.url); await mkdir(directory, { recursive: true }); await Promise.all([writeFile(new URL("manifest.json", directory), `${JSON.stringify(inventory.manifest, null, 2)}\n`), writeFile(new URL("audit.json", directory), `${JSON.stringify(inventory.evidence, null, 2)}\n`)]); return; }
  process.stdout.write(`${JSON.stringify(process.argv.includes("--manifest") ? inventory.manifest : inventory.evidence, null, 2)}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
