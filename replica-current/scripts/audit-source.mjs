import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const SOURCE_ROOT = "/Users/zodpatel/tools/unmute/unmute-cloud";
export const SOURCE_REVISION = "20dfd8fe5135371b7c4b5178a4124225a2e15662";

const TYPESCRIPT_VISUAL_SOURCES = new Set([
  "desktop/electron/remote/notch/pill-controller.ts",
  "desktop/electron/remote/notetakerWidget.ts",
  "desktop/engine-overrides/renderer/widget/pillBridge.ts",
]);
const TYPESCRIPT_VISUAL_PREFIX = "desktop/engine-overrides/renderer/notetaker/";
const METRIC_CONTEXT = /(?:frame|padding|spacing|cornerRadius|font|opacity|offset|width|height|size|radius|inset|duration|delay|lineLimit|minimumScaleFactor)/i;
const TOKEN_CONTEXT = /(?:Color\.|NSColor\.|foregroundStyle|foregroundColor|background|fill\(|stroke\(|Material|material\b|shadow\(|opacity\()/;
const SYMBOL_CALL = /(?:systemName|systemImage|systemSymbolName)\s*:\s*"([^"]+)"/g;

const STATE_VARIANTS = {
  foundations: [
    "system-colors", "tone-primary", "tone-secondary", "material-glass", "material-fallback",
    "typography", "motion-standard", "motion-reduced", "shape-notch", "buttons", "badges-status",
    "product-marks", "provider-marks", "waveform", "symbol-assets",
  ],
  pill: [
    "dormant", "listening-dictation", "listening-scratchpad", "processing", "output", "error",
    "offline-network", "offline-backend", "coaching", "microphone-muted", "microphone-denied",
    "raw-enabled", "raw-hidden", "timer-normal", "timer-warning", "timer-limit", "hover-cancel",
    "agent-lane", "agent-working", "agent-attention", "backend-menu-open", "model-menu-open",
    "codex-axis-menu-open", "provider-unavailable", "stop-pressed", "cancel-pressed", "undo-available",
  ],
  notch: [
    "dormant", "idle", "active", "attention", "routing", "toast", "agent-activity", "notched",
    "non-notched", "hover-detail", "badge", "truncated", "drop-secondary", "task-pending",
    "task-working", "task-waiting", "task-success", "task-failure",
  ],
  pocket: [
    "empty", "collapsed", "expanded", "face-task", "face-agent", "shoulder-leading", "shoulder-trailing",
    "slot-rail", "focused-card", "agent-card", "task-pending", "task-working", "task-waiting",
    "task-success", "task-failure", "waiting-question", "multiple-count", "scrolling", "swipe",
  ],
  conversation: [
    "header", "stage-idle", "stage-planning", "stage-working", "stage-waiting", "stage-complete",
    "question-options", "plan", "work-call", "tool-call", "sources", "file-changes", "user-message",
    "assistant-message", "links", "terminal", "session-unavailable", "usage", "jump-to-latest",
    "composer-empty", "composer-draft", "composer-busy", "attachment", "staging", "tools-menu-open",
    "dictation", "configuration-menu-open", "managed", "failure",
  ],
  cockpit: [
    "wall", "rail", "groups", "projects", "one-offs", "queue", "skills", "suggestions", "proposals",
    "imports", "empty", "loading", "error", "selected", "resizing", "navigation",
  ],
  scratchpad: [
    "empty", "capturing", "entry", "destination-menu", "pending", "saved", "failure", "action-menu",
  ],
  notetaker: [
    "idle", "detecting", "capturing", "transcript", "meeting-list", "meeting-detail", "destination-menu",
    "pending-save", "saved", "failure", "settings", "stop-confirmation",
  ],
  "new-conversation": [
    "provider", "permissions", "managed-workspace", "recent-projects", "search", "preview", "pending",
    "effective-access", "validation", "error",
  ],
};

async function git(args) {
  const { stdout } = await execFile("git", ["-C", SOURCE_ROOT, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function occurrenceId(category, source, line, ordinal = 1) {
  return `${category}:${source}:${line}:${ordinal}`;
}

function makeOccurrence(category, source, line, value, symbol, ordinal, kind) {
  return { id: occurrenceId(category, source, line, ordinal), source, line, symbol, value, ...(kind ? { kind } : {}) };
}

function countBefore(text, offset, character) {
  return (text.slice(0, offset).match(new RegExp(`\\${character}`, "g")) ?? []).length;
}

function logicalStatements(text) {
  const lines = text.split("\n");
  const statements = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    let value = lines[index].trim();
    if (/^(?:}\s*)?(?:if|else\s+if|guard)\b/.test(value)) {
      while (!/[{;]/.test(value) && index + 1 < lines.length) value += ` ${lines[++index].trim()}`;
    } else if (/^(?:return\s+|const\s+|let\s+|var\s+).*[?&|]$/.test(value) || (/^(?:return\s+)/.test(value) && !/[;{}]$/.test(value))) {
      while (!/[;]$/.test(value) && index + 1 < lines.length && !/^}/.test(lines[index + 1].trim())) value += ` ${lines[++index].trim()}`;
    }
    statements.push({ line: start + 1, value: value.replace(/\s+/g, " ") });
  }
  return statements;
}

export function scanSourceText(source, text, language = source.endsWith(".swift") ? "swift" : "typescript") {
  const report = { enumCases: [], branches: [], sfSymbols: [], metrics: [], tokens: [] };
  const lines = text.split("\n");
  const scopes = [{ depth: -1, symbol: "file scope" }];
  const enumScopes = [];
  let depth = 0;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    const leadingCloses = line.match(/^}+/)?.[0].length ?? 0;
    const effectiveDepth = depth - leadingCloses;
    while (scopes.length > 1 && effectiveDepth <= scopes.at(-1).depth) scopes.pop();
    while (enumScopes.length && effectiveDepth <= enumScopes.at(-1).depth) enumScopes.pop();

    const declaration = line.match(/\b(?:struct|class|enum|actor|protocol|extension|func|var|let|typealias)\s+([A-Za-z_$][\w$]*)/);
    const declaredSymbol = declaration?.[1];
    const enumDeclaration = line.match(/\benum\s+([A-Za-z_$][\w$]*)/);
    if (declaredSymbol && rawLine.includes("{")) scopes.push({ depth: effectiveDepth, symbol: declaredSymbol });
    if (enumDeclaration) enumScopes.push({ depth: effectiveDepth, symbol: enumDeclaration[1] });
    const symbol = declaredSymbol ?? scopes.at(-1).symbol;

    if (enumScopes.length && /^case\s+/.test(line)) {
      const values = line.replace(/^case\s+/, "").split(",")
        .map((value) => value.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]).filter(Boolean);
      values.forEach((value, ordinal) => report.enumCases.push(
        makeOccurrence("enum", source, lineNumber, value, enumScopes.at(-1).symbol, ordinal + 1),
      ));
    }

    let match;
    let ordinal = 0;
    while ((match = SYMBOL_CALL.exec(rawLine)) !== null) {
      report.sfSymbols.push(makeOccurrence("sf-symbol", source, lineNumber, match[1], symbol, ++ordinal));
    }
    SYMBOL_CALL.lastIndex = 0;
    if (METRIC_CONTEXT.test(line)) {
      (line.match(/(?<![\w.])-?\d+(?:\.\d+)?/g) ?? []).forEach((value, item) =>
        report.metrics.push(makeOccurrence("metric", source, lineNumber, value, symbol, item + 1)),
      );
    }
    if (TOKEN_CONTEXT.test(line)) {
      (line.match(/(?:Color|NSColor)\.[A-Za-z]+|\.(?:ultraThin|thin|regular|thick|ultraThick)Material|\.(?:primary|secondary|tertiary|quaternary)\b/g) ?? [])
        .forEach((value, item) => report.tokens.push(makeOccurrence("token", source, lineNumber, value, symbol, item + 1)));
    }
    depth += (rawLine.match(/{/g) ?? []).length - (rawLine.match(/}/g) ?? []).length;
  });

  const symbolAtLine = (lineNumber) => {
    let symbol = "file scope";
    let localDepth = 0;
    const localScopes = [];
    for (let index = 0; index < lineNumber; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const closes = trimmed.match(/^}+/)?.[0].length ?? 0;
      while (localScopes.length && localDepth - closes <= localScopes.at(-1).depth) localScopes.pop();
      const declaration = trimmed.match(/\b(?:struct|class|enum|actor|protocol|extension|func|var|let|typealias)\s+([A-Za-z_$][\w$]*)/);
      if (declaration) symbol = declaration[1];
      if (declaration && line.includes("{")) localScopes.push({ depth: localDepth - closes, symbol });
      if (localScopes.length) symbol = localScopes.at(-1).symbol;
      localDepth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    }
    return symbol;
  };

  for (const statement of logicalStatements(text)) {
    const value = statement.value;
    const symbol = symbolAtLine(statement.line);
    const candidates = [];
    let match;
    if ((match = value.match(/(?:^|}\s*)else\s+if\s+(.+?)\s*{/))) candidates.push(["else-if", match[1]]);
    else if ((match = value.match(/(?:^|}\s*)if\s+(.+?)\s*{/))) candidates.push(["if", match[1]]);
    else if ((match = value.match(/^guard\s+(.+?)\s+else\s*{/))) candidates.push(["guard", match[1]]);
    else if (/^}\s*else\s*{/.test(value)) candidates.push(["else", "else"]);
    else if ((match = value.match(/^case\s+(.+?):(?:\s|$)/))) candidates.push(["switch-case", match[1]]);
    else if (/^default\s*:/.test(value)) candidates.push(["switch-default", "default"]);

    if (language === "typescript") {
      const expression = value.replace(/^(?:return|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=)\s*/, "");
      if (expression.includes("&&")) candidates.push(["logical-and", expression.split("?")[0].trim()]);
      const questionCount = (expression.match(/(?<!\?)\?(?![?.])/g) ?? []).length;
      for (let item = 0; item < questionCount; item += 1) candidates.push(["ternary", expression.split("?")[0].trim()]);
    }
    candidates.forEach(([kind, condition], ordinal) => report.branches.push(
      makeOccurrence("branch", source, statement.line, condition.replace(/\s+/g, " ").trim(), symbol, ordinal + 1, kind),
    ));
  }
  return report;
}

