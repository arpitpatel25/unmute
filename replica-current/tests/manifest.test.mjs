import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../fixtures/manifest.json", import.meta.url);
const evidenceUrl = new URL("../fixtures/audit.json", import.meta.url);
const CURRENT_REVISION = "20dfd8fe5135371b7c4b5178a4124225a2e15662";

async function loadInventory() {
  const [manifest, evidence, auditor] = await Promise.all([
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(evidenceUrl, "utf8").then(JSON.parse),
    import("../scripts/audit-source.mjs"),
  ]);
  return { manifest, evidence, ...auditor };
}

test("syntax fixtures independently exercise Swift and TypeScript extraction", async () => {
  const { scanSourceText } = await import("../scripts/audit-source.mjs");
  const swift = `
enum Face {
  case idle, active
}
struct Card: View {
  var body: some View {
    if enabled &&
       hasContent {
      Text("Ready")
    } else if failed {
      Image(systemName: "exclamationmark.triangle")
    } else {
      EmptyView()
    }
  }
}`;
  const typescript = `
export function Widget({ open, items }) {
  const label = open ? "Close" : "Open";
  return open && items.length > 0
    ? <Panel />
    : <Empty />;
}`;

  const swiftAudit = scanSourceText("Fixture.swift", swift, "swift");
  assert.deepEqual(swiftAudit.enumCases.map(({ value }) => value), ["idle", "active"]);
  assert.deepEqual(swiftAudit.branches.map(({ kind }) => kind), ["if", "else-if", "else"]);
  assert.equal(swiftAudit.branches[0].value, "enabled && hasContent");
  assert.deepEqual(swiftAudit.sfSymbols.map(({ value }) => value), ["exclamationmark.triangle"]);
  assert.ok(swiftAudit.branches.every(({ symbol }) => symbol === "body"));

  const tsAudit = scanSourceText("Fixture.tsx", typescript, "typescript");
  assert.deepEqual(tsAudit.branches.map(({ kind }) => kind), ["ternary", "logical-and", "ternary"]);
  assert.ok(tsAudit.branches.some(({ value }) => value === "open"));
  assert.ok(tsAudit.branches.some(({ value }) => value === "open && items.length > 0"));
});

test("actual-source conditional forms are extracted independently at their real lines", async () => {
  const { evidence } = await loadInventory();
  const find = (suffix, line, kind) => evidence.branches.find((branch) =>
    branch.source.endsWith(suffix) && branch.line === line && branch.kind === kind);
  assert.equal(find("PillView.swift", 538, "if")?.value, "s.maxSeconds - s.elapsed <= 15");
  assert.equal(find("MeetingsList.tsx", 44, "if")?.value, "meeting.summary_status === 'pending'");
  assert.equal(find("MeetingsList.tsx", 45, "if")?.value, "meeting.summary_status === 'failed'");
  assert.equal(find("MeetingsList.tsx", 46, "if")?.value, "meeting.summary_status === 'disabled' && meeting.status === 'ready'");
  assert.equal(find("NotetakerWidget.tsx", 520, "logical-and")?.value, "!completed && !showDiscard");
  assert.equal(find("NotetakerWidget.tsx", 562, "ternary")?.value, "completed");
  assert.equal(find("NotetakerWidget.tsx", 575, "ternary")?.value, "showDiscard");
});

test("Pill gate exhaustively covers source enums without associated-value false positives", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const pill = manifest.entries.filter(({ family }) => family === "pill");
  const inputs = pill.map((entry) => manifest.fixtures[entry.fixture].input);
  assert.deepEqual([...new Set(inputs.map(({ state }) => state.phase))].sort(),
    ["cancelled", "error", "hidden", "output", "output-fallback", "paused", "processing", "recording", "too-short"]);
  assert.deepEqual([...new Set(inputs.map(({ state }) => state.kind))].sort(), ["dictation", "instruction", "remote"]);
  assert.deepEqual([...new Set(inputs.map(({ state }) => state.offline).filter(Boolean))].sort(),
    ["chose_on_device", "cloud_unreachable", "no_subscription", "not_signed_in", "payment_failed"]);
  const eventCases = evidence.enumCases.filter((item) => item.symbol === "PillEvent").map(({ value }) => value);
  assert.deepEqual(eventCases, ["stop", "cancel", "undo", "acceptDraft", "pickModel", "pickAxis", "cycleAgent", "pickAgent", "pickMic", "toggleRaw", "openBillingPortal", "dismissOffline"]);
  for (const item of evidence.enumCases.filter((item) => ["PillPhase", "PillKind", "PillOfflineReason"].includes(item.symbol))) {
    const classification = evidence.classifications.find(({ occurrenceId }) => occurrenceId === item.id);
    assert.ok(classification.stateIds.some((id) => id.startsWith("pill-")), `uncovered ${item.symbol}.${item.value}`);
  }
});

test("Pill fixtures pin exact branch values, menus, controls, and transitions", async () => {
  const { manifest } = await loadInventory();
  const entry = (id) => manifest.entries.find((candidate) => candidate.id === id);
  const input = (id) => manifest.fixtures[entry(id).fixture].input;
  const events = (id) => entry(id).interactions.kind === "interactive" ? entry(id).interactions.controls.map((c) => c.result) : [];
  assert.equal(input("pill-recording-countdown-15").state.elapsed, 285);
  assert.equal(input("pill-recording-waveform-16").state.elapsed, 284);
  assert.equal(input("pill-processing-draft").state.draftOffer, true);
  assert.equal(input("pill-processing-on-device").state.engineNotice, true);
  assert.equal(input("pill-output-fallback-preview").state.outputPreview, "Ship the checkout update");
  assert.equal(input("pill-error-limit").state.message, "Daily limit reached");
  assert.equal(input("pill-hint-mic-precedence").state.micStatus, "AirPods — Move closer");
  assert.equal(input("pill-hint-mic-precedence").state.coaching.level, "quiet");
  assert.equal(input("pill-selector-codex-axes").viewState.selectorOpen, true);
  assert.deepEqual(input("pill-selector-codex-axes").state.modelAxes.map((axis) => axis.axis), ["Model", "Effort"]);
  assert.equal(input("pill-selector-task-addressed").state.taskId, "task-42");
  assert.equal(input("pill-agent-lane-processing").state.kind, "remote");
  assert.deepEqual(input("pill-agent-lane-processing").state.agentOptions, []);
  assert.deepEqual(input("pill-agent-lane-processing").state.modelOptions, []);
  assert.equal(input("pill-mic-iphone").state.mic, "iphone");
  assert.equal(input("pill-scratchpad-armed").scratchpad.armed, true);
  const allResults = manifest.entries.filter(({ family }) => family === "pill").flatMap(({ interactions }) => interactions.controls?.map((c) => c.result.type) ?? []);
  for (const type of ["pillStop", "pillCancel", "pillUndo", "pillAcceptDraft", "pillPickModel", "pillPickAxis", "pillPickAgent", "pillPickMic", "pillOpenBillingPortal", "pillDismissOffline", "scratchpadArm", "scratchpadRemove", "scratchpadDeliver", "scratchpadDiscard"])
    assert.ok(allResults.includes(type), `missing Pill transition ${type}`);
});

