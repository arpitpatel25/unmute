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
const control = (id, event, result) => ({ id, event, result });
const none = (reason) => ({ kind: "none", reason });
const interactive = (...controls) => ({ kind: "interactive", controls });
const pillBase = (state) => ({ surface: "pill", openMenu: null, state });
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
  input: { ...pillBase({ ...pillDefaults, ...state }), presentation: { controlState: "resting", agentRim: false }, scratchpad: { enabled: false, armed: false, visible: false, pad: null }, ...extra }, interactions,
});
const recordControls = interactive(control("discard", "click discard", { type: "pillCancel" }), control("finish", "click finish", { type: "pillStop" }));
const agentOptions = [
  { id: "claude", label: "Claude Code", detail: "Anthropic CLI", available: true, terminal: true },
  { id: "codex-desktop", label: "Codex", detail: "OpenAI desktop", available: false, terminal: false },
];
const modelOptions = [{ id: "sonnet", label: "Claude Sonnet 4.5" }, { id: "opus", label: "Claude Opus 4.1" }];
const modelAxes = [
  { id: "model", label: "Model", current: "gpt-5.3-codex", options: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }, { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" }] },
  { id: "effort", label: "Effort", current: "high", options: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }] },
];
const PILL_STATES = [
  pillState("pill-hidden", 491, { phase: "hidden" }, none("The hidden phase deliberately renders no Pill or source-defined control.")),
  pillState("pill-recording-waveform-16", 540, { phase: "recording", level: 0.64, elapsed: 284 }, recordControls),
  pillState("pill-recording-cancel-hover", 758, { phase: "recording", level: 0.64, elapsed: 24 }, recordControls, { presentation: { pillHover: true, cancelHover: true } }),
  pillState("pill-recording-countdown-15", 538, { phase: "recording", level: 0.64, elapsed: 285 }, recordControls),
  pillState("pill-recording-countdown-zero", 538, { phase: "recording", elapsed: 300 }, recordControls),
  pillState("pill-recording-instruction", 481, { phase: "recording", kind: "instruction", level: 0.42, elapsed: 8 }, recordControls),
  pillState("pill-recording-remote-warning", 396, { phase: "recording", kind: "remote", taskId: "task-42", level: 0.64, elapsed: 286, agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions, micOptions: ["mac", "iphone"], mic: "mac" }, recordControls),
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
  pillState("pill-hint-mic-precedence", 441, { phase: "recording", micStatus: "AirPods — Move closer", coaching: { kind: "quiet", remedy: "Speak louder" } }, recordControls),
  pillState("pill-hint-coaching-quiet", 449, { phase: "recording", coaching: { kind: "quiet", remedy: "Speak louder" } }, recordControls),
  pillState("pill-hint-coaching-noisy", 449, { phase: "recording", coaching: { kind: "noisy", remedy: "Move somewhere quieter" } }, recordControls),
  pillState("pill-selector-closed", 250, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("selector", "click Agent and model", { type: "pillSelectorOpen", menu: "model" }))),
  pillState("pill-selector-list", 983, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("model-opus", "click Claude Opus 4.1", { type: "pillPickModel", value: "opus" }), control("agent-codex", "click Codex", { type: "pillPickAgent", value: "codex-desktop" })), { openMenu: "model", presentation: { controlState: "hover", agentRim: false } }),
  pillState("pill-selector-row-unselected-hover", 1088, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("model-opus", "click Claude Opus 4.1", { type: "pillPickModel", value: "opus" })), { openMenu: "model", presentation: { selectorRow: "unselected-hover" } }),
  pillState("pill-selector-codex-axes", 977, { phase: "recording", kind: "remote", agent: "Codex", agentOptions, model: "GPT-5.3 Codex · High", modelAxes }, interactive(control("axis-model", "click GPT-5.2 Codex", { type: "pillPickAxis", axis: "model", value: "gpt-5.2-codex" }), control("axis-effort", "click Medium", { type: "pillPickAxis", axis: "effort", value: "medium" })), { openMenu: "model" }),
  pillState("pill-selector-empty", 989, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, modelEmpty: "No models available" }, interactive(control("agent-cycle", "click Agent control", { type: "pillCycleAgent" })), { openMenu: "model" }),
  pillState("pill-selector-task-addressed", 972, { phase: "recording", kind: "remote", taskId: "task-42", agent: "Claude Code", agentOptions, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("model-opus", "click Claude Opus 4.1", { type: "pillPickModel", value: "opus", taskId: "task-42" })), { openMenu: "model" }),
  pillState("pill-agent-disconnected", 865, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, agentConnected: false, model: "Claude Sonnet 4.5", modelOptions }, interactive(control("agent-claude", "click Claude Code", { type: "pillPickAgent", value: "claude" })), { openMenu: "model" }),
  pillState("pill-agent-lane-processing", 896, { phase: "processing", kind: "remote", agent: "Codex", agentOptions: [], modelOptions: [] }, none("Agent lane disables selector hit testing while retaining the full-cluster rim."), { presentation: { controlState: "disabled", agentRim: true } }),
  pillState("pill-provider-terminal", 896, { phase: "recording", kind: "remote", agent: "Claude Code", agentOptions, modelOptions }, interactive(control("agent-cycle", "click Agent control", { type: "pillCycleAgent" })), { presentation: { controlState: "pressed", agentRim: false, providerMark: { backend: "claude", terminal: true } } }),
  pillState("pill-provider-fallback", 1077, { phase: "recording", kind: "remote", agent: "Local Agent", agentOptions: [{ id: "local", label: "Local Agent", detail: "Custom backend", available: true, terminal: false }], modelOptions }, interactive(control("agent-local", "click Local Agent", { type: "pillPickAgent", value: "local" })), { openMenu: "model", presentation: { controlState: "resting", agentRim: false, providerMark: { backend: "local", terminal: false, fallback: "LA" } } }),
  pillState("pill-mic-iphone", 414, { phase: "recording", micOptions: ["mac", "iphone"], mic: "iphone" }, interactive(control("mic", "click iPhone mic", { type: "pillPickMic", value: "mac" }))),
  pillState("pill-mic-mac", 1113, { phase: "recording", micOptions: ["mac", "iphone"], mic: "mac" }, interactive(control("mic", "click Mac mic", { type: "pillPickMic", value: "iphone" }))),
  pillState("pill-mic-single-suppressed", 414, { phase: "recording", micOptions: ["mac"], mic: "mac" }, recordControls),
  pillState("pill-raw-enabled", 431, { phase: "recording", raw: true }, interactive(control("raw", "toggle raw off", { type: "pillToggleRaw", value: false }))),
  pillState("pill-scratchpad-armed", 431, { phase: "paused" }, interactive(control("scratchpad", "click scratchpad", { type: "scratchpadArm", value: false })), { scratchpad: { enabled: true, armed: true, visible: true, pad: { id: "pad-7", origin: "dictation", entries: [] } } }),
  pillState("pill-scratchpad-unarmed", 1154, { phase: "recording" }, interactive(control("scratchpad", "click scratchpad", { type: "scratchpadArm", value: true })), { scratchpad: { enabled: true, armed: false, visible: false, pad: null } }),
  pillState("pill-scratchpad-expanded", 348, { phase: "paused", offline: "cloud_unreachable" }, interactive(control("scratchpad-collapse", "click collapse", { type: "scratchpadCollapse" })), { presentation: { padExpanded: true }, scratchpad: { enabled: true, armed: true, visible: true, pad: { id: "pad-7", origin: "dictation", entries: [{ id: "entry-1", kind: "text", text: "Keep this thought" }] } } }),
];
const PILL_PHASE_LINKS = { hidden: "pill-hidden", recording: "pill-recording-waveform-16", paused: "pill-paused", processing: "pill-processing-default", output: "pill-output", outputFallback: "pill-output-fallback-default", tooShort: "pill-too-short-default", cancelled: "pill-cancelled", error: "pill-error-default" };
const PILL_KIND_LINKS = { dictation: "pill-recording-waveform-16", instruction: "pill-recording-instruction", remote: "pill-recording-remote-warning" };
const PILL_OFFLINE_LINKS = { notSignedIn: "pill-offline-not-signed-in", noSubscription: "pill-offline-no-subscription", paymentFailed: "pill-payment-failed", cloudUnreachable: "pill-offline-cloud-unreachable", choseOnDevice: "pill-offline-on-device" };
const PILL_VIEW_LINKS = {
  54: "pill-recording-waveform-16", 55: "pill-recording-waveform-16", 65: "pill-recording-waveform-16", 69: "pill-recording-waveform-16", 73: "pill-recording-waveform-16", 102: "pill-recording-waveform-16", 169: "pill-agent-lane-processing",
  250: "pill-selector-list", 309: "pill-recording-waveform-16", 310: "pill-selector-list", 314: "pill-payment-failed", 348: "pill-scratchpad-expanded", 359: "pill-scratchpad-armed", 368: "pill-scratchpad-armed", 383: "pill-scratchpad-expanded", 396: "pill-recording-remote-warning", 413: "pill-mic-iphone", 414: "pill-mic-single-suppressed", 431: "pill-scratchpad-armed", 441: "pill-hint-mic-precedence", 449: "pill-hint-coaching-quiet",
  466: "pill-agent-lane-processing", 472: "pill-error-default", 473: "pill-output-fallback-default", 481: "pill-recording-instruction", 482: "pill-recording-instruction", 483: "pill-output", 491: "pill-hidden", 494: "pill-recording-waveform-16", 538: "pill-recording-countdown-15", 540: "pill-recording-waveform-16", 562: "pill-paused", 580: "pill-processing-default", 594: "pill-processing-draft", 596: "pill-processing-on-device", 598: "pill-processing-discard-hint", 605: "pill-output", 613: "pill-output-fallback-default", 619: "pill-output-fallback-preview", 626: "pill-too-short-custom", 632: "pill-cancelled", 642: "pill-error-default", 649: "pill-error-limit", 661: "pill-processing-draft", 662: "pill-processing-on-device", 675: "pill-processing-default", 690: "pill-processing-default", 707: "pill-recording-countdown-15", 710: "pill-recording-countdown-15", 758: "pill-recording-cancel-hover", 761: "pill-recording-cancel-hover", 762: "pill-recording-cancel-hover", 782: "pill-processing-draft", 783: "pill-cancelled", 786: "pill-processing-draft", 787: "pill-cancelled", 788: "pill-cancelled",
  865: "pill-agent-disconnected", 867: "pill-agent-disconnected", 869: "pill-agent-disconnected", 882: "pill-agent-disconnected", 884: "pill-selector-closed", 896: "pill-agent-lane-processing", 900: "pill-selector-list", 957: "pill-selector-codex-axes", 972: "pill-selector-task-addressed", 977: "pill-selector-codex-axes", 983: "pill-selector-list", 985: "pill-selector-list", 989: "pill-selector-empty", 1017: "pill-selector-codex-axes", 1072: "pill-selector-list", 1077: "pill-provider-fallback", 1083: "pill-selector-list", 1087: "pill-selector-list", 1088: "pill-selector-row-unselected-hover", 1098: "pill-mic-iphone", 1113: "pill-mic-mac", 1150: "pill-scratchpad-armed", 1154: "pill-scratchpad-unarmed", 1242: "pill-selector-list", 1263: "pill-payment-failed", 1266: "pill-payment-failed", 1268: "pill-payment-failed", 1282: "pill-payment-failed",
};
const PROVIDER_LINKS = { 21: "pill-provider-terminal", 37: "pill-provider-terminal", 51: "pill-provider-terminal", 61: "pill-provider-terminal", 62: "pill-provider-fallback", 63: "pill-provider-terminal", 67: "pill-provider-terminal", 68: "pill-provider-terminal", 69: "pill-provider-terminal", 72: "pill-provider-terminal", 79: "pill-provider-fallback", 87: "pill-provider-terminal", 88: "pill-provider-terminal", 89: "pill-provider-terminal", 90: "pill-provider-fallback" };
const WAVEFORM_LINKS = { 77: "pill-recording-waveform-16", 86: "pill-recording-waveform-16", 142: "pill-recording-waveform-16", 144: "pill-recording-waveform-16", 150: "pill-recording-waveform-16", 151: "pill-recording-waveform-16", 152: "pill-recording-waveform-16", 154: "pill-recording-waveform-16", 155: "pill-recording-waveform-16" };
const pocketSlot = { id: "task-42", title: "Deploy checkout", kind: null, ask: "Which environment should I deploy to?", status: "needs-user", demanding: true, backend: "codex-desktop", terminal: false };
const taskBase = { id: "task-42", title: "Deploy checkout", origin: null, agentRunId: null, status: "needs-user", kind: "session", alive: true, shelved: false, dir: "/Users/zodpatel/work/checkout", age: "2m", elapsed: "00:42", warmup: null, note: null, activity: "Which environment should I deploy to?", result: null, error: null, mcpGap: null, deliveryError: null, sending: false, modelLabel: "GPT-5.3 Codex High", agentCanRetry: false, backend: "codex-desktop", conversation: [], blocks: [], usage: { inputTokens: 1240, outputTokens: 318, contextWindow: 200000 }, project: "checkout", terminal: false, resumable: true, owned: true, resuming: false, resumeError: null };