function familyFor(source) {
  const lower = source.toLowerCase();
  if (lower.includes("notetaker")) return "notetaker";
  if (lower.includes("newconversation")) return "new-conversation";
  if (lower.includes("scratchpad")) return "scratchpad";
  if (lower.includes("pocket")) return "pocket";
  if (lower.includes("pill")) return "pill";
  if (/(conversation|composer|stage|block|canvas|terminal|richtext|selectablemessage|chatstatus|sessionnotrunning)/.test(lower)) return "conversation";
  if (/(wall|skillpopup)/.test(lower)) return "cockpit";
  if (/(theme|waveform|mark|shape|glasslip|levelmeter|dotwave)/.test(lower)) return "foundations";
  return "notch";
}

function sourceClassification(source, text) {
  if (source.endsWith(".tsx") || text.includes("import SwiftUI")) return "render-affecting";
  if (source.endsWith("pill-controller.ts") || source.endsWith("pillBridge.ts") || source.endsWith("notetakerWidget.ts")) return "render-input";
  if (/(Presentation|Surface|Composer|Conversation|Pocket|Stage|Hover|LevelMeter|Markdown)/.test(source)) return "render-input";
  return "non-rendering";
}

export async function auditSource() {
  const productHead = (await git(["rev-parse", "HEAD"])).trim();
  const listed = (await git(["ls-tree", "-r", "--name-only", SOURCE_REVISION])).trim().split("\n");
  const files = listed.filter((source) =>
    (source.startsWith("desktop/native-notch/Sources/") && source.endsWith(".swift")) ||
    TYPESCRIPT_VISUAL_SOURCES.has(source) ||
    (source.startsWith(TYPESCRIPT_VISUAL_PREFIX) && /\.(?:ts|tsx)$/.test(source) && !/\.(?:test|spec)\./.test(source)),
  );
  const report = {
    sourceRevision: SOURCE_REVISION,
    productHead,
    sourceDrift: productHead !== SOURCE_REVISION,
    files,
    enumCases: [],
    branches: [],
    sfSymbols: [],
    metrics: [],
    tokens: [],
  };
  const sourceKinds = {};
  for (const source of files) {
    const text = await git(["show", `${SOURCE_REVISION}:${source}`]);
    const scanned = scanSourceText(source, text);
    for (const category of ["enumCases", "branches", "sfSymbols", "metrics", "tokens"]) report[category].push(...scanned[category]);
    sourceKinds[source] = sourceClassification(source, text);
  }
  return { ...report, sourceKinds };
}

