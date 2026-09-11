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

test("the audit uses only approved visual source sets at current product HEAD", async () => {
  const { evidence } = await loadInventory();
  assert.equal(evidence.sourceRevision, CURRENT_REVISION);
  assert.equal(evidence.productHead, CURRENT_REVISION);
  assert.equal(evidence.sourceDrift, false);
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
    assert.equal(typeof fixture.input.variant, "string");
    assert.ok(Object.keys(fixture.input).length >= 3);
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
    else assert.ok(classification.stateIds.length > 0);
  }
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
  ];

  for (const [name, mutate, expected] of cases) {
    const candidateManifest = structuredClone(manifest);
    const candidateEvidence = structuredClone(evidence);
    mutate(candidateManifest, candidateEvidence);
    assert.match(validateManifest(candidateManifest, candidateEvidence).join("\n"), expected, name);
  }
});
