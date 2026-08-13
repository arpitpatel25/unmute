# Notch Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace competing notch UI authorities with one reducer-driven native control plane while preserving existing product behavior.

**Architecture:** Electron continues to own domain truth. The native helper reduces immediate interaction into one state, derives presentation atomically, and reconciles effects by state difference. Native helper startup is bootstrapped and supervised.

**Tech Stack:** Swift 5.9, SwiftUI, AppKit, TypeScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-13-notch-control-plane-design.md`

## Global Constraints

- Preserve every existing feature, layout, shortcut, routing rule, and provider integration.
- New behavior must be covered by a failing test before production code.
- Do not leave old and new state authorities active simultaneously.

---

### Task 1: Pure native interaction reducer

**Files:**
- Create: `desktop/native-notch/Sources/SurfaceStateSupport/SurfaceInteractionState.swift`
- Create: `desktop/native-notch/Tests/SurfaceStateSupportTests/SurfaceInteractionStateTests.swift`
- Modify: `desktop/native-notch/Package.swift`

**Interfaces:**
- Produces: `SurfaceInteractionState.reduce(_:)`, derived pocket details, hover state, and terminal choice.

- [x] Write tests for stable pocket presentation, repeated task state, and explicit terminal choice.
- [x] Run the focused tests and verify they fail because the support module is absent.
- [x] Implement the reducer and derived values.
- [x] Run the focused tests and verify they pass.

### Task 2: Migrate native rendering and effects

**Files:**
- Modify: `desktop/native-notch/Sources/unmute-notch/NotchModel.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/AppController.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/PocketView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/TaskSurfaceView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/TerminalHost.swift`

**Interfaces:**
- Consumes: `SurfaceInteractionState`.
- Produces: one visible pocket state and one terminal subscription path.

- [x] Project the reducer state through `NotchModel` and remove SwiftUI-local pocket authority.
- [x] Route hover, capture, task entry, and terminal toggles through reducer actions.
- [x] Reconcile terminal effects once the SwiftTerm host is mounted and mount expanded content only after geometry travel.
- [x] Add visible compact feedback for collapsed errors and the open pocket.
- [x] Run Swift tests and build the native helper.

### Task 3: Correct frame transition ownership

**Files:**
- Modify: `desktop/native-notch/Sources/SurfaceTransitionSupport/SurfaceFrameTransition.swift`
- Modify: `desktop/native-notch/Tests/SurfaceTransitionSupportTests/SurfaceFrameTransitionTests.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/NotchWindow.swift`

**Interfaces:**
- Produces: completion-aware frame coalescing that ignores only an actually in-flight duplicate.

- [x] Write a failing test for correcting drift after a completed request.
- [x] Add transition completion and wire it to the display-linked animator.
- [x] Verify transition tests and the native build.

### Task 4: Bootstrap and supervise the helper

**Files:**
- Modify: `desktop/electron/remote/notch/notch-client.ts`
- Modify: `desktop/electron/remote/notch/notch-client.test.ts`
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/native-notch/Sources/unmute-notch/AppController.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/IPC.swift`

**Interfaces:**
- Produces: complete bootstrap command and bounded unexpected-exit restart.

- [x] Write failing tests for first-start ordering, restart replay, and deliberate disposal.
- [x] Add supervision, deterministic replay, and bootstrap/present commands to the client.
- [x] Keep native window unpresented until bootstrap and replay apply capture policy and state.
- [x] Run focused TypeScript tests.

### Task 5: End-to-end verification and commit

**Files:**
- Modify only files required by discovered verification failures.

- [x] Run all native Swift tests.
- [x] Build the native helper in release mode.
- [x] Run the complete desktop test suite and both TypeScript checks.
- [x] Inspect the final diff for duplicate authorities and unrelated changes.
- [x] Commit as one architectural change on the existing branch.