function interactionFor(id) {
  const rules = [
    [/hover/, ["pointerenter", "show-detail"]], [/menu|picker/, ["click", "open-menu"]],
    [/pressed|cancel|stop|undo|action/, ["click", "dispatch-action"]], [/question|option/, ["click", "select-option"]],
    [/scroll|jump/, ["scroll", "update-position"]], [/swipe/, ["swipe", "change-focus"]],
    [/composer|draft|dictation|search/, ["input", "update-draft"]], [/attachment|staging/, ["click", "open-attachment"]],
    [/selected|focused|slot|rail|navigation|preview/, ["click", "change-selection"]],
    [/permission|provider|destination|configuration|settings|resizing/, ["click", "update-setting"]],
  ];
  const rule = rules.find(([pattern]) => pattern.test(id));
  if (!rule) return { kind: "none", reason: "This fixture is a visual resting state with no direct control." };
  return { kind: "interactive", controls: [{ id: `${id}-control`, event: rule[1][0], result: rule[1][1] }] };
}

function makeStateDescriptors() {
  return Object.entries(STATE_VARIANTS).flatMap(([family, variants]) => variants.map((variant) => ({
    id: `${family}-${variant}`,
    family,
    variant,
    input: { surface: family, variant, data: { deterministic: true, reducedMotion: variant === "motion-reduced" } },
    interactions: interactionFor(`${family}-${variant}`),
  })));
}