const STATES = [
  { id: "foundations-theme-status", family: "foundations", cite: B(swift("Theme.swift"), 77, "Maps processing status to the exact green status color."), input: { surface: "foundations", component: "status", status: "processing", label: "Working" }, interactions: none("A status token specimen has no source-defined control.") },
  { id: "foundations-waveform-level", family: "foundations", cite: B(swift("Waveform.swift"), 44, "Fixes each of the eleven waveform bars at the source-defined 3pt width while level 0.64 controls height."), input: { surface: "foundations", component: "waveform", level: 0.64, barCount: 11, barWidth: 3, gap: 2.5 }, interactions: none("The waveform visualizes input level and is not directly interactive.") },
  ...PILL_STATES,
  { id: "notch-agent-confirming", family: "notch", cite: B(swift("BarContent.swift"), 168, "Maps confirming Agent activity to Needs User and the Confirming label."), input: { surface: "notch", state: "attention", hasNotch: true, hovering: false, attention: 1, working: 0, agentActivity: { state: "confirming", summary: "Send the release update?", interactionId: "interaction-7", agentRunId: "run-3", provider: "codex" }, pocket: { mode: "closed", at: 0, waiting: 0, remoteKey: "right-option", slots: [] } }, interactions: interactive(control("open", "click bar", { type: "expanded" })) },
  { id: "notch-pocket-waiting", family: "notch", cite: B(swift("BarContent.swift"), 210, "Makes the closed bar announce only the exact waiting count."), input: { surface: "notch", state: "attention", hasNotch: true, hovering: true, attention: 2, working: 0, agentActivity: null, pocket: { mode: "closed", at: 0, waiting: 2, remoteKey: "right-option", slots: [pocketSlot, { ...pocketSlot, id: "task-43", title: "Release checklist" }] } }, interactions: interactive(control("open-pocket", "click bar", { type: "pocketOpen" })) },
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
  const report = { sourceRevision: SOURCE_REVISION, productHead, sourceDrift: productHead !== SOURCE_REVISION, files, enumCases: [], branches: [], sfSymbols: [], metrics: [], tokens: [] };
  for (const source of files) {
    const scanned = scanSourceText(source, await git(["show", `${SOURCE_REVISION}:${source}`]));
    for (const category of ["enumCases", "branches", "sfSymbols", "metrics", "tokens"]) report[category].push(...scanned[category]);
  }
  return report;
}

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
    entries.push({ id: state.id, family: state.family, source: auditItem.source, symbol: auditItem.symbol, condition: auditItem.value, fixture, interactions: state.interactions, baseline: { status: "pending", reason: "Task 2 creates and verifies the native baseline artifact." }, audit: [{ id: auditItem.id, contribution: state.cite.contribution }] });
    const links = linked.get(auditItem.id) ?? []; links.push({ stateId: state.id, contribution: state.cite.contribution }); linked.set(auditItem.id, links);
  }
  const attach = (item, stateId, contribution) => {
    const entry = entries.find(({ id }) => id === stateId);
    if (!entry || entry.audit.some(({ id }) => id === item.id)) return;
    entry.audit.push({ id: item.id, contribution });
    const links = linked.get(item.id) ?? []; links.push({ stateId, contribution }); linked.set(item.id, links);
  };
  for (const item of raw.enumCases) {
    const stateId = item.symbol === "PillPhase" ? PILL_PHASE_LINKS[item.value] : item.symbol === "PillKind" ? PILL_KIND_LINKS[item.value] : item.symbol === "PillOfflineReason" ? PILL_OFFLINE_LINKS[item.value] : null;
    if (stateId) attach(item, stateId, `The source enum input ${item.symbol}.${item.value} selects the concrete ${stateId} fixture.`);
  }
  for (const item of raw.branches) {
    let stateId = null;
    if (item.source.endsWith("/PillView.swift")) stateId = PILL_VIEW_LINKS[item.line];
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
