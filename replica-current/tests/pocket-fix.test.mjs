import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as audit from "../scripts/audit-source.mjs";

const saved = JSON.parse(
  await readFile(new URL("../fixtures/audit.json", import.meta.url)),
);
const inventory = () => audit.createInventory(saved);
const input = (m, id) => m.fixtures[`fixture-${id}`].input;
const entry = (m, id) => m.entries.find((e) => e.id === id);
const branch = (m, id, file, line) =>
  entry(m, id).audit.find((a) => a.id.includes(`/${file}:${line}:`));

test("F1 compact branches and ordered parents reflect reachable Swift execution", () => {
  const { manifest: m, evidence } = inventory();
  const compact = entry(m, "pocket-agent-listening").audit.filter((a) =>
    a.id.includes("/Waveform.swift:"),
  );
  assert.equal(compact.length, 8);
  for (const b of compact) {
    assert.equal(b.outcome, true);
    assert.deepEqual(
      b.ancestors.map((a) => a.predicate),
      [
        "expanded branch not selected",
        "model.pocket.isOpen",
        "hasNotch",
        "listening",
      ],
    );
  }
  for (const [id, line, parent] of [
    ["pocket-quiet-dot-footer-mismatch", 485, "!headerInShoulders"],
    ["pocket-task-question", 451, "toast ?? nonempty ask exists"],
    ["pocket-quiet-dot-footer-mismatch", 497, "task slot || headerInShoulders"],
    [
      "pocket-status-unknown-demanding",
      176,
      "known status branch not selected",
    ],
  ]) {
    assert.equal(
      branch(m, id, "PocketView.swift", line).ancestors.at(-1).predicate,
      parent,
    );
  }
  for (const line of [108, 138, 139])
    assert.equal(
      evidence.classifications.find((c) =>
        c.occurrenceId.startsWith(
          `branch:desktop/native-notch/Sources/unmute-notch/PocketView.swift:${line}:`,
        ),
      ).kind,
      "non-rendering",
    );
  assert.ok(
    !entry(m, "pocket-swipe-precise-next").audit.some((a) =>
      a.id.includes("PocketSwipeArea.swift:53:"),
    ),
  );
  assert.equal(
    branch(m, "pocket-swipe-precise-next", "PocketSwipe.swift", 80).outcome,
    true,
  );
  assert.equal(
    branch(m, "pocket-swipe-precise-next", "PocketSwipe.swift", 87).outcome,
    false,
  );
  assert.deepEqual(
    branch(
      m,
      "pocket-status-processing",
      "PocketView.swift",
      175,
    ).ancestors.map((a) => a.predicate),
    [
      "expanded branch not selected",
      "model.pocket.isOpen",
      "!hasNotch",
      "!headerInShoulders",
      "quiet branch not selected",
    ],
  );
});

test("F2 snapshot uses override identity, live rail and live transient values with no hit testing", () => {
  const { manifest: m } = inventory();
  const s = input(m, "pocket-transition-snapshot");
  assert.notDeepEqual(s.pocket, s.model.transitionPocket);
  assert.equal(s.expectation.rendered, true);
  assert.equal(s.expectation.snapshotVisible, true);
  assert.equal(s.expectation.liveCardVisible, false);
  assert.equal(s.expectation.expandedContentVisible, false);
  assert.equal(s.expectation.hitTestable, false);
  assert.equal(s.expectation.currentId, "snapshot-task");
  assert.equal(s.expectation.headerInShoulders, false);
  assert.equal(s.expectation.rail, true);
  assert.equal(s.expectation.count, "1/1");
  const n = input(m, "pocket-transition-snapshot-notched");
  assert.equal(n.expectation.arrangement, "card");
  assert.equal(n.expectation.headerInShoulders, false);
  assert.equal(n.expectation.visibleMiddle, "Live handoff toast");
  assert.equal(n.expectation.footer.level, 0.82);
});

test("F3 invalid current keeps dashboard, release, arrows and swipe but cannot expand", () => {
  const { manifest: m } = inventory();
  for (const id of [
    "pocket-open-invalid-negative",
    "pocket-open-invalid-high",
  ]) {
    assert.deepEqual(
      entry(m, id).interactions.controls?.map((c) => c.id),
      ["dashboard", "release", "previous", "next"],
    );
    assert.equal(input(m, id).expectation.swipeEnabled, true);
  }
});

