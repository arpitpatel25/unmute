# Expanded Reply Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair expanded composer sizing/state, Codex Desktop image submission, and pocket-to-task transition latency.

**Architecture:** Keep one task-scoped draft across all expanded surfaces, deliver Codex attachments through CDP file-chooser interception with confirmation, and move panel geometry on an asynchronous display-linked coordinator. Each repair has an isolated behavioral test before implementation.

**Tech Stack:** TypeScript/Node test runner, Swift/SwiftUI/AppKit/XCTest, Chrome DevTools Protocol.

**Spec:** `docs/superpowers/specs/2026-08-13-expanded-reply-reliability-design.md`

## Global Constraints

- Do not change capture routing or task-address locking.
- Never clear a draft before provider delivery is confirmed.
- Never open or drive the native macOS file picker.
- Respect macOS Reduce Motion.

---

### Task 1: Adaptive shared composer

**Files:**
- Modify: `desktop/native-notch/Sources/unmute-notch/ConversationPanel.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/TaskSurfaceView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/StageView.swift`
- Test: `desktop/native-notch/Tests/ComposerSupportTests/ComposerHeightTests.swift`

**Interfaces:**
- Consumes: `TaskDraftP`, `StageComposer`
- Produces: pure clamped-height calculation and identical draft propagation on task/stage surfaces

- [ ] Write a failing test proving one line stays compact and wrapped content grows only to the cap.
- [ ] Run the focused Swift test and confirm the expected failure.
- [ ] Implement measured editor height and pass `t.draft` through every composer call.
- [ ] Run the focused and full native test suites.

### Task 2: Confirmed Codex attachment delivery

**Files:**
- Modify: `desktop/electron/remote/codex/cdp.ts`
- Modify: `desktop/electron/remote/codex/driver.ts`
- Test: `desktop/electron/remote/codex/cdp.test.ts`
- Test: `desktop/electron/remote/codex/driver.test.ts`

**Interfaces:**
- Consumes: CDP `Page.setInterceptFileChooserDialog`, `Page.fileChooserOpened`, `Page.handleFileChooser`
- Produces: bounded `attachFiles(paths): Promise<boolean>` and confirmed `sendWithAttachments`

- [ ] Write failing tests for chooser interception, preview confirmation, timeout, and no premature success.
- [ ] Run focused tests and confirm failures occur at the missing confirmation behavior.
- [ ] Implement event-aware CDP requests and provider confirmation.
- [ ] Run focused tests and all Electron remote tests.

### Task 3: Non-blocking native surface transition

**Files:**
- Modify: `desktop/native-notch/Sources/SurfaceTransitionSupport/SurfaceFrameTransition.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/NotchWindow.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/AppController.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/NotchView.swift`
- Test: `desktop/native-notch/Tests/SurfaceTransitionSupportTests/SurfaceFrameTransitionTests.swift`

**Interfaces:**
- Consumes: current frame, latest target frame, display timestamps
- Produces: immediate request return, sampled frame progress, duplicate suppression, mid-flight retargeting

- [ ] Write failing tests for sampled progress and mid-flight retargeting.
- [ ] Run focused Swift tests and confirm failures.
- [ ] Implement the display-linked animator and outgoing-pocket/content handoff.
- [ ] Run focused and full native tests.

### Task 4: Integrated verification and commit

**Files:** all files above

**Interfaces:**
- Consumes: completed repairs
- Produces: one verified implementation commit

- [ ] Run TypeScript tests and typecheck.
- [ ] Run all native-notch tests and checks.
- [ ] Inspect the final diff for unrelated changes or dropped draft/error paths.
- [ ] Commit the implementation with a focused message.