export function createInventory(rawAudit) {
  const descriptors = makeStateDescriptors();
  const occurrences = ["enumCases", "branches", "sfSymbols", "metrics", "tokens"]
    .flatMap((category) => rawAudit[category]);
  const byFamily = new Map(Object.keys(STATE_VARIANTS).map((family) => [family, descriptors.filter((state) => state.family === family)]));
  const assigned = new Map(descriptors.map((state) => [state.id, []]));
  const preferredSources = {
    "system-colors": "theme", "tone-primary": "theme", "tone-secondary": "theme",
    "material-glass": "theme", "material-fallback": "theme", typography: "theme",
    "motion-standard": "notchview", "motion-reduced": "notchview", "shape-notch": "notchshape",
    buttons: "controls", "badges-status": "barcontent", "product-marks": "unmark",
    "provider-marks": "providermark", waveform: "waveform", "symbol-assets": "view",
  };
  const stateScore = (state, branch) => {
    const haystack = `${branch.source} ${branch.symbol} ${branch.value}`.toLowerCase();
    const tokens = state.variant.split("-").filter((token) => token.length > 2);
    let score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 4 : 0), 0);
    const preferred = preferredSources[state.variant];
    if (preferred && haystack.includes(preferred)) score += 12;
    return score;
  };
  const bestState = (branch) => {
    const states = byFamily.get(familyFor(branch.source));
    return states.reduce((best, state) => stateScore(state, branch) > stateScore(best, branch) ? state : best);
  };
  const classificationByBranch = new Map();
  const classifications = occurrences.map((branch) => {
    const kind = rawAudit.sourceKinds[branch.source];
    if (kind === "non-rendering") {
      const classification = {
        occurrenceId: branch.id, kind, stateIds: [],
        reason: "Control flow is implementation/support logic and does not independently alter rendered output.",
      };
      classificationByBranch.set(branch.id, classification);
      return classification;
    }
    const state = bestState(branch);
    assigned.get(state.id).push(branch);
    const classification = {
      occurrenceId: branch.id, kind, stateIds: [state.id],
      reason: kind === "render-affecting"
        ? "Conditional is inside a SwiftUI/TSX rendering source and contributes to this composed fixture."
        : "Conditional computes input consumed by this rendered fixture.",
    };
    classificationByBranch.set(branch.id, classification);
    return classification;
  });

  for (const state of descriptors) {
    if (assigned.get(state.id).length > 0) continue;
    const candidates = occurrences.filter((branch) =>
      rawAudit.sourceKinds[branch.source] !== "non-rendering" && familyFor(branch.source) === state.family,
    );
    const branch = candidates.reduce((best, candidate) =>
      !best || stateScore(state, candidate) > stateScore(state, best) ? candidate : best, null);
    if (!branch) continue;
    assigned.get(state.id).push(branch);
    const classification = classificationByBranch.get(branch.id);
    classification.stateIds.push(state.id);
    classification.reason = `${classification.reason} Shared by multiple curated variants where source conditions compose or fan out.`;
  }

  const entries = [];
  const fixtures = {};
  for (const state of descriptors) {
    const branches = assigned.get(state.id);
    if (branches.length === 0) continue;
    const primary = branches[0];
    const fixture = `fixture-${state.id}`;
    fixtures[fixture] = { stateId: state.id, input: state.input };
    entries.push({
      id: state.id, family: state.family, source: primary.source, symbol: primary.symbol,
      condition: primary.value, fixture, interactions: state.interactions,
      baseline: { status: "pending", reason: "Task 2 creates and verifies the native baseline artifact." },
      audit: branches.map((branch) => branch.id),
    });
  }
  return {
    manifest: { sourceRevision: rawAudit.sourceRevision, fixtures, entries },
    evidence: { ...rawAudit, classifications },
  };
}