test("Pill fixtures use the decodable wire schema and keep SwiftUI state separate", async () => {
  const { manifest, validateManifest, evidence } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  for (const entry of manifest.entries.filter(({ family }) => family === "pill")) {
    const input = manifest.fixtures[entry.fixture].input;
    assert.ok(input.viewState && typeof input.viewState.selectorOpen === "boolean");
    assert.equal("openMenu" in input, false);
    assert.equal("presentation" in input, false);
    if (input.state.coaching) assert.deepEqual(Object.keys(input.state.coaching).sort(), ["condition", "level", "remedy"]);
    for (const axis of input.state.modelAxes ?? []) assert.deepEqual(Object.keys(axis).sort(), ["axis", "current", "values"]);
    for (const option of input.state.micOptions ?? []) assert.equal(typeof option, "object");
  }
});

test("Pill controls are visible-source emissions with provenance", async () => {
  const { manifest } = await loadInventory();
  const controls = manifest.entries.filter(({ family }) => family === "pill")
    .flatMap(({ interactions }) => interactions.controls ?? []);
  assert.ok(controls.length > 0);
  assert.ok(controls.every(({ provenance }) => provenance?.source.endsWith(".swift") && Number.isInteger(provenance.line)));
  const types = new Set(controls.map(({ result }) => result.type));
  assert.equal(types.has("pillCycleAgent"), false);
  assert.equal(types.has("pillToggleRaw"), false);
  assert.equal(types.has("scratchpadCollapse"), false);
  for (const expected of ["pillStop", "pillCancel", "pillUndo", "pillAcceptDraft", "pillPickModel", "pillPickAxis", "pillPickAgent", "pillPickMic", "pillOpenBillingPortal", "pillDismissOffline", "scratchpadArm", "scratchpadRemove", "scratchpadDeliver", "scratchpadDiscard"])
    assert.ok(types.has(expected), `missing emitted visible control ${expected}`);
});

test("Pill predicate coverage records verified outcomes against fixture values", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const coverage = manifest.entries.filter(({ family }) => family === "pill").flatMap(({ predicates = [] }) => predicates);
  assert.ok(coverage.length > 0);
  assert.ok(coverage.every(({ predicate, outcome }) => predicate && typeof outcome === "boolean"));
  const outcomes = (predicate) => new Set(coverage.filter((item) => item.predicate === predicate).map(({ outcome }) => outcome));
  for (const predicate of ["selectorShowing", "micOptions.count > 1", "!isAgentLane", "taskId == nil", "scratchpad enabled and visible/live", "waveform envelope <= 0"])
    assert.deepEqual([...outcomes(predicate)].sort(), [false, true], `missing outcomes for ${predicate}`);
});

test("Pill provider fixtures cover real vendor/name/terminal combinations only", async () => {
  const { manifest } = await loadInventory();
  const providers = manifest.entries.filter(({ family }) => family === "pill")
    .map((entry) => entry.expectations?.providerMark).filter(Boolean);
  assert.deepEqual(providers.map(({ backend, vendor, name, terminal }) => [backend, vendor, name, terminal]).sort(), [
    ["claude", "claude", "Claude Code CLI", true],
    ["claude-code-desktop", "claude", "Claude desktop", false],
    ["codex", "codex", "Codex CLI", true],
    ["codex-desktop", "codex", "Codex desktop", false],
  ].sort());
  assert.ok(providers.every(({ art }) => art === "embedded"));
});

test("Pill owns zero and nonzero Waveform states but no AimedChip branches", async () => {
  const { manifest } = await loadInventory();
  const pill = manifest.entries.filter(({ family }) => family === "pill");
  const input = (entry) => manifest.fixtures[entry.fixture].input;
  assert.ok(pill.some((entry) => input(entry).state.level === 0 && entry.predicates?.some((p) => p.predicate === "waveform envelope <= 0" && p.outcome)));
  assert.ok(pill.some((entry) => input(entry).state.level > 0 && entry.predicates?.some((p) => p.predicate === "waveform envelope <= 0" && !p.outcome)));
  assert.equal(pill.some((entry) => entry.audit.some(({ id }) => id.includes("Waveform.swift:14"))), false);
});

test("Pocket gate exhaustively covers faces, status behavior, display treatments, and geometry", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const pocket = manifest.entries.filter(({ family }) => family === "pocket");
  const inputs = pocket.map((entry) => manifest.fixtures[entry.fixture].input);
  assert.deepEqual([...new Set(inputs.map(({ pocket }) => pocket.slots[pocket.at]?.status).filter(Boolean))].sort(),
    ["done", "failed", "needs-user", "processing", "ready", "stuck", "unknown"]);
  assert.ok(inputs.some((x) => x.expectation.rendered === false && x.pocket.slots.length === 0));
  assert.ok(inputs.some((x) => x.expectation.rendered === false && x.model.state === "task"));
  assert.ok(inputs.some((x) => x.expectation.hasAsk && x.expectation.cardHeight === 106));
  assert.ok(inputs.some((x) => !x.expectation.hasAsk && x.expectation.cardHeight === 68));
  assert.ok(inputs.some((x) => x.geometry.hasNotch && x.expectation.headerInShoulders));
  assert.ok(inputs.some((x) => !x.geometry.hasNotch && !x.expectation.headerInShoulders));
  for (const input of inputs.filter((x) => x.expectation.rendered && x.pocket.slots[x.pocket.at])) {
    assert.deepEqual(input.expectation.status, input.expectation.recomputedStatus);
    assert.equal(input.expectation.count, `${Math.min(input.pocket.at + 1, input.pocket.slots.length)}/${input.pocket.slots.length}`);
  }
});