test("F5 keyboard guards, popup precedence and nil current produce exact consumption and emissions", () => {
  assert.equal(typeof audit.evaluatePocketSequence, "function");
  const { manifest: m } = inventory();
  const base = input(m, "pocket-page-middle");
  const key = (keyCode, extra = {}) => ({
    type: "key",
    keyCode,
    modifiers: [],
    firstResponder: "view",
    eventWindow: "pocket",
    ...extra,
  });
  for (const [action, result] of [
    [key(123), { type: "pocketMove", delta: -1 }],
    [key(124), { type: "pocketMove", delta: 1 }],
    [key(36), { type: "pocketExpand", id: "task-2" }],
    [key(76), { type: "pocketExpand", id: "task-2" }],
    [key(124, { modifiers: ["option"] }), null],
    [key(124, { firstResponder: "editableText" }), null],
    [key(124, { firstResponder: "terminal" }), null],
    [key(124, { eventWindow: "other" }), null],
    [key(53), { type: "pocketRelease" }],
  ]) {
    const [r] = audit.evaluatePocketSequence(base, [action]);
    assert.deepEqual(r.events, result ? [result] : []);
    assert.equal(r.consumed, result !== null);
  }
  for (const id of ["pocket-open-invalid-negative", "pocket-open-invalid-high"])
    assert.deepEqual(
      audit.evaluatePocketSequence(input(m, id), [key(36)])[0].events,
      [],
    );
  assert.deepEqual(
    audit.evaluatePocketSequence(input(m, "pocket-task-question"), [
      key(123),
    ])[0].events,
    [],
  );
  const popup = structuredClone(base);
  popup.model.state = "task";
  popup.model.proposal = { id: "proposal-1" };
  const [r] = audit.evaluatePocketSequence(popup, [key(53)]);
  assert.deepEqual(r.events, [{ type: "converseStop", id: "proposal-1" }]);
  assert.equal(r.state.model.proposal, null);
  assert.equal(r.state.pocket.mode, "open");
});

test("F5 catcher foreign window preserves travel; bounds rejection, toggling and teardown reset it", () => {
  assert.equal(typeof audit.evaluatePocketSequence, "function");
  const { manifest: m } = inventory();
  const base = input(m, "pocket-page-middle");
  const scroll = (deltaX, extra = {}) => ({
    type: "scroll",
    eventWindow: "pocket",
    inside: true,
    sample: { deltaX, deltaY: 0 },
    ...extra,
  });
  const run = (actions) => audit.evaluatePocketSequence(base, actions);
  let rs = run([
    scroll(-20),
    scroll(-100, { eventWindow: "other" }),
    scroll(-6),
  ]);
  assert.deepEqual(
    rs.map((r) => r.consumed),
    [false, false, true],
  );
  assert.equal(rs[1].state.swipe.travelX, -20);
  rs = run([scroll(-20), scroll(-100, { inside: false }), scroll(-6)]);
  assert.deepEqual(
    rs.map((r) => r.consumed),
    [false, false, false],
  );
  assert.equal(rs[1].state.swipe.travelX, 0);
  rs = run([
    scroll(-20),
    { type: "enabled", value: false },
    { type: "enabled", value: true },
    scroll(-6),
    { type: "stopMonitor" },
  ]);
  assert.equal(rs[3].consumed, false);
  assert.equal(rs[4].state.monitor, false);
  assert.deepEqual(rs[4].state.swipe, { travelX: 0, travelY: 0, spent: false });
  rs = run([
    scroll(-26),
    scroll(-26),
    scroll(-26, { sample: { deltaX: -26, deltaY: 0, isGestureStart: true } }),
  ]);
  assert.deepEqual(
    rs.map((r) => r.consumed),
    [true, false, true],
  );
  assert.deepEqual(audit.evaluatePocketSwipe([{ deltaX: 28, deltaY: 20 }]), []);
  assert.deepEqual(
    audit.evaluatePocketSwipe([
      { deltaX: -0.5, deltaY: 0, hasPreciseDeltas: false },
      { deltaX: -0.5, deltaY: 0, hasPreciseDeltas: false },
    ]),
    [1, 1],
  );
});