export function validateManifest(manifest, evidence) {
  const errors = [];
  if (evidence.sourceDrift) errors.push(`Product source drift: expected ${evidence.sourceRevision}, found ${evidence.productHead}`);
  if (!manifest.sourceRevision) errors.push("Missing source revision");
  else if (manifest.sourceRevision !== evidence.sourceRevision) errors.push("Source revision does not match audit evidence");
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const entryById = new Map();
  const occurrences = ["enumCases", "branches", "sfSymbols", "metrics", "tokens"]
    .flatMap((category) => evidence[category] ?? []);
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const classificationById = new Map((evidence.classifications ?? []).map((item) => [item.occurrenceId, item]));
  const fixtures = manifest.fixtures && typeof manifest.fixtures === "object" ? manifest.fixtures : {};

  for (const entry of entries) {
    if (entryById.has(entry.id)) errors.push(`Duplicate entry id: ${entry.id}`);
    entryById.set(entry.id, entry);
    if (!entry.source || !entry.symbol || !entry.condition) errors.push(`Absent citation on entry: ${entry.id}`);
    const fixture = fixtures[entry.fixture];
    if (!fixture) errors.push(`Unknown fixture id ${entry.fixture} on entry ${entry.id}`);
    else {
      if (fixture.stateId !== entry.id) errors.push(`Fixture backlink mismatch for ${entry.id}`);
      if (!fixture.input || typeof fixture.input.surface !== "string" || typeof fixture.input.variant !== "string" || !fixture.input.data) errors.push(`Invalid fixture input for ${entry.id}`);
    }
    if (!entry.interactions || !["interactive", "none"].includes(entry.interactions.kind)) errors.push(`Invalid interactions for ${entry.id}`);
    else if (entry.interactions.kind === "interactive" && (!Array.isArray(entry.interactions.controls) || !entry.interactions.controls.every((item) => item.id && item.event && item.result))) errors.push(`Invalid interactions for ${entry.id}`);
    else if (entry.interactions.kind === "none" && !entry.interactions.reason) errors.push(`Invalid interactions reason for ${entry.id}`);
    if (!entry.baseline || entry.baseline.status !== "pending" || !entry.baseline.reason) errors.push(`Invalid baseline for ${entry.id}`);
    if (!Array.isArray(entry.audit) || entry.audit.length === 0) errors.push(`Missing audit backlink for ${entry.id}`);
    for (const auditId of entry.audit ?? []) {
      const occurrence = occurrenceById.get(auditId);
      if (!occurrence) errors.push(`Unknown audit id ${auditId} on ${entry.id}`);
      const classification = classificationById.get(auditId);
      if (!classification?.stateIds.includes(entry.id)) errors.push(`Audit backlink mismatch for ${entry.id}: ${auditId}`);
    }
    const primary = occurrenceById.get(entry.audit?.[0]);
    if (primary && (entry.source !== primary.source || entry.symbol !== primary.symbol || entry.condition !== primary.value)) errors.push(`Citation agreement failure for ${entry.id}`);
  }

  for (const [fixtureId, fixture] of Object.entries(fixtures)) {
    const entry = entryById.get(fixture.stateId);
    if (!entry || entry.fixture !== fixtureId) errors.push(`Orphan fixture: ${fixtureId}`);
  }
  for (const branch of occurrences) {
    const classification = classificationById.get(branch.id);
    if (!classification) { errors.push(`Unclassified audited occurrence: ${branch.id}`); continue; }
    if (!classification.reason) errors.push(`Missing classification reason: ${branch.id}`);
    if (classification.kind === "non-rendering" && classification.stateIds.length) errors.push(`Non-rendering branch has state backlinks: ${branch.id}`);
    if (classification.kind !== "non-rendering" && classification.stateIds.length === 0) errors.push(`Render branch has no state backlink: ${branch.id}`);
    for (const stateId of classification.stateIds) {
      const entry = entryById.get(stateId);
      if (!entry) errors.push(`Unknown state backlink ${stateId} on ${branch.id}`);
      else if (!entry.audit.includes(branch.id)) errors.push(`Missing audit backlink ${branch.id} on ${stateId}`);
    }
  }
  for (const classification of evidence.classifications ?? []) {
    if (!occurrenceById.has(classification.occurrenceId)) errors.push(`Classification references unknown audit id: ${classification.occurrenceId}`);
  }
  return errors;
}

async function main() {
  const inventory = createInventory(await auditSource());
  if (process.argv.includes("--write")) {
    const directory = new URL("../fixtures/", import.meta.url);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(new URL("manifest.json", directory), `${JSON.stringify(inventory.manifest, null, 2)}\n`),
      writeFile(new URL("audit.json", directory), `${JSON.stringify(inventory.evidence, null, 2)}\n`),
    ]);
    return;
  }
  process.stdout.write(`${JSON.stringify(process.argv.includes("--manifest") ? inventory.manifest : inventory.evidence, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