test("Pocket controls and gestures use independently extracted exact emit sites", async () => {
  const { manifest, evidence } = await loadInventory();
  const controls = manifest.entries.filter(({ family }) => family === "pocket").flatMap(({ interactions }) => interactions.controls ?? []);
  const sites = evidence.pocketControlEmitSites;
  assert.ok(sites.length >= 9);
  for (const control of controls) assert.ok(sites.some((site) => site.type === control.result.type && site.source === control.provenance.source && site.line === control.provenance.line), `${control.result.type}:${control.provenance?.line}`);
  for (const type of ["pocketMove", "pocketExpand", "openDashboard", "pocketRelease"])
    assert.ok(controls.some(({ result }) => result.type === type), `missing ${type}`);
  assert.ok(manifest.entries.some(({ id, interactions }) => id === "pocket-swipe-precise-next" && interactions.controls[0].result.delta === 1));
  assert.ok(manifest.entries.some(({ id, interactions }) => id === "pocket-wheel-previous" && interactions.controls[0].result.delta === -1));
});

test("Pocket swipe arithmetic proves thresholds, direction, rejection, reset, and one-step latch", async () => {
  const { evaluatePocketSwipe } = await loadInventory();
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -25, deltaY: 0 }]), []);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -26, deltaY: 0 }]), [1]);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: 26, deltaY: 0 }]), [-1]);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -30, deltaY: 22 }]), []);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -30, deltaY: 20 }, { deltaX: -30, deltaY: 0 }]), [1]);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -40, deltaY: 0, isMomentum: true }]), []);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -30, deltaY: 0 }, { deltaX: -30, deltaY: 0 }]), [1]);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -20, deltaY: 0 }, { deltaX: 0, deltaY: 0, isGestureEnd: true }, { deltaX: -20, deltaY: 0 }]), []);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: -0.5, deltaY: 0, hasPreciseDeltas: false }]), [1]);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: 0.5, deltaY: 0, hasPreciseDeltas: false }]), [-1]);
  assert.deepEqual(evaluatePocketSwipe([{ deltaX: 0.49, deltaY: 0, hasPreciseDeltas: false }, { deltaX: 0.5, deltaY: 0.5, hasPreciseDeltas: false }]), []);
});

test("Pocket branch backlinks carry independently recomputed outcomes and full ordered ancestry", async () => {
  const { manifest, evidence, validateManifest, evaluatePocketBranch } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const occurrences = new Map(evidence.branches.map((item) => [item.id, item]));
  for (const entry of manifest.entries.filter(({ family }) => family === "pocket")) {
    const input = manifest.fixtures[entry.fixture].input;
    for (const link of entry.audit.filter(({ id }) => id.startsWith("branch:"))) {
      const expected = evaluatePocketBranch(occurrences.get(link.id), input);
      assert.equal(link.predicate, expected.predicate, `${entry.id}:${link.id}`);
      assert.equal(link.outcome, expected.outcome, `${entry.id}:${link.id}`);
      assert.deepEqual(link.ancestors, expected.ancestors, `${entry.id}:${link.id}`);
      assert.ok(link.ancestors.every(({ outcome }) => outcome === true));
    }
  }
});

test("Pocket mutation checks reject forged derivations and provenance", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  const mutate = (fn) => { const copy = structuredClone(manifest); fn(copy); return validateManifest(copy, evidence); };
  assert.ok(mutate((m) => { m.fixtures["fixture-pocket-task-question"].input.expectation.cardHeight = 105; }).some((e) => /Pocket derived expectation/i.test(e)));
  assert.ok(mutate((m) => { m.fixtures["fixture-pocket-agent-listening"].input.expectation.agentTreatment = "provider"; }).some((e) => /Pocket derived expectation/i.test(e)));
  assert.ok(mutate((m) => { const e = m.entries.find(({ id }) => id === "pocket-task-question"); e.interactions.controls[0].provenance.line = 1; }).some((e) => /Pocket control provenance/i.test(e)));
});

test("each Pill render backlink carries a reachable verified branch outcome", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  for (const entry of manifest.entries.filter(({ family }) => family === "pill")) {
    for (const link of entry.audit.filter(({ id }) => id.startsWith("branch:"))) {
      assert.equal(typeof link.outcome, "boolean", `${entry.id} ${link.id}`);
      assert.ok(Array.isArray(link.ancestors), `${entry.id} ${link.id}`);
      assert.ok(link.ancestors.every(({ predicate, outcome }) => predicate && outcome === true));
    }
  }
});

test("Pill local view state is allowlisted and source-provenanced", async () => {
  const { manifest } = await loadInventory();
  for (const entry of manifest.entries.filter(({ family }) => family === "pill")) {
    const viewState = manifest.fixtures[entry.fixture].input.viewState;
    assert.deepEqual(Object.keys(viewState).sort(), ["padExpanded", "selectorOpen", ...(viewState.hover ? ["hover"] : [])].sort());
    for (const hover of Object.values(viewState.hover ?? {})) {
      assert.equal(typeof hover.value, "boolean");
      assert.equal(hover.provenance.source.endsWith("PillView.swift"), true);
      assert.equal(Number.isInteger(hover.provenance.line), true);
    }
    assert.equal("agentRim" in viewState, false);
    assert.equal("controlState" in viewState, false);
    assert.equal("pillHover" in viewState, false);
  }
});

