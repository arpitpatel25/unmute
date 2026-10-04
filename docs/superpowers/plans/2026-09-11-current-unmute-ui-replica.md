# Current Unmute UI Replica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-complete, visually measured DOM port of every current Unmute pill and native-notch UI state.

**Architecture:** A state manifest is the spine: each specimen identifies the native source branch, fixture payload, exact assets, browser renderer, and baseline image. A native JSONL harness drives the unmodified Swift helper for reference captures; small browser modules port one native view family each and Playwright compares both behavior and pixels.

**Tech Stack:** Plain HTML/CSS/ES modules, Node.js, Playwright, Swift native helper driven over JSONL IPC.

**Spec:** `docs/redesign/current-ui-replica-spec.md`

## Global Constraints

- Product source `/Users/zodpatel/tools/unmute/unmute-cloud` is read-only.
- Source baseline is revision `20dfd8fe5135371b7c4b5178a4124225a2e15662`; drift must fail verification.
- No dependencies or framework migration.
- No Unicode or CSS-drawn substitute for SF Symbols or product/provider marks.
- Existing `replica/` and `experience/` remain unchanged.
- Each specimen must cite a native file, symbol, and render condition.
- Each interactive branch must be reachable directly by fixture URL and by its real control.

---

### Task 1: Replace the invalid atlas with an auditable state manifest

**Files:**
- Delete: `replica-v2/index.html`, `replica-v2/styles.css`, `replica-v2/app.js`, `replica-v2/README.md`, `replica-v2/verify.mjs`
- Create: `replica-current/fixtures/manifest.json`
- Create: `replica-current/tests/manifest.test.mjs`
- Create: `replica-current/scripts/audit-source.mjs`

**Interfaces:**
- Produces: manifest entries `{id, family, source, symbol, condition, fixture, interactions, baseline}`.
- Produces: source audit report listing every enum case, conditional branch, SF Symbol, literal metric, and color/material token.

- [ ] Write a manifest test that fails for missing source revision, duplicate IDs, absent citations, unknown fixture IDs, and uncovered audited branches.
- [ ] Run `node --test replica-current/tests/manifest.test.mjs` and verify it fails because the manifest does not exist.
- [ ] Implement the source auditor and initial complete manifest skeleton from all native-notch Swift files plus pill/notetaker TypeScript sources.
- [ ] Run the manifest test and resolve every uncovered branch without adding exclusions lacking a written reason.
- [ ] Commit the auditable inventory.

### Task 2: Build deterministic native baselines and exact symbol assets

**Files:**
- Create: `replica-current/native/fixtures/*.jsonl`
- Create: `replica-current/native/capture.mjs`
- Create: `replica-current/native/render-symbols.swift`
- Create: `replica-current/assets/symbols/*`
- Create: `replica-current/assets/marks/*`
- Create: `replica-current/tests/native-fixtures.test.mjs`

**Interfaces:**
- Consumes: manifest fixture and baseline fields.
- Produces: deterministic PNG baselines and symbol assets indexed by manifest ID and source configuration.

- [ ] Write tests that require one baseline per materially different state and one exact asset per audited symbol/mark.
- [ ] Verify tests fail before assets and captures exist.
- [ ] Build the current native helper from the read-only product tree and drive it with fixture JSONL using `UNMUTE_FAKE_NOTCH`.
- [ ] Capture each native state on a frozen backdrop at native scale and crop by measured panel bounds.
- [ ] Render SF Symbols using `NSImage(systemSymbolName:)` and source-defined symbol configurations; port custom mark paths directly.
- [ ] Pass fixture/assets tests and commit baselines separately from browser implementation.

### Task 3: Port foundations and primitive controls

**Files:**
- Create: `replica-current/index.html`
- Create: `replica-current/styles/tokens.css`
- Create: `replica-current/styles/primitives.css`
- Create: `replica-current/src/atlas.js`
- Create: `replica-current/src/primitives.js`
- Create: `replica-current/tests/foundations.spec.mjs`

**Interfaces:**
- Produces: `renderSymbol`, `renderMark`, `renderStatus`, `renderButton`, `renderWaveform`, and shared shape/material classes.

- [ ] Write Playwright assertions for every exact Theme, NotchShape, button, badge, mark, and waveform metric.
- [ ] Verify they fail against an empty atlas.
- [ ] Transcribe tokens and primitives with source citations adjacent to each declaration.
- [ ] Compare primitives against native crops and tune only from measured diffs.
- [ ] Pass exact-value, interaction, reduced-motion, and visual checks; commit.

### Task 4: Port every pill state and interaction

