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
    if (enumScopes.length && /^case\s+/.test(line)) line.replace(/^case\s+/, "").split(",").forEach((part, item) => {
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
    }
    candidates.forEach(([kind, condition], n) => result.branches.push(occurrence("branch", source, statement.line, condition.trim(), symbolByLine[statement.line] ?? "file scope", n + 1, kind)));
  }
  return result;
}

const B = (source, line, contribution) => ({ source, line, contribution });
const swift = (name) => `desktop/native-notch/Sources/unmute-notch/${name}`;
const control = (id, event, result) => ({ id, event, result });
const none = (reason) => ({ kind: "none", reason });
const interactive = (...controls) => ({ kind: "interactive", controls });
const pillBase = (state) => ({ surface: "pill", openMenu: null, state });
const pocketSlot = { id: "task-42", title: "Deploy checkout", kind: null, ask: "Which environment should I deploy to?", status: "needs-user", demanding: true, backend: "codex-desktop", terminal: false };
const taskBase = { id: "task-42", title: "Deploy checkout", origin: null, agentRunId: null, status: "needs-user", kind: "session", alive: true, shelved: false, dir: "/Users/zodpatel/work/checkout", age: "2m", elapsed: "00:42", warmup: null, note: null, activity: "Which environment should I deploy to?", result: null, error: null, mcpGap: null, deliveryError: null, sending: false, modelLabel: "GPT-5.3 Codex High", agentCanRetry: false, backend: "codex-desktop", conversation: [], blocks: [], usage: { inputTokens: 1240, outputTokens: 318, contextWindow: 200000 }, project: "checkout", terminal: false, resumable: true, owned: true, resuming: false, resumeError: null };

const STATES = [
  { id: "foundations-theme-status", family: "foundations", cite: B(swift("Theme.swift"), 77, "Maps processing status to the exact green status color."), input: { surface: "foundations", component: "status", status: "processing", label: "Working" }, interactions: none("A status token specimen has no source-defined control.") },
  { id: "foundations-waveform-level", family: "foundations", cite: B(swift("Waveform.swift"), 44, "Fixes each of the eleven waveform bars at the source-defined 3pt width while level 0.64 controls height."), input: { surface: "foundations", component: "waveform", level: 0.64, barCount: 11, barWidth: 3, gap: 2.5 }, interactions: none("The waveform visualizes input level and is not directly interactive.") },
  { id: "pill-recording-remote-warning", family: "pill", cite: B(swift("PillView.swift"), 538, "Switches from waveform to countdown during the final 15 seconds."), input: pillBase({ phase: "recording", kind: "remote", taskId: "task-42", level: 0.64, elapsed: 286, maxSeconds: 300 }), interactions: interactive(control("discard", "click discard", { type: "pillCancel" }), control("finish", "click finish", { type: "pillStop" })) },
  { id: "pill-processing-draft", family: "pill", cite: B(swift("PillView.swift"), 594, "Shows the exact quick-draft action while processing."), input: pillBase({ phase: "processing", kind: "instruction", level: 0, elapsed: 12, maxSeconds: 300, draftOffer: true, engineNotice: false, showDiscardHint: false }), interactions: interactive(control("quick-draft", "click Use quick draft", { type: "pillAcceptDraft" })) },
  { id: "pill-payment-failed", family: "pill", cite: B(swift("PillModel.swift"), 99, "Provides exact recoverable payment-failure copy."), input: pillBase({ phase: "recording", kind: "dictation", level: 0.2, elapsed: 8, maxSeconds: 300, offline: "payment_failed" }), interactions: interactive(control("update-card", "click Update card", { type: "pillOpenBillingPortal" }), control("dismiss", "click dismiss", { type: "pillDismissOffline" })) },
  { id: "pill-cancelled", family: "pill", cite: B(swift("PillView.swift"), 632, "Selects the Cancelled phase with its Undo control."), input: pillBase({ phase: "cancelled", kind: "dictation", canUndo: true, elapsed: 4, maxSeconds: 300 }), interactions: interactive(control("undo", "click Undo", { type: "pillUndo" })) },
  { id: "pill-error", family: "pill", cite: B(swift("PillView.swift"), 649, "Shows retry guidance only when error copy is not a limit-reached message."), input: pillBase({ phase: "error", kind: "dictation", message: "Transcription failed", elapsed: 12, maxSeconds: 300 }), interactions: none("The source error phase exposes retry guidance but no control on the pill.") },
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