test("F5 controller sequences keep latest IDs, released focus, exact refits and content handoff", () => {
  assert.equal(typeof audit.evaluatePocketSequence, "function");
  const { manifest: m } = inventory();
  const base = input(m, "pocket-page-first");
  const changed = structuredClone(base.pocket);
  changed.slots.reverse();
  changed.slots[0].ask = "New question";
  const rs = audit.evaluatePocketSequence(base, [
    { type: "outsideClick" },
    { type: "payload", pocket: changed },
    { type: "insideClick" },
    {
      type: "key",
      keyCode: 36,
      eventWindow: "pocket",
      modifiers: [],
      firstResponder: "view",
    },
  ]);
  assert.equal(rs[0].state.controller.pocketHoldsKey, false);
  assert.equal(rs[0].state.pocket.mode, "open");
  assert.equal(rs[1].state.controller.pocketHoldsKey, false);
  assert.deepEqual(rs[1].refits, [{ animated: true, cardHeight: 106 }]);
  assert.equal(rs[2].state.controller.pocketHoldsKey, true);
  assert.deepEqual(rs[2].events, []);
  assert.deepEqual(rs[3].events, [{ type: "pocketExpand", id: "task-3" }]);
  const cap = audit.evaluatePocketSequence(base, [
    {
      type: "capture",
      phase: "recording",
      kind: "remote",
      capturePhase: "listening",
      level: 0.2,
    },
    {
      type: "capture",
      phase: "recording",
      kind: "remote",
      capturePhase: "listening",
      level: 0.8,
    },
  ]);
  assert.equal(cap[0].refits.length, 1);
  assert.equal(cap[1].refits.length, 0);
  for (const [prepared, reduce, delay] of [
    [false, false, true],
    [true, false, false],
    [false, true, false],
  ]) {
    const b = structuredClone(base);
    b.controller.motionReduceMotion = reduce;
    const [r] = audit.evaluatePocketSequence(b, [
      { type: "state", destination: "task", contentPrepared: prepared },
    ]);
    assert.equal(r.state.model.expandedContentReady, !delay);
    assert.equal(r.state.model.transitionPocket !== null, delay);
  }
  const handoff = audit.evaluatePocketSequence(base, [
    { type: "state", destination: "task", contentPrepared: false },
    { type: "state", destination: "task", contentPrepared: true },
    { type: "frameComplete", generation: 1 },
    { type: "state", destination: "idle", contentPrepared: true },
  ]);
  assert.equal(handoff[1].state.model.expandedContentReady, false);
  assert.equal(handoff[2].state.model.expandedContentReady, true);
  assert.equal(handoff[2].state.model.transitionPocket, null);
  assert.equal(handoff[3].state.controller.pocketHoldsKey, true);
  const stale = audit.evaluatePocketSequence(base, [
    { type: "state", destination: "task", contentPrepared: false },
    { type: "state", destination: "idle", contentPrepared: true },
    { type: "frameComplete", generation: 1 },
  ]);
  assert.equal(stale[2].branches.at(-1).outcome, false);
  const openAgain = audit.evaluatePocketSequence(base, [
    { type: "outsideClick" },
    { type: "payload", pocket: { ...base.pocket, mode: "closed" } },
    { type: "payload", pocket: base.pocket },
  ]);
  assert.equal(openAgain[2].state.controller.pocketHoldsKey, true);
  const noVisibleRefit = structuredClone(base);
  noVisibleRefit.model.state = "cockpit";
  assert.deepEqual(
    audit.evaluatePocketSequence(noVisibleRefit, [
      { type: "payload", pocket: changed },
    ])[0].refits,
    [],
  );
});

