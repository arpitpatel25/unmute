# Hide the RAW Pill Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporarily remove the RAW capsule from both capture-pill implementations without changing raw-mode backend behavior.

**Architecture:** Delete the render call and private view component in each pill implementation. Preserve pill state, IPC events, Remote Settings, routing, persistence, and backend tests so this remains a reversible presentation-only change.

**Tech Stack:** SwiftUI, React/TypeScript, Electron

## Global Constraints

- Do not change raw-mode backend behavior or contracts.
- Do not remove the Remote Settings preference.
- Do not add a feature flag or replacement control.
- Do not add source-text tests that merely lock the word `RAW` out of a file.

---

### Task 1: Remove the RAW capsule from both pills

**Files:**
- Modify: `desktop/native-notch/Sources/unmute-notch/PillView.swift`
- Modify: `desktop/engine-overrides/renderer/widget/WidgetApp.tsx`

**Interfaces:**
- Consumes: existing `PillState.raw` and Electron raw-mode APIs, unchanged
- Produces: native and fallback capture pills with no rendered RAW control

- [x] **Step 1: Confirm the current render sites**

Read the native `RawChip` invocation and React `<RawToggle />` invocation. The
production change that must disappear is each invocation; their private
component declarations then become dead code.

- [x] **Step 2: Remove the native pill control**

Delete the conditional `RawChip` render from `cluster` and delete the private
`RawChip` view. Do not modify `PillState.raw`, `toggleRaw`, or IPC decoding.

- [x] **Step 3: Remove the React fallback control**

Delete the `<RawToggle />` render and the private `rawApi`/`RawToggle`
implementation. Do not modify preload APIs, settings, or main-process handlers.

- [x] **Step 4: Verify both implementations and backend preservation**

Run the native Swift build/check command and the renderer TypeScript build
check available in the repository. Run the focused raw-mode backend tests to
confirm the capability still functions without the pill control.

- [ ] **Step 5: Review and commit**

Confirm the diff contains only the two presentation removals plus this plan,
run `git diff --check`, and commit with:

```bash
git commit -m "fix(pill): temporarily hide RAW mode control"
```