test("Notch gate covers every source state, task status, and Agent activity case", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const notch = manifest.entries.filter(({ family }) => family === "notch");
  const inputs = notch.map((entry) => manifest.fixtures[entry.fixture].input);
  assert.deepEqual([...new Set(inputs.map(({ model }) => model.state))].sort(),
    ["active", "attention", "cockpit", "dormant", "idle", "task"]);
  assert.deepEqual([...new Set(inputs.map(({ model }) => model.task?.status).filter(Boolean))].sort(),
    ["done", "failed", "needs-user", "processing", "ready", "stuck"]);
  assert.deepEqual([...new Set(inputs.map(({ model }) => model.agentActivity?.state).filter(Boolean))].sort(),
    ["complete", "confirming", "failed", "listening", "searching", "thinking"]);
  for (const symbol of ["NotchState", "TaskStatus", "AgentActivityState"])
    for (const item of evidence.enumCases.filter((candidate) => candidate.symbol === symbol))
      assert.ok(evidence.classifications.find(({ occurrenceId }) => occurrenceId === item.id).stateIds.some((id) => id.startsWith("notch-")), `uncovered ${symbol}.${item.value}`);
});

test("Notch branch records evaluate exact predicates with ordered reachable ancestors", async () => {
  const { manifest, validateManifest, evidence } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const entry = (id) => manifest.entries.find((candidate) => candidate.id === id);
  const branch = (id, line) => entry(id).audit.find((link) => link.id.startsWith("branch:") && link.id.includes(`:${line}:`));
  assert.equal(branch("notch-silenced-hover-exempt", 145).outcome, false);
  assert.equal(branch("notch-silenced-hardware-empty", 145).outcome, true);
  assert.equal(branch("notch-routing", 189).ancestors.length, 2);
  assert.equal(branch("notch-pocket-waiting-one", 210).ancestors.length, 3);
  assert.equal(branch("notch-attention-needs-user", 275).ancestors.length, 5);
  for (const candidate of manifest.entries.filter(({ family }) => family === "notch"))
    for (const link of candidate.audit.filter(({ id }) => id.startsWith("branch:"))) {
      assert.equal(typeof link.outcome, "boolean", `${candidate.id}:${link.id}`);
      assert.ok(Array.isArray(link.ancestors), `${candidate.id}:${link.id}`);
      assert.ok(link.ancestors.every(({ outcome }) => outcome === true), `${candidate.id}:${link.id}`);
    }
});

test("NotchState switch and nested branches are independently case-gated", async () => {
  const { manifest, evaluateNotchBranch } = await loadInventory();
  const entry = (id) => manifest.entries.find((candidate) => candidate.id === id);
  const input = (id) => manifest.fixtures[entry(id).fixture].input;
  const occurrence = (id, line) => entry(id).audit.find((link) => link.id.startsWith("branch:") && link.id.includes(`:${line}:`));
  const cases = [
    ["notch-dormant-hardware", 230, "dormant"], ["notch-idle-wordmark", 235, "idle"],
    ["notch-active-task-activity", 257, "active"], ["notch-attention-needs-user", 275, "attention"],
    ["notch-task-expanded", 285, "task"], ["notch-cockpit-expanded", 285, "cockpit"],
  ];
  for (const [id, line, selected] of cases) {
    const link = occurrence(id, line);
    assert.equal(link.outcome, true);
    assert.ok(link.ancestors.some(({ predicate }) => predicate === `NotchState case ${selected} selected`));
    const wrong = structuredClone(input(id));
    wrong.model.state = selected === "idle" ? "active" : "idle";
    assert.equal(evaluateNotchBranch({ source: link.id.split(":").slice(1, -2).join(":"), line, value: link.predicate }, wrong).outcome, false);
  }
  for (const [id, line, parent] of [["notch-idle-resting-nub", 247, "idle"], ["notch-idle-hover", 247, "idle"], ["notch-active-task-hover-title", 270, "active"]]) {
    const link = occurrence(id, line);
    assert.deepEqual(link.ancestors.slice(0, 4).map(({ predicate }) => predicate), ["toast branch not selected", "agent activity branch not selected", "routing branch not selected", "pocket branch not selected"]);
    assert.equal(link.ancestors[4].predicate, `NotchState case ${parent} selected`);
    const wrong = structuredClone(input(id)); wrong.model.state = parent === "idle" ? "active" : "idle";
    assert.equal(evaluateNotchBranch({ source: "desktop/native-notch/Sources/unmute-notch/BarContent.swift", line, value: link.predicate }, wrong).outcome, false);
  }
});

test("Notch precedence is proven by fixtures carrying every lower competing signal", async () => {
  const { manifest } = await loadInventory();
  const input = (id) => manifest.fixtures[manifest.entries.find((entry) => entry.id === id).fixture].input;
  assert.equal(input("notch-precedence-toast").expectation.bar.selected, "toast");
  assert.equal(input("notch-precedence-activity").expectation.bar.selected, "agentActivity");
  assert.equal(input("notch-precedence-routing").expectation.bar.selected, "routing");
  assert.equal(input("notch-precedence-pocket").expectation.bar.selected, "pocket");
  for (const id of ["notch-precedence-toast", "notch-precedence-activity", "notch-precedence-routing", "notch-precedence-pocket"])
    assert.equal(input(id).model.pocket.waiting, 1);
  assert.ok(input("notch-precedence-toast").model.agentActivity);
  assert.equal(input("notch-precedence-toast").model.capturePhase, "routing");
  assert.equal(input("notch-precedence-activity").model.capturePhase, "routing");
});