test("F1-F4/F7 reject accepted review mutations against apparently valid source locations", () => {
  const { manifest: m, evidence } = inventory();
  assert.deepEqual(audit.validateManifest(m, evidence), []);
  const mutations = [
    (x) => {
      entry(x, "pocket-task-question").interactions.controls[0].result.id =
        "wrong-task";
    },
    (x) => {
      entry(x, "pocket-task-question").interactions.controls[0].result = {
        type: "pocketExpand",
      };
    },
    (x) => {
      entry(x, "pocket-page-first").interactions.controls.find(
        (c) => c.id === "previous",
      ).result.delta = 99;
    },
    (x) => {
      entry(x, "pocket-page-first").interactions.controls.find(
        (c) => c.id === "previous",
      ).result.delta = 1;
    },
    (x) => {
      entry(
        x,
        "pocket-task-question",
      ).interactions.controls[0].provenance.line = 310;
    },
    (x) => {
      entry(x, "pocket-task-question").interactions = {
        kind: "none",
        reason: "arbitrary",
      };
    },
    (x) => {
      entry(x, "pocket-task-question").predicates = [];
    },
    (x) => {
      entry(x, "pocket-task-question").predicates.forEach(
        (p) => (p.outcome = !p.outcome),
      );
    },
    (x) => {
      branch(
        x,
        "pocket-task-question",
        "PocketView.swift",
        451,
      ).ancestors.pop();
    },
    (x) => {
      input(
        x,
        "pocket-transition-snapshot",
      ).model.transitionPocket.slots[0].id = "changed";
    },
    (x) => {
      input(x, "pocket-transition-reduce-motion").model.expandedContentReady =
        false;
    },
    (x) => {
      input(x, "pocket-keyboard-actions").controller.pocketHoldsKey = false;
    },
    (x) => {
      Object.assign(input(x, "pocket-task-question").geometry, {
        pocketCardWidth: 999,
        panelPadding: 99,
        fillet: 99,
      });
    },
    (x) => {
      delete input(x, "pocket-task-question").pocket.remoteKey;
    },
    (x) => {
      input(
        x,
        "pocket-transition-snapshot",
      ).model.transitionPocket.slots[0].title = "Changed snapshot title";
    },
    (x) => {
      entry(x, "pocket-page-first").interactions.controls.find(
        (c) => c.id === "next",
      ).result.delta = -1;
    },
    (x) => {
      entry(
        x,
        "pocket-task-question",
      ).interactions.controls[0].serialization.line = 735;
    },
    (x) => {
      input(x, "pocket-scroll-containment").controller.sequence[1].eventWindow =
        "pocket";
    },
    (x) => {
      input(
        x,
        "pocket-payload-focus-refits",
      ).controller.sequence[1].pocket.slots.reverse();
    },
    (x) => {
      delete input(x, "pocket-transition-snapshot").model.transitionPocket
        .remoteKey;
    },
    (x) => {
      input(x, "pocket-task-question").pocket.extraField = "forged";
    },
  ];
  for (const [i, change] of mutations.entries()) {
    const copy = structuredClone(m);
    change(copy);
    assert.ok(
      audit
        .validateManifest(copy, evidence)
        .some((e) => !e.startsWith("Product source drift")),
      `mutation ${i} accepted`,
    );
  }
});

test("F6 closed Pocket fixtures freeze actual bar output and discriminate first versus current", () => {
  const { manifest: m } = inventory();
  assert.equal(
    input(m, "pocket-closed-empty").expectation.closedBar?.resting,
    true,
  );
  assert.equal(
    input(m, "pocket-closed-slots-quiet").expectation.closedBar?.left,
    null,
  );
  const h = input(m, "pocket-closed-hover-first-not-current").expectation
    .closedBar;
  assert.equal(h?.left, "2 waiting on you");
  assert.equal(h?.right, "First task");
  assert.equal(h?.dot, "needs-user");
});

test("F5 child buttons and shoulder identity do not also expand the parent card", () => {
  const { manifest: m } = inventory();
  const base = input(m, "pocket-page-middle");
  for (const [target, want] of [
    ["dashboard", { type: "openDashboard" }],
    ["release", { type: "pocketRelease" }],
    ["previous", { type: "pocketMove", delta: -1 }],
    ["next", { type: "pocketMove", delta: 1 }],
    ["card", { type: "pocketExpand", id: "task-2" }],
    ["shoulderIdentity", null],
  ]) {
    assert.deepEqual(
      audit.evaluatePocketSequence(base, [{ type: "click", target }])[0].events,
      want ? [want] : [],
    );
  }
  assert.deepEqual(
    audit.evaluatePocketSequence(input(m, "pocket-open-invalid-negative"), [
      { type: "click", target: "card" },
    ])[0].events,
    [],
  );
  assert.deepEqual(
    audit.evaluatePocketSequence(input(m, "pocket-transition-snapshot"), [
      { type: "click", target: "dashboard" },
    ])[0].events,
    [],
  );
});