**Files:**
- Create: `replica-current/src/pill/model.js`
- Create: `replica-current/src/pill/view.js`
- Create: `replica-current/styles/pill.css`
- Create: `replica-current/tests/pill.spec.mjs`

**Interfaces:**
- Consumes: manifest pill fixtures and primitives.
- Produces: `renderPill(state)` and `dispatchPillEvent(event)`.

- [ ] Generate failing tests from every `PillPhase`, `PillKind`, offline reason, menu, microphone/raw/coaching branch, timer boundary, and Agent lane entry.
- [ ] Port `PillModel.swift`, `PillView.swift`, `Waveform.swift`, provider controls, and the TS controller branch-for-branch.
- [ ] Wire hover, pressed, stop, cancel, undo, draft, model/axis/provider/mic selection, raw toggle, billing, and dismissal events.
- [ ] Run per-fixture screenshot comparisons and resolve layout differences before material differences.
- [ ] Pass all pill tests and commit.

### Task 5: Port notch bar and Pocket

**Files:**
- Create: `replica-current/src/notch/{geometry,bar,view}.js`
- Create: `replica-current/src/pocket/{model,view}.js`
- Create: `replica-current/styles/{notch,pocket}.css`
- Create: `replica-current/tests/{notch,pocket}.spec.mjs`

**Interfaces:**
- Produces: `renderNotch(model, geometry)` and `renderPocket(model)` with source-equivalent state transitions.

- [ ] Write failing tests for all state/status/geometry combinations and every Pocket face, shoulder, card, focus, scroll, swipe, and empty branch.
- [ ] Port shape paths and bar placement arithmetic exactly before adding content.
- [ ] Port BarContent precedence and conditional icon/text visibility branch-for-branch.
- [ ] Port Pocket metrics, cards, Agent treatment, gestures, actions, and expansion.
- [ ] Pass geometry, behavior, and visual comparisons; commit.

### Task 6: Port task and Agent conversations

**Files:**
- Create: `replica-current/src/conversation/*.js`
- Create: `replica-current/styles/conversation.css`
- Create: `replica-current/tests/conversation.spec.mjs`

**Interfaces:**
- Produces: `renderTaskSurface(payload)`, `renderAgentSurface(payload)`, `renderComposer(config, draft)`.

- [ ] Write generated failing tests for all conversation, block, stage, status, canvas, terminal, composer, attachment, staging, tool, setup-control, and failure branches.
- [ ] Port TaskSurfaceView and StageView, including question and dead-session states.
- [ ] Port block conversation and every BlockViews presentation.
- [ ] Port both composer families and all menus, popovers, attachments, dictation, busy/managed/error states.
- [ ] Port Canvas and terminal visual states using deterministic fixture content.
- [ ] Pass behavior and native screenshot comparisons; commit.

### Task 7: Port cockpit, scratchpad, note taker, and new conversation

**Files:**
- Create: `replica-current/src/cockpit/*.js`
- Create: `replica-current/src/scratchpad/*.js`
- Create: `replica-current/src/notetaker/*.js`
- Create: `replica-current/src/new-conversation.js`
- Create: `replica-current/styles/{cockpit,scratchpad,notetaker,new-conversation}.css`
- Create: `replica-current/tests/{cockpit,scratchpad,notetaker,new-conversation}.spec.mjs`

**Interfaces:**
- Produces renderers and event dispatch for every remaining top-level surface.

- [ ] Generate failing branch-coverage and interaction tests from the manifest.
- [ ] Port WallView and associated rail/group/project/queue/skill/proposal/import states.
- [ ] Port scratchpad entries, destinations, pending segments, menus, and actions.
- [ ] Port the current TypeScript note-taker widget state machine and exact assets.
- [ ] Port NewConversationSetup and every provider/permission/preview/pending/error branch.
- [ ] Pass behavior and native visual comparisons; commit.

### Task 8: Complete atlas navigation and enforce source drift

**Files:**
- Modify: `replica-current/index.html`
- Modify: `replica-current/src/atlas.js`
- Create: `replica-current/styles/atlas.css`
- Create: `replica-current/verify.mjs`
- Create: `replica-current/README.md`

**Interfaces:**
- Produces: `/replica-current/?state=<id>` deep links and grouped review navigation.

- [ ] Write failing tests for deep links, keyboard navigation, responsive review layout, manifest count, and source revision drift.
- [ ] Build a neutral atlas shell that never visually contaminates native specimen bounds.
- [ ] Add state search, family navigation, source citations, expected interactions, and baseline/diff toggles.
- [ ] Run all tests, visual comparisons, local-link checks, and `git diff --check`.
- [ ] Open the atlas for user review; do not integrate it into `experience/` until explicitly approved.