test("Notch geometry stores source-equivalent numeric allocations and frames", async () => {
  const { manifest } = await loadInventory();
  const inputs = manifest.entries.filter(({ family }) => family === "notch").map((entry) => manifest.fixtures[entry.fixture].input);
  assert.equal(inputs.some(({ geometry }) => "rightAllocation" in geometry), false);
  const byPath = (path) => inputs.filter(({ expectation }) => expectation.geometry?.path === path).map(({ expectation }) => expectation.geometry);
  for (const path of ["notched", "no-notch"]) {
    const values = byPath(path);
    assert.ok(values.some(({ wantedRightWidth, allocatedRightWidth }) => wantedRightWidth === allocatedRightWidth && allocatedRightWidth >= 54));
    assert.ok(values.some(({ wantedRightWidth, allocatedRightWidth }) => wantedRightWidth > allocatedRightWidth && allocatedRightWidth >= 54));
    assert.ok(values.some(({ roomRight, allocatedRightWidth }) => roomRight === 54 && allocatedRightWidth === 54));
    assert.ok(values.some(({ roomRight, allocatedRightWidth }) => roomRight < 54 && allocatedRightWidth === 0));
    assert.ok(values.every(({ roomRight, fillet, middle, wantedRightWidth, allocatedRightWidth, frame }) =>
      [roomRight, fillet, middle, wantedRightWidth, allocatedRightWidth, frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)));
  }
});

test("Notch interactions are independently matched to exact emit sites", async () => {
  const { manifest, evidence } = await loadInventory();
  assert.deepEqual(evidence.notchControlEmitSites, [
    { type: "pocketOpen", source: "desktop/native-notch/Sources/unmute-notch/NotchView.swift", line: 89 },
    { type: "tap", source: "desktop/native-notch/Sources/unmute-notch/NotchView.swift", line: 89 },
    { type: "hover", source: "desktop/native-notch/Sources/unmute-notch/NotchView.swift", line: 100 },
    { type: "userReturned", source: "desktop/native-notch/Sources/unmute-notch/AppController.swift", line: 1831 },
    { type: "userLeft", source: "desktop/native-notch/Sources/unmute-notch/AppController.swift", line: 1862 },
  ]);
  const controls = manifest.entries.filter(({ family }) => family === "notch").flatMap(({ interactions }) => interactions.controls ?? []);
  assert.ok(controls.some(({ result }) => result.type === "pocketOpen"));
  assert.ok(controls.some(({ result }) => result.type === "tap"));
  assert.ok(controls.some(({ result }) => result.type === "hover" && result.hovering === true));
  assert.ok(controls.some(({ result }) => result.type === "hover" && result.hovering === false));
  assert.ok(controls.some(({ result, provenance }) => result.type === "userLeft" && provenance.line === 1862));
  assert.ok(controls.some(({ result, provenance }) => result.type === "userReturned" && provenance.line === 1831));
  assert.equal(controls.some(({ result }) => ["pointerEntered", "pointerExited"].includes(result.type)), false);
});

test("Notch status, appearance, and controller expectations are source-shaped or recomputed", async () => {
  const { manifest } = await loadInventory();
  const entry = (id) => manifest.entries.find((candidate) => candidate.id === id);
  const input = (id) => manifest.fixtures[entry(id).fixture].input;
  assert.equal(entry("notch-dormant-no-notch"), undefined);
  const expected = {
    processing: [false, "Working", "systemGreen"], "needs-user": [true, "Needs you", "systemOrange"],
    ready: [true, "Ready", "systemTeal"], stuck: [true, "Stuck", "systemRed"],
    done: [false, "Done", "systemGray"], failed: [true, "Errored", "systemRed"],
  };
  for (const [status, values] of Object.entries(expected)) {
    const behavior = input(`notch-attention-${status}`).expectation.taskStatus;
    assert.deepEqual([behavior.isYourMove, behavior.label, behavior.color], values);
    assert.equal(input(`notch-attention-${status}`).expectation.bar.alarm, status);
  }
  assert.deepEqual(input("notch-agent-complete").expectation.agentTiming, { terminal: true, clearAfterSeconds: 2.2 });
  assert.deepEqual(input("notch-agent-thinking").expectation.agentTiming, { terminal: false, clearAfterSeconds: null });
  assert.equal(input("notch-auto-present-explicit-gesture").controller.lastGestureAgeSeconds, 5.999);
  assert.equal("recentExplicitGesture" in input("notch-auto-present-explicit-gesture").controller, false);
  assert.equal("departure" in input("notch-departure-expanded-hide").controller, false);
  assert.equal("reduceTransparency" in input("notch-expanded-glass-tone").appearance, false);
  assert.deepEqual(input("notch-expanded-solid-space-gray-fill").expectation.expandedFrame, { x: 227, y: 295, width: 1058, height: 687 });
});

test("Notch fixtures keep wire model, local view, geometry, appearance, and controller state exact", async () => {
  const { manifest } = await loadInventory();
  const notch = manifest.entries.filter(({ family }) => family === "notch");
  for (const entry of notch) {
    const input = manifest.fixtures[entry.fixture].input;
    assert.equal(input.surface, "notch");
    assert.deepEqual(Object.keys(input).sort(), ["appearance", "controller", "expectation", "geometry", "model", "surface", "viewState"].sort());
    assert.equal(typeof input.model.state, "string");
    assert.equal(typeof input.model.hovering, "boolean");
    assert.ok(Array.isArray(input.model.silenced));
    assert.equal(typeof input.geometry.hasNotch, "boolean");
    assert.ok(Number.isFinite(input.geometry.leftUsable));
    assert.ok(Number.isFinite(input.geometry.rightUsable));
    assert.ok(["system", "glass", "solid"].includes(input.appearance.preference));
    assert.ok(["spaceGray", "black", "glass"].includes(input.appearance.tone));
    assert.equal(typeof input.controller.autoPresent, "boolean");
  }
});

test("Notch precedence, hover, silence, fit/drop, and lifecycle branches record both outcomes", async () => {
  const { manifest } = await loadInventory();
  const coverage = manifest.entries.filter(({ family }) => family === "notch").flatMap(({ predicates = [] }) => predicates);
  const outcomes = (predicate) => [...new Set(coverage.filter((item) => item.predicate === predicate).map(({ outcome }) => outcome))].sort();
  for (const predicate of ["toast visible while collapsed", "agent activity visible while collapsed", "capturePhase == routing while collapsed", "pocket waiting while closed and collapsed", "hovering", "content signature silenced", "hasNotch", "right segment fits", "auto-present permits expansion", "expanded automatic departure"])
    assert.deepEqual(outcomes(predicate), [false, true], `missing outcomes for ${predicate}`);
});