test("F7 geometry arithmetic and optical configurations agree with independently read pinned constants", () => {
  const read = (name) =>
    execFileSync(
      "git",
      [
        "-C",
        audit.SOURCE_ROOT,
        "show",
        `${audit.SOURCE_REVISION}:desktop/native-notch/Sources/${name}`,
      ],
      { encoding: "utf8" },
    );
  const sizes = read("SurfaceSizeSupport/PocketCardHeight.swift");
  const constant = (name) =>
    Number(sizes.match(new RegExp(`let ${name}: CGFloat = (\\d+)`))[1]);
  const quiet =
    constant("pocketCardPadTop") +
    constant("pocketHeaderHeight") +
    constant("pocketRowGap") +
    constant("pocketFootHeight") +
    constant("pocketCardPadBottom");
  assert.equal(quiet, 68);
  assert.equal(
    quiet + constant("pocketAskRowHeight") + constant("pocketRowGap"),
    106,
  );
  const { manifest: m } = inventory();
  const q = input(m, "pocket-task-question").expectation;
  const n = input(m, "pocket-notched-question").expectation;
  assert.equal(q.frame.height, 118);
  assert.equal(n.frame.height, 152);
  assert.equal(q.plane.horizontal, 20);
  assert.equal(q.plane.radius, 12);
  assert.equal(
    input(m, "pocket-narrow-shoulders-long-title").expectation.shoulders
      .sideWidth,
    47,
  );
  assert.equal(
    input(m, "pocket-narrow-shoulders-long-title").expectation.shoulders
      .controlRequiredWidth,
    47,
  );
  const art = read("unmute-notch/ProviderMarkArt.swift");
  const ink = (name) =>
    Number(art.match(new RegExp(`${name}Ink: CGFloat = ([0-9.]+)`))[1]);
  assert.equal(q.mark.scale, Math.sqrt(ink("claude") / ink("codex")));
  assert.equal(
    input(m, "pocket-provider-nil-notchless").expectation.mark.vendor,
    "claude",
  );
  assert.equal(
    input(m, "pocket-provider-nil-notchless").expectation.mark.scale,
    1,
  );
  assert.equal(q.provenance["plane.clip"].line, 492);
});

test("F6 representative combinations cannot disappear from Pocket coverage", () => {
  const { manifest: m } = inventory();
  const xs = m.entries
    .filter((e) => e.family === "pocket")
    .map((e) => input(m, e.id));
  for (const hasNotch of [true, false])
    for (const kind of [null, "agent"]) {
      assert.ok(
        xs.some(
          (x) =>
            x.geometry.hasNotch === hasNotch &&
            x.model.captureAimed &&
            x.pocket.slots[x.pocket.at]?.kind === kind &&
            x.pocket.slots.length > 1 &&
            x.model.toast,
        ),
      );
    }
  for (const terminal of [true, false, null])
    assert.ok(
      xs.some(
        (x) =>
          x.pocket.slots[x.pocket.at]?.kind !== "agent" &&
          x.pocket.slots[x.pocket.at]?.terminal === terminal,
      ),
    );
  for (const backend of [
    "claude",
    "codex",
    "claude-code-desktop",
    null,
    "unknown",
  ])
    assert.ok(xs.some((x) => x.pocket.slots[x.pocket.at]?.backend === backend));
  assert.ok(xs.some((x) => x.geometry.pocketCutoutWidth >= 228));
  assert.ok(
    xs.some((x) => x.geometry.hasNotch && x.expectation.title.length > 70),
  );
  assert.ok(xs.some((x) => x.model.toast?.length > 100));
  assert.ok(
    xs.some(
      (x) =>
        x.model.state === "cockpit" &&
        x.pocket.mode === "open" &&
        x.pocket.slots.length,
    ),
  );
  assert.ok(
    xs.some(
      (x) =>
        x.model.hovering &&
        x.pocket.mode === "closed" &&
        x.pocket.at !== 0 &&
        x.expectation.closedDetail === "First task",
    ),
  );
});

