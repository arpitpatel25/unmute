# Exact Interactive MacBook Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-native MacBook demo whose Dictation, Scratchpad, Capture, and Unmute Remote flows reproduce the current Unmute product behavior and visual vocabulary.

**Architecture:** A pure reducer owns the scripted demo state and is tested with Node's built-in test runner. A DOM controller renders that state into one semantic MacBook scaffold; a dedicated stylesheet translates the native SwiftUI metrics and colors while the existing page retains its current shell.

**Tech Stack:** HTML5, CSS, ES modules, Node.js `node:test`; no runtime dependencies.

**Spec:** `docs/superpowers/plans/2026-08-20-exact-interactive-demo-design.md`

## Global Constraints

- Work only on the MacBook demo; do not rewrite unrelated landing-page sections.
- Use `unmute-cloud/origin/main` native UI and keyboard behavior as the source of truth.
- `Fn` and `Right Option` are tap-toggle in the demonstrated flows, never hold controls.
- Keep the bottom pill/scratchpad and top notch as separate product surfaces.
- Do not add a dashboard, centered scratchpad modal, or external response card.
- Use no third-party JavaScript dependencies.

---

### Task 1: Scripted interaction reducer

**Files:**
- Create: `package.json`
- Create: `tests/demo-state.test.js`
- Create: `demo-state.js`

**Interfaces:**
- Produces: `createDemoState(mode)`, `transition(state, event)`, `DEMO_MODES`, and `SCRIPT`.
- State exposes `mode`, `step`, `pillPhase`, `scratchpad`, `captures`, `note`, `notch`, and `remote` fields consumed by the DOM renderer.

- [ ] **Step 1: Write failing tests** for mode reset, Fn recording/delivery, scratchpad pause/resume/delivery, ordered URL/image capture, and Remote start/submit/work/complete.
- [ ] **Step 2: Run `npm test`** and verify failure because `demo-state.js` does not exist.
- [ ] **Step 3: Implement the minimal reducer** with immutable transitions and the four scripted flows.
- [ ] **Step 4: Run `npm test`** and verify all reducer tests pass.
- [ ] **Step 5: Commit** `package.json`, `tests/demo-state.test.js`, and `demo-state.js` with `test: define interactive demo state machine`.

### Task 2: Semantic MacBook and control surface

**Files:**
- Modify: `index.html`
- Create: `demo.js`
- Create: `demo.css`
- Test: `tests/demo-contract.test.js`

**Interfaces:**
- Consumes: reducer exports from `demo-state.js`.
- Produces: DOM hooks `[data-demo-mode]`, `[data-action]`, `[data-pill-phase]`, `[data-notch-state]`, live guide text, Notes destination, scratchpad entries, and Remote task view.

- [ ] **Step 1: Write a failing HTML contract test** asserting the four modes, a single MacBook, Fn and Right Option controls, Notes destination, notch, pill, scratchpad container, module script, and accessible live region.
- [ ] **Step 2: Run `npm test`** and verify the contract fails because the demo markup is absent.
- [ ] **Step 3: Add the focused demo section** after the landing introduction and load `demo.css` plus `demo.js`.
- [ ] **Step 4: Implement the DOM controller** so button clicks and supported keyboard fallbacks dispatch reducer events and render every state.
- [ ] **Step 5: Run `npm test`** and verify reducer and markup contracts pass.
- [ ] **Step 6: Commit** the semantic surface with `feat: add exact interactive MacBook demo shell`.

### Task 3: Native visual translation and responsive behavior

**Files:**
- Modify: `demo.css`
- Modify: `demo.js`
- Test: `tests/demo-contract.test.js`

**Interfaces:**
- Consumes: the stable DOM hooks from Task 2.
- Produces: native-derived fixed-glass pill, paper scratchpad, MacBook/notch geometry, Apple Notes surface, waveform, task states, and responsive scaling.

- [ ] **Step 1: Extend the contract test** to require native source tokens and reduced-motion/responsive rules.
- [ ] **Step 2: Run `npm test`** and verify the new visual-token assertions fail.
- [ ] **Step 3: Implement the native-derived CSS** using 44px pills, `#0e0f13` fixed glass, `#fefcf7` pad paper, `#221f1b` pad ink, `#0e7c7b` paper primary, system status colors, and concentric radii.
- [ ] **Step 4: Render exact state anatomy**: wordless recording/output, `Processing`, amber `Paused`, joined Remote agent/model control, structured scratchpad rows, and notch task surface.
- [ ] **Step 5: Run `npm test`** and verify all automated checks pass.
- [ ] **Step 6: Commit** with `style: match native Unmute demo surfaces`.

### Task 4: Browser verification and polish

**Files:**
- Modify: `demo.css`, `demo.js`, or `index.html` only when verification reveals a defect.
- Test: `tests/demo-state.test.js`, `tests/demo-contract.test.js`

**Interfaces:**
- Consumes: all implemented flows.
- Produces: a visually verified, keyboard-usable demo with no browser console errors.

- [ ] **Step 1: Run `npm test` and `git diff --check`** to verify automated behavior and whitespace.
- [ ] **Step 2: Serve the worktree locally** and inspect desktop and narrow viewport layouts in Chrome.
- [ ] **Step 3: Exercise every flow from reset to delivery/completion**, including replay and mode switching, and confirm the browser console is clean.
- [ ] **Step 4: Fix each observed defect test-first** by adding the smallest failing assertion before changing production files.
- [ ] **Step 5: Re-run the full suite and visual pass**.
- [ ] **Step 6: Commit final verified polish** if verification required changes.

## Self-review

- Spec coverage: all four flows, exact trigger semantics, correct surface ownership, native visual tokens, keyboard fallback, and responsive behavior have an implementation task.
- Placeholder scan: no deferred behaviors or unspecified error-handling steps remain.
- Type consistency: Task 2 consumes only the reducer exports defined by Task 1; Tasks 3 and 4 consume the stable DOM hooks defined by Task 2.