test("every retained Notch render backlink has an outcome and reachable ancestors", async () => {
  const { manifest } = await loadInventory();
  for (const entry of manifest.entries.filter(({ family }) => family === "notch")) {
    for (const link of entry.audit.filter(({ id }) => id.startsWith("branch:"))) {
      assert.equal(typeof link.outcome, "boolean", `${entry.id} ${link.id}`);
      assert.ok(Array.isArray(link.ancestors), `${entry.id} ${link.id}`);
      assert.ok(link.ancestors.every(({ predicate, outcome }) => predicate && outcome === true), `${entry.id} ${link.id}`);
    }
  }
});

test("Notch interactions are concrete source transitions, never synthetic expanded aliases", async () => {
  const { manifest } = await loadInventory();
  const controls = manifest.entries.filter(({ family }) => family === "notch").flatMap(({ interactions }) => interactions.controls ?? []);
  const types = new Set(controls.map(({ result }) => result.type));
  assert.equal(types.has("expanded"), false);
  for (const expected of ["tap", "pocketOpen", "hover", "userLeft", "userReturned"])
    assert.ok(types.has(expected), `missing notch transition ${expected}`);
  assert.ok(controls.every(({ provenance }) => provenance?.source.endsWith(".swift") && Number.isInteger(provenance.line)));
  for (const entry of manifest.entries.filter(({ family }) => family === "notch")) {
    const input = manifest.fixtures[entry.fixture].input;
    if (["task", "cockpit"].includes(input.model.state) && !entry.id.startsWith("notch-departure"))
      assert.equal(entry.interactions.kind, "none", `${entry.id} claims a hidden bar control`);
  }
});

test("control provenance is independently extracted and selector dismissal is complete", async () => {
  const { manifest, controlEmitSites } = await loadInventory();
  const sites = await controlEmitSites();
  const controls = manifest.entries.filter(({ family }) => family === "pill").flatMap(({ interactions }) => interactions.controls ?? []);
  for (const control of controls) assert.ok(sites.some((site) => site.type === control.result.type && site.line === control.provenance.line), `${control.result.type}:${control.provenance.line}`);
  const close = controls.filter(({ result }) => result.type === "viewSelectorClose");
  assert.deepEqual(new Set(close.map(({ provenance }) => provenance.line)), new Set([253, 853]));
  assert.ok(close.every(({ visibility }) => visibility?.predicate === "selectorShowing" && visibility.outcome === true));
});

test("provider expectations are independently derived from fixture backend and terminal", async () => {
  const { manifest, validateManifest, evidence } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const candidate = structuredClone(manifest);
  const provider = candidate.entries.find((entry) => entry.expectations?.providerMark);
  provider.expectations.providerMark.name = "Wrong provider";
  assert.match(validateManifest(candidate, evidence).join("\n"), /provider expectation mismatch/i);
});

test("ProviderMarkArt name branches map exact backend cases and reject vendor aliases", async () => {
  const { manifest, evidence, providerNameCaseOutcome } = await loadInventory();
  const expected = new Map([
    [87, "pill-provider-codex-cli"],
    [88, "pill-provider-codex-desktop"],
    [89, "pill-provider-claude-desktop"],
    [90, "pill-provider-claude-cli"],
  ]);
  for (const [line, stateId] of expected) {
    const branch = evidence.branches.find(({ source, line: candidate }) => source.endsWith("/ProviderMarkArt.swift") && candidate === line);
    const classification = evidence.classifications.find(({ occurrenceId }) => occurrenceId === branch.id);
    assert.deepEqual(classification.stateIds, [stateId]);
    const link = manifest.entries.find(({ id }) => id === stateId).audit.find(({ id }) => id === branch.id);
    assert.equal(link.outcome, true);
  }
  assert.equal(providerNameCaseOutcome("codex", 87), true);
  assert.equal(providerNameCaseOutcome("codex-desktop", 87), false);
  assert.equal(providerNameCaseOutcome("codex-desktop", 88), true);
  assert.equal(providerNameCaseOutcome("codex", 88), false);
  assert.equal(providerNameCaseOutcome("claude-code-desktop", 89), true);
  assert.equal(providerNameCaseOutcome("claude", 89), false);
  assert.equal(providerNameCaseOutcome("claude", 90), true);
  assert.equal(providerNameCaseOutcome("claude-code-desktop", 90), false);
});

test("every retained Pill render backlink has semantic outcome evidence", async () => {
  const { manifest, evidence } = await loadInventory();
  const renderSources = /\/(?:PillView|Waveform|ProviderMark|ProviderMarkArt)\.swift$/;
  for (const item of evidence.branches.filter(({ source, line }) => renderSources.test(source) && !(source.endsWith("/Waveform.swift") && line >= 142))) {
    const classification = evidence.classifications.find(({ occurrenceId }) => occurrenceId === item.id);
    if (classification.stateIds.some((id) => id.startsWith("pill-"))) {
      for (const stateId of classification.stateIds.filter((id) => id.startsWith("pill-"))) {
        const link = manifest.entries.find(({ id }) => id === stateId).audit.find(({ id }) => id === item.id);
        assert.equal(typeof link.outcome, "boolean");
        assert.ok(Array.isArray(link.ancestors));
      }
    }
    else assert.equal(classification.kind, "render-input");
  }
});

test("the audit uses the approved immutable revision and reports HEAD drift separately", async () => {
  const { evidence } = await loadInventory();
  assert.equal(evidence.sourceRevision, CURRENT_REVISION);
  assert.match(evidence.productHead, /^[a-f0-9]{40}$/);
  assert.equal(evidence.sourceDrift, evidence.productHead !== CURRENT_REVISION);
  assert.ok(evidence.files.every((source) =>
    source.startsWith("desktop/native-notch/Sources/") ||
    source === "desktop/electron/remote/notch/pill-controller.ts" ||
    source === "desktop/electron/remote/notetakerWidget.ts" ||
    source === "desktop/engine-overrides/renderer/widget/pillBridge.ts" ||
    source.startsWith("desktop/engine-overrides/renderer/notetaker/"),
  ));
  assert.ok(!evidence.files.some((source) => source.startsWith("backend/")));
  assert.ok(!evidence.files.some((source) => source.includes("/electron/notetaker/")));
  assert.ok(evidence.enumCases.length > 0);
  assert.ok(evidence.branches.length > 0);
  assert.ok(evidence.sfSymbols.length > 0);
  assert.ok(evidence.metrics.length > 0);
  assert.ok(evidence.tokens.length > 0);
});