test("F7 token composition and source mapped metrics preserve exact Pocket configurations", () => {
  const { manifest: m } = inventory();
  const e = input(m, "pocket-task-question").expectation;
  assert.equal(e.middleColor, "Theme.text.opacity(0.72)");
  assert.equal(e.tokens.ask.effectiveAlpha, 0.684);
  assert.equal(e.tokens.rail.effectiveAlpha, 0.665);
  assert.equal(e.metrics.headerReservation, 46);
  assert.equal(e.metrics.overlayPadding, 9);
  assert.deepEqual(e.typography.ask, {
    size: 12,
    weight: "regular",
    lines: 2,
    truncation: "tail",
  });
  assert.equal(e.metrics.roundStroke, 0.5);
  assert.equal(e.mark.size, 14);
  assert.equal(e.provenance["metrics.headerReservation"].line, 504);
  const chip = input(m, "pocket-agent-listening").expectation;
  assert.equal(chip.assetConfigurations.mic.size, 8.5);
  assert.equal(chip.assetConfigurations.mic.source.line, 143);
});

test("F4 pinned extraction retains arguments, dead-site classification and IPC serialization", async () => {
  const sites = await audit.pocketControlEmitSites();
  assert.deepEqual(
    sites.find((s) => s.source.endsWith("/PocketView.swift") && s.line === 465)
      ?.arguments,
    { id: "slot?.id" },
  );
  assert.equal(
    sites.find((s) => s.source.endsWith("/PocketView.swift") && s.line === 310)
      ?.reachable,
    false,
  );
  assert.deepEqual(
    sites.find(
      (s) => s.source.endsWith("/AppController.swift") && s.line === 1619,
    )?.arguments,
    { delta: "-1" },
  );
  assert.equal(typeof audit.pocketEventContracts, "function");
  const contracts = await audit.pocketEventContracts();
  assert.deepEqual(
    contracts.arrows.map((a) => [a.symbol, a.delta, a.line]),
    [
      ["chevron.left", -1, 244],
      ["chevron.right", 1, 248],
    ],
  );
  assert.deepEqual(contracts.ipc.pocketMove.fields, {
    type: '"pocketMove"',
    delta: "delta",
  });
  assert.equal(contracts.ipc.pocketExpand.optionalId, true);
  const { manifest: m } = inventory();
  const controls = entry(m, "pocket-page-middle").interactions.controls;
  assert.deepEqual(controls.find((c) => c.id === "expand").result, {
    type: "pocketExpand",
    id: "task-2",
  });
  assert.equal(controls.find((c) => c.id === "expand").serialization.line, 738);
});

test("F5 catcher lifetime follows visible Pocket and leaves no spent gesture on remount", () => {
  const { manifest: m } = inventory();
  const scroll = {
    type: "scroll",
    eventWindow: "pocket",
    inside: true,
    sample: { deltaX: -26, deltaY: 0 },
  };
  const rs = audit.evaluatePocketSequence(input(m, "pocket-page-first"), [
    scroll,
    { type: "state", destination: "task", contentPrepared: true },
    scroll,
    { type: "state", destination: "idle", contentPrepared: true },
    scroll,
  ]);
  assert.equal(rs[1].state.monitor, false);
  assert.equal(rs[2].consumed, false);
  assert.equal(rs[4].consumed, true);
  const closed = input(m, "pocket-closed-empty");
  assert.equal(
    audit.evaluatePocketSequence(closed, [scroll])[0].state.monitor,
    false,
  );
});

test("F5 unchanged enablement, foreign windows and momentum never reset a spent latch", () => {
  const { manifest: m } = inventory();
  const scroll = (deltaX, extra = {}) => ({
    type: "scroll",
    eventWindow: "pocket",
    inside: true,
    sample: { deltaX, deltaY: 0 },
    ...extra,
  });
  const rs = audit.evaluatePocketSequence(input(m, "pocket-page-first"), [
    scroll(-26),
    { type: "enabled", value: true },
    scroll(-26, { eventWindow: "other" }),
    scroll(-26, { sample: { deltaX: -26, deltaY: 0, isMomentum: true } }),
    scroll(-26),
    scroll(0, { sample: { deltaX: 0, deltaY: 0, isGestureEnd: true } }),
    scroll(-26),
  ]);
  assert.deepEqual(
    rs.map((r) => r.consumed),
    [true, false, false, false, false, false, true],
  );
  assert.equal(rs[3].state.swipe.spent, true);
});
