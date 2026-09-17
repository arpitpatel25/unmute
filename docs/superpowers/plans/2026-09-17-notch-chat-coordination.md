# Notch Chat Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix native notch history rendering, strict last-user-message ordering, existing-task model switching from both input surfaces, and pill/notch window stacking.

**Architecture:** Preserve the existing Electron-to-Swift IPC boundary. Put policy in small pure helpers where practical, route both model selectors through TaskManager's authoritative chat configuration, and make AppKit stacking a static invariant rather than event-order behavior.

**Tech Stack:** TypeScript/Node test runner, Swift/SwiftUI/AppKit, Swift Package Manager.

**Spec:** `docs/superpowers/specs/2026-09-17-notch-chat-coordination-design.md`

## Global Constraints

- Existing conversation model changes happen only between turns.
- `lastUserInputAt` is the durable ordering authority.
- Rich chat blocks may replace fallback rows only when they produce renderable conversation content.
- The active pill must remain above the notch regardless of presentation order.

---

### Task 1: Renderable conversation fallback

**Files:**
- Modify: `desktop/native-notch/Sources/ConversationSupport/BlockPresentation.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/ConversationPanel.swift`
- Test: `desktop/native-notch/Tests/ConversationSupportTests/BlockPresentationTests.swift`

**Interfaces:**
- Produces: a pure predicate that decides whether rich blocks yield visible chat content.
- Consumes: existing `BlockPresentation.build` and legacy `ConversationPresentation.blocks(from:)`.

- [ ] Write a failing Swift test where non-renderable partial blocks coexist with valid fallback rows.
- [ ] Run the focused Swift test and confirm it fails because rich blocks suppress the fallback.
- [ ] Add the minimal renderability helper and use it in `ConversationPanel.visibleBlocks`.
- [ ] Run the focused Swift test and existing conversation tests.

### Task 2: Strict user-interaction ordering

**Files:**
- Modify: `desktop/electron/remote/notch/notch-controller.ts`
- Test: `desktop/electron/remote/notch/notch-controller.test.ts`

**Interfaces:**
- Consumes: `addressedAt(TaskLite)`.
- Produces: pocket slots ordered primarily and unconditionally by addressed time.

- [ ] Write a failing test showing a newer user-addressed task ahead of an older failed task.
- [ ] Run the focused test and confirm the urgent-state priority causes failure.
- [ ] Remove urgent-state rank precedence while retaining demand styling/counting.
- [ ] Run ordering and controller tests.

### Task 3: One existing-task model configuration path

**Files:**
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/notch/pill-controller.ts`
- Test: `desktop/electron/remote/notch/pill-controller.test.ts`
- Test: `desktop/electron/remote/claude/task-integration.test.ts`

**Interfaces:**
- Consumes: `configureTaskChat(id, { model })` and the pill's captured `taskId`.
- Produces: addressed pill model choices that reconfigure the conversation and refresh both surfaces after acceptance.

- [ ] Write a failing controller/wiring test proving an addressed selection invokes per-task configuration rather than only changing its label.
- [ ] Run the focused test and confirm the old receipt-only behavior fails it.
- [ ] Route owned Claude/Codex CLI conversation choices through `configureTaskChat`; retain provider-specific external-app handling.
- [ ] Refresh pill chips after success and surface errors without applying an unaccepted label.
- [ ] Run pill, chat configuration, and notch controller tests.

### Task 4: Pill window priority

**Files:**
- Modify: `desktop/native-notch/Sources/SurfaceStateSupport/SurfaceInteractionState.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/PillWindow.swift`
- Test: `desktop/native-notch/Tests/SurfaceStateSupportTests/SurfaceInteractionStateTests.swift`

**Interfaces:**
- Produces: a pure pill-level raw value strictly greater than the notch level.
- Consumes: AppKit's `NSWindow.Level.screenSaver` raw value.

- [ ] Write a failing pure Swift test asserting pill priority exceeds notch priority.
- [ ] Run it and confirm both currently resolve to the same level.
- [ ] Assign `PillWindow` the tested higher level.
- [ ] Run the focused Swift tests.

### Task 5: Integrated verification

**Files:**
- Verify all files modified above.

**Interfaces:**
- Consumes: all four independently tested changes.
- Produces: a clean branch suitable for review.

- [ ] Run focused TypeScript tests.
- [ ] Run `npm run typecheck` in `desktop`.
- [ ] Run the full desktop test suite.
- [ ] Run `swift test` in `desktop/native-notch`.
- [ ] Inspect `git diff --check`, branch status, and the final diff for unrelated edits.