test("curated render states carry renderable fixtures, honest interactions, and pending baselines", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.ok(manifest.entries.length > 0);
  assert.ok(manifest.entries.length < evidence.branches.length);
  assert.deepEqual(validateManifest(manifest, evidence), []);

  for (const entry of manifest.entries) {
    const fixture = manifest.fixtures[entry.fixture];
    assert.equal(fixture.stateId, entry.id);
    assert.equal(typeof fixture.input.surface, "string");
    assert.ok(Object.keys(fixture.input).length >= 2);
    assert.equal(entry.baseline.status, "pending");
    assert.match(entry.baseline.reason, /Task 2/);
    if (entry.interactions.kind === "interactive") {
      assert.ok(entry.interactions.controls.length > 0);
      assert.ok(entry.interactions.controls.every((control) => control.id && control.event && control.result));
    } else {
      assert.equal(entry.interactions.kind, "none");
      assert.ok(entry.interactions.reason);
    }
  }
});

test("family fixtures preserve exact source model values and transitions", async () => {
  const { manifest } = await loadInventory();
  const state = (id) => manifest.entries.find((entry) => entry.id === id);
  const input = (id) => manifest.fixtures[state(id).fixture].input;
  const controls = (id) => state(id).interactions.controls;

  assert.equal(input("pill-recording-remote-warning").surface, "pill");
  assert.deepEqual(Object.fromEntries(["phase", "kind", "taskId", "level", "elapsed", "maxSeconds"].map((key) => [key, input("pill-recording-remote-warning").state[key]])),
    { phase: "recording", kind: "remote", taskId: "task-42", level: 0.64, elapsed: 286, maxSeconds: 300 });
  assert.deepEqual(controls("pill-recording-remote-warning").map(({ event, result }) => [event, result]), [
    ["click discard", { type: "pillCancel" }], ["click finish", { type: "pillStop" }],
  ]);
  assert.equal(input("pill-payment-failed").state.offline, "payment_failed");
  assert.equal(controls("pill-payment-failed")[0].result.type, "pillOpenBillingPortal");

  assert.deepEqual(input("notch-agent-confirming").model.agentActivity, {
    state: "confirming", summary: "confirming release work", interactionId: "interaction-7", agentRunId: "run-3", provider: "codex",
  });
  assert.equal(input("notch-pocket-waiting-hover-detail").model.pocket.waiting, 2);

  assert.equal(input("pocket-task-question").pocket.slots[0].ask, "Which environment should I deploy to?");
  assert.equal(input("pocket-agent-listening").model.captureAimed, true);
  assert.equal(controls("pocket-task-question")[0].result.type, "pocketExpand");

  assert.equal(input("conversation-question-choice").task.question.kind, "choice");
  assert.deepEqual(input("conversation-question-choice").task.question.choices, ["Staging", "Production"]);
  assert.equal(controls("conversation-question-choice")[0].result.type, "questionAnswer");
  assert.equal(input("conversation-composer-attachment").task.draft.attachments[0].mimeType, "image/png");
  assert.equal(input("conversation-composer-attachment").task.chatConfig.permission, "workspace-write");

  assert.equal(input("cockpit-route-offer").cockpit.routeOffer.altName, "Release checklist");
  assert.equal(controls("cockpit-route-offer")[0].result.type, "offerAccept");

  assert.equal(input("scratchpad-delivering").scratchpad.delivering, true);
  assert.equal(input("scratchpad-entry").scratchpad.pad.entries[0].startMs, 1200);
  assert.equal(controls("scratchpad-entry")[0].result.type, "scratchRemoveEntry");

  assert.deepEqual(input("notetaker-recording").widget, { sessionId: 7, completed: false, showDiscard: false, levels: [0, 0.12, 0.35, 0.64, 0.88, 0.64, 0.35, 0.12, 0, 0, 0] });
  assert.equal(controls("notetaker-recording")[0].result.showDiscard, true);
  assert.equal(input("notetaker-meeting-notes-pending").meeting.summary_status, "pending");
  assert.equal(input("notetaker-settings-unavailable").settings.availability.codex, false);

  assert.equal(input("new-conversation-managed-preview").preview.permission, "workspace");
  assert.equal(input("new-conversation-project-requested").form.permission, "ask");
  assert.equal(controls("new-conversation-project-requested").find(({ id }) => id === "create").result.type, "newChat");
});

test("every audited branch has an explicit, justified classification", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  assert.deepEqual(validateManifest(manifest, evidence), []);
  const occurrenceCount = ["enumCases", "branches", "sfSymbols", "metrics", "tokens"]
    .reduce((total, category) => total + evidence[category].length, 0);
  assert.equal(evidence.classifications.length, occurrenceCount);
  for (const classification of evidence.classifications) {
    assert.ok(["render-affecting", "render-input", "non-rendering"].includes(classification.kind));
    assert.ok(classification.reason);
    if (classification.kind === "non-rendering") assert.deepEqual(classification.stateIds, []);
    else if (classification.stateIds.length === 0) assert.match(classification.reason, /shared visual evidence|source-model input/);
  }
});

test("actual visual and nonvisual occurrences receive source-specific classifications", async () => {
  const { evidence } = await loadInventory();
  const classification = (suffix, line) => {
    const item = evidence.branches.find((branch) => branch.source.endsWith(suffix) && branch.line === line);
    return evidence.classifications.find((entry) => entry.occurrenceId === item.id);
  };
  assert.equal(classification("PillView.swift", 538).kind, "render-affecting");
  assert.match(classification("PillView.swift", 538).reason, /final 15 seconds/);
  assert.equal(classification("NotetakerWidget.tsx", 446).kind, "non-rendering");
  assert.match(classification("NotetakerWidget.tsx", 446).reason, /audio sample|waveform amplitude/i);
  assert.equal(classification("PillModel.swift", 276).kind, "non-rendering");
  assert.match(classification("PillModel.swift", 276).reason, /serializes.*pillStop/i);
});

