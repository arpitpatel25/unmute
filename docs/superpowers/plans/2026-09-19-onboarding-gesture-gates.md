# Onboarding Gesture Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make video onboarding teach tap-toggle accurately, repair the macOS Globe-key conflict, and advance each exercise only after its real shortcut lifecycle and product outcome.

**Architecture:** Extend the pure onboarding state machine with a Function-readiness action and ordered gesture receipts. The shipping keyboard manager exposes a narrow readiness probe that consumes one Function press without starting Dictation, while normal exercise events are translated into onboarding receipts by the existing Electron integration. Presenter state derives live instructions from durable exercise phase, and all spoken copy stays identical across the chapter manifest, recording contract, storyboard, and Apple Note.

**Tech Stack:** Electron, TypeScript, Node test runner, React presenter, macOS keyboard preferences and System Settings.

**Spec:** `docs/superpowers/specs/2026-09-10-video-led-immersive-onboarding-design.md`

## Global Constraints

- Dictation onboarding always uses tap-toggle: Function once starts; Function again submits.
- Function readiness consumes the test press and must not start a recording.
- No video completion, timeout, transcription-only result, or unverified prose advances an exercise.
- Existing shipping keyboard, capture, task, Agent, and Notetaker paths remain authoritative.
- Founder copy, runtime captions, storyboard, and Apple Note must stay synchronized.

---

### Task 1: Pure Gesture-Gated Journey

**Files:**
- Modify: `desktop/electron/onboarding/types.ts`
- Modify: `desktop/electron/onboarding/chapters.ts`
- Modify: `desktop/electron/onboarding/machine.ts`
- Modify: `desktop/electron/onboarding/progress-store.ts`
- Test: `desktop/electron/onboarding/machine.test.ts`
- Test: `desktop/electron/onboarding/end-to-end.test.ts`
- Test: `desktop/electron/onboarding/progress-store.test.ts`

**Interfaces:**
- Produces: `function-key` action; `shortcut-started`, `shortcut-stopped`, and `function-key-observed` events; durable `gesture` progress.
- Consumes: lane IDs `dictation`, `orchestrator`, and `agent`.

- [ ] Write failing tests proving Function readiness cannot advance without `function-key-observed`, Dictation requires ordered start/stop/delivery, captures require start/capture/stop/delivery, Orchestrator requires start/stop/task completion, and Agent requires start/stop/link opening.
- [ ] Run the onboarding state-machine tests and confirm the new assertions fail.
- [ ] Add the types, transition rules, presenter phases, and legacy-progress migration.
- [ ] Run the focused state-machine, end-to-end, and progress tests until they pass.

### Task 2: Shipping Keyboard Integration

**Files:**
- Modify: `desktop/engine-overrides/electron/keyboard.ts`
- Modify: `desktop/engine-overrides/electron/onboardingInit.ts`
- Test: `desktop/engine-overrides/electron/keyboard.lanes.test.ts`
- Test: `desktop/electron/onboarding/register.test.ts`

**Interfaces:**
- Produces: `keyboardManager.setFunctionReadinessProbe(listener | null)` and normalized onboarding lifecycle receipts.
- Consumes: existing `session-start`, `session-stop`, `remote-start`, `remote-stop`, `agent-start`, and `agent-stop` events.

- [ ] Write failing tests showing the readiness probe consumes exactly one Function press without emitting `session-start`, and runtime gesture receipts do not advance the wrong action.
- [ ] Run the keyboard and runtime tests and confirm failure.
- [ ] Implement the readiness interception and translate shipping keyboard events in `onboardingInit.ts`.
- [ ] Open Keyboard Settings from the repair card and use the live consumed Function event as authoritative readiness proof.
- [ ] Run keyboard, runtime, and onboarding integration tests until they pass.

### Task 3: Synchronized Presenter and Recording Copy

**Files:**
- Modify: `desktop/electron/onboarding/chapters.ts`
- Modify: `desktop/engine-overrides/renderer/onboarding/OnboardingPresenter.tsx`
- Modify: `desktop/engine-overrides/renderer/onboarding/presenterState.ts`
- Modify: `desktop/docs/onboarding/FOUNDER-SCRIPT.md`
- Modify: `desktop/docs/onboarding/onboarding-storyboard.html`
- Modify: `desktop/docs/onboarding/SIGNED-BUILD-VERIFICATION.md`
- Test: `desktop/engine-overrides/renderer/onboarding/presenterState.test.ts`

**Interfaces:**
- Produces: matching tap-toggle wording and phase-specific cards: start, listening, capture detected, processing, and repair.
- Consumes: presenter snapshots from Task 1.

- [ ] Write failing presenter tests for Function repair and gesture phases.
- [ ] Update presenter rendering and exact spoken/caption copy, including the expanded Orchestrator philosophy.
- [ ] Update the recording contract, storyboard, and signed-build checklist with identical interaction sequences.
- [ ] Run presenter and full focused onboarding tests.

### Task 4: Final Verification and Commit

**Files:**
- Verify all modified files above.

- [ ] Search active onboarding sources for obsolete hold/release wording.
- [ ] Run the complete focused onboarding and keyboard suites.
- [ ] Run `git diff --check` and inspect the final diff.
- [ ] Commit the runtime, tests, and synchronized copy as one new commit on top of the approved design commit.
- [ ] Replace the existing Apple Note with the final spoken-only script and verify its contents.