test("validation independently rejects broken schema and coverage relationships", async () => {
  const { manifest, evidence, validateManifest } = await loadInventory();
  const cases = [
    ["missing source revision", (m) => delete m.sourceRevision, /source revision/i],
    ["duplicate IDs", (m) => m.entries.push(structuredClone(m.entries[0])), /duplicate entry id/i],
    ["absent citations", (m) => { m.entries[0].source = ""; }, /citation/i],
    ["unknown fixture IDs", (m) => { m.entries[0].fixture = "unknown"; }, /unknown fixture/i],
    ["orphan fixtures", (m) => { m.fixtures.orphan = { stateId: "missing", input: { surface: "pill", variant: "idle", data: {} } }; }, /orphan fixture/i],
    ["fixture backlinks", (m) => { m.fixtures[m.entries[0].fixture].stateId = m.entries[1].id; }, /backlink/i],
    ["empty fixture payloads", (m) => { m.fixtures[m.entries[0].fixture].input = {}; }, /fixture input/i],
    ["invalid interactions", (m) => { m.entries[0].interactions = []; }, /interactions/i],
    ["fabricated baselines", (m) => { m.entries[0].baseline = "native/fake.png"; }, /baseline/i],
    ["unknown audit IDs", (m) => { m.entries[0].audit.push("branch:unknown:1:1"); }, /unknown audit/i],
    ["citation disagreement", (m) => { m.entries[0].condition = "fabricated"; }, /citation agreement/i],
    ["missing classification", (_m, e) => { e.classifications.pop(); }, /unclassified audited occurrence/i],
    ["unknown state backlink", (_m, e) => { e.classifications.find((c) => c.kind !== "non-rendering").stateIds.push("missing-state"); }, /unknown state backlink/i],
    ["missing state backlink", (m) => { m.entries[0].audit = []; }, /audit backlink/i],
    ["malformed Pill coaching", (m) => { const e = m.entries.find(({ id }) => id === "pill-hint-coaching-quiet"); m.fixtures[e.fixture].input.state.coaching = { kind: "quiet", remedy: "Speak louder" }; }, /coaching schema/i],
    ["false Pill predicate outcome", (m) => { const e = m.entries.find(({ family }) => family === "pill"); e.predicates[0].outcome = !e.predicates[0].outcome; }, /predicate outcome mismatch/i],
    ["invented Pill control provenance", (m) => { const e = m.entries.find(({ id }) => id === "pill-cancelled"); e.interactions.controls[0].provenance.line = 999; }, /control provenance/i],
    ["invented Pill local state", (m) => { const e = m.entries.find(({ family }) => family === "pill"); m.fixtures[e.fixture].input.viewState.controlState = "pressed"; }, /local view state/i],
    ["false linked branch outcome", (m) => { const e = m.entries.find(({ family, audit }) => family === "pill" && audit.some(({ id }) => id.startsWith("branch:"))); const link = e.audit.find(({ id }) => id.startsWith("branch:")); link.outcome = !link.outcome; }, /branch outcome/i],
    ["provider fixture mismatch", (m) => { const e = m.entries.find(({ id }) => id === "pill-provider-codex-cli"); m.fixtures[e.fixture].input.state.agentOptions[0].terminal = false; }, /provider expectation mismatch/i],
    ["provider exact-case alias", (m) => { const e = m.entries.find(({ id }) => id === "pill-provider-codex-cli"); const input = m.fixtures[e.fixture].input; input.state.agentOptions.find(({ label }) => label === input.state.agent).id = "codex-desktop"; e.expectations.providerMark = { backend: "codex-desktop", vendor: "codex", name: "Codex desktop", terminal: true, art: "embedded" }; }, /branch outcome/i],
    ["wrong Notch signature", (m) => { const e = m.entries.find(({ id }) => id === "notch-silenced-hardware-empty"); m.fixtures[e.fixture].input.model.silenced[0] = "needs-user|Needs you|Which environment should I deploy to?|0"; }, /derived expectation|branch outcome/i],
    ["invented Notch geometry label", (m) => { const e = m.entries.find(({ id }) => id === "notch-right-segment-fit"); m.fixtures[e.fixture].input.geometry.rightAllocation = "fit"; }, /invented Notch projection/i],
    ["forged Notch emit line", (m) => { const e = m.entries.find(({ id }) => id === "notch-pocket-waiting-one"); e.interactions.controls[0].provenance.line = 77; }, /control provenance/i],
    ["wrong Notch measured allocation", (m) => { const e = m.entries.find(({ id }) => id === "notch-right-segment-boundary-54"); m.fixtures[e.fixture].input.expectation.geometry.allocatedRightWidth = 53; }, /derived expectation/i],
    ["unreachable off-notch dormant", (m) => { const e = m.entries.find(({ id }) => id === "notch-idle-resting-nub"); m.fixtures[e.fixture].input.model.state = "dormant"; }, /unreachable stable off-notch dormant/i],
    ["wrong NotchState switch fixture", (m) => { const e = m.entries.find(({ id }) => id === "notch-attention-needs-user"); m.fixtures[e.fixture].input.model.state = "active"; }, /branch outcome/i],
    ["forged userLeft emit line", (m) => { const e = m.entries.find(({ id }) => id === "notch-departure-expanded-hide"); e.interactions.controls[0].provenance.line = 1800; }, /control provenance/i],
    ["forged userReturned emit line", (m) => { const e = m.entries.find(({ id }) => id === "notch-departure-return"); e.interactions.controls[0].provenance.line = 1800; }, /control provenance/i],
  ];

  for (const [name, mutate, expected] of cases) {
    const candidateManifest = structuredClone(manifest);
    const candidateEvidence = structuredClone(evidence);
    mutate(candidateManifest, candidateEvidence);
    assert.match(validateManifest(candidateManifest, candidateEvidence).join("\n"), expected, name);
  }
});
