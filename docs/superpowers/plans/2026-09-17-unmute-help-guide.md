# Unmute Help Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permanent, glanceable “How to use Unmute” guide to the Electron app and notch, and let the Unmute Agent answer the same product-use questions from one canonical source.

**Architecture:** Keep the guide copy and shortcut resolution in a pure TypeScript catalog owned by the Electron main process. The renderer, native notch, and Agent capability receive resolved entries from that catalog, so the displayed dictation key and activation gesture always reflect live settings while the complementary session key is derived consistently. Native Swift owns only presentation and IPC decoding; it does not duplicate guide prose.

**Tech Stack:** TypeScript, React, Electron IPC/preload, Node test runner, SwiftUI, Swift Codable/XCTest.

**Spec:** `docs/superpowers/specs/2026-09-17-unmute-help-guide-design.md`

## Global Constraints

- The guide is permanent core UI, not onboarding.
- Put “How to use Unmute” above Dictation in the main sidebar.
- Use short, human sentences and examples that can be scanned.
- Show only the user's configured dictation key and activation gesture; never say “Fn or Right Option depending on Settings.”
- Do not mention Instruct.
- Explain Dictation first, then direct sessions and the Unmute Agent session manager, then Notetaker and the remaining surfaces.
- Include screenshot capture, copied context, Scratchpad, the Right Command-first pocket chord, repeat-to-expand, Escape, arrow navigation, and Return.
- Do not document Tab, F, or 1–9.
- The Unmute Agent reads the guide on demand through a capability; do not inject the full guide into every prompt.
- Do not change shortcut behavior in this feature.

---

### Task 1: Canonical guide catalog and live shortcut resolution

**Files:**
- Create: `desktop/electron/remote/help-guide.ts`
- Create: `desktop/electron/remote/help-guide.test.ts`

**Interfaces:**
- Produces: `resolveHelpGuide({ dictationKey, activationMode }): HelpGuide`
- Produces: `searchHelpGuide(guide, query): HelpGuideSearchResult[]`
- `HelpGuide` contains ordered sections and compact/full text suitable for all three consumers.

- [ ] **Step 1: Write failing resolver tests** covering all six dictation key/activation combinations, complementary session key derivation, required topics, and exclusion of Instruct/Tab/F/1–9.
- [ ] **Step 2: Run the focused Node test** and confirm it fails because the catalog does not exist.
- [ ] **Step 3: Implement the typed catalog and resolver** with sections `dictation`, `sessions`, `notetaker`, and `notch`; use concise steps and one concrete example per major concept.
- [ ] **Step 4: Add search tests and implementation** so queries such as “resume a session,” “screenshot,” “scratchpad,” and “right command” return the relevant entries.
- [ ] **Step 5: Run the focused test and commit** as `feat: add canonical unmute help catalog`.

### Task 2: Electron guide page and sidebar destination

**Files:**
- Create: `desktop/engine-overrides/renderer/app/HowToUseUnmute.tsx`
- Create: `desktop/engine-overrides/renderer/app/HowToUseUnmute.test.ts`
- Modify: `desktop/engine-overrides/renderer/app/App.tsx`
- Modify: `desktop/electron/remote-preload.ts`
- Modify: `desktop/electron/remote/init.ts`

**Interfaces:**
- Consumes: `resolveHelpGuide` from Task 1.
- Produces preload API: `remoteGetHelpGuide(input: { dictationKey; activationMode }): Promise<HelpGuide>`.
- Produces top-level tab id: `guide`.

- [ ] **Step 1: Write a failing pure renderer test** for section order, no forbidden labels, and visible exact shortcut strings from a resolved fixture.
- [ ] **Step 2: Add IPC and preload plumbing** that accepts the renderer's live `getDictationKey()` and `getActivationMode()` values and returns the resolved catalog.
- [ ] **Step 3: Build the page** as a short intro, four section cards, small keycaps, plain-language examples, and a final “Ask the Unmute Agent” hint; avoid dense shortcut tables.
- [ ] **Step 4: Add the Help-circle sidebar item above Dictation** and load the guide on mount and whenever Settings changes the dictation key or activation mode.
- [ ] **Step 5: Run renderer tests and typecheck, then commit** as `feat: add how to use unmute app page`.

### Task 3: Correct nearby stale product copy

**Files:**
- Modify: `desktop/engine-overrides/renderer/app/Settings.tsx`
- Modify: `desktop/engine-overrides/renderer/app/help/Agent.tsx`
- Modify: `desktop/engine-overrides/electron/keyboard.ts`
- Test: existing renderer and keyboard tests.

**Interfaces:**
- Consumes the verified runtime behaviors: direct sessions are tap-to-start/tap-to-submit; Agent is double-tap Right Command to start and one tap to submit; Notetaker is double-tap Left Control for start and stop.

- [ ] **Step 1: Add or update assertions** that the rendered descriptions match runtime behavior and never describe hold-to-talk for sessions or Agent.
- [ ] **Step 2: Replace stale wording** with the verified gestures and rename explanatory language from “orchestration” to direct sessions/session manager where user-facing.
- [ ] **Step 3: Correct misleading code comments** without changing state machines.
- [ ] **Step 4: Run focused tests and commit** as `fix: align shortcut copy with runtime behavior`.

### Task 4: Unmute Agent product-help capability

**Files:**
- Create: `desktop/electron/remote/agent/capabilities/help.ts`
- Create: `desktop/electron/remote/agent/capabilities/help.test.ts`
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/agent/constitution.ts`
- Modify: `desktop/electron/remote/agent/constitution-coverage.test.ts`
- Modify: `desktop/electron/remote/agent/registry.test.ts`

**Interfaces:**
- Consumes: `searchHelpGuide` and current `dictationKey`/`activationMode`.
- Produces tool `unmute_help({ query?: string })` returning concise matching entries plus examples.

- [ ] **Step 1: Write failing capability tests** for settings-driven answers, session-manager questions, Notetaker questions, no-match fallback, and no forbidden shortcuts.
- [ ] **Step 2: Implement the read-only capability** with a narrow tool schema and a dependency that resolves settings at execution time.
- [ ] **Step 3: Register it only for the Unmute Agent** and add one short constitution rule directing product-use questions to `unmute_help`.
- [ ] **Step 4: Run capability, registry, and constitution tests, then commit** as `feat: teach unmute agent the product guide`.

### Task 5: Notch help payload and compact SwiftUI guide

**Files:**
- Modify: `desktop/electron/remote/notch/notch-client.ts`
- Modify: `desktop/native-notch/Sources/unmute-notch/IPC.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/NotchModel.swift`
- Create: `desktop/native-notch/Sources/unmute-notch/HelpGuideView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/WallView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/TaskSurfaceView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/AppController.swift`
- Modify/Create tests under: `desktop/native-notch/Tests/unmute-notchTests/`

**Interfaces:**
- Consumes a compact projection of `HelpGuide` sent as command `{ type: 'helpGuide', guide }` after bootstrap and whenever trigger settings change.
- Produces `NotchModel.helpGuide` and `NotchModel.helpGuidePresented`.

- [ ] **Step 1: Write failing TypeScript serialization and Swift decode tests** for ordered sections, exact live shortcut labels, and safe absence before the payload arrives.
- [ ] **Step 2: Add the IPC command and model state** using Codable structs that mirror only the compact fields needed by SwiftUI.
- [ ] **Step 3: Send the resolved compact guide** after notch readiness/bootstrap and resend it when the configured trigger changes.
- [ ] **Step 4: Add a small question-mark control** to the wall and expanded task headers and present a compact scrollable guide using the existing notch tone and typography.
- [ ] **Step 5: Make Escape close help first** before shrinking the current surface; do not alter other shortcut behavior.
- [ ] **Step 6: Run Node and Swift tests and commit** as `feat: add compact help guide to notch`.

### Task 6: End-to-end verification and review artifact refresh

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-unmute-help-guide-design.html`
- Modify: `docs/superpowers/plans/2026-09-17-unmute-help-guide.md`

**Interfaces:**
- Consumes all previous tasks.

- [ ] **Step 1: Run focused Node tests** for catalog, renderer model, Agent capability, registry, constitution, and notch serialization.
- [ ] **Step 2: Run `swift test`** in `desktop/native-notch`.
- [ ] **Step 3: Run `npm run typecheck` and `npm test`** from `desktop`; if the known Node 23/Python 3.14 native dependency issue blocks them, record the exact baseline failure and run with the repository-supported Node version if available.
- [ ] **Step 4: Launch the Electron app and inspect** the sidebar placement, all live shortcut variants, responsive scrolling, and copy.
- [ ] **Step 5: Launch the notch helper and inspect** opening help from wall and task, scrolling, and Escape dismissal.
- [ ] **Step 6: Refresh the HTML artifact** so its final copy and hierarchy match implementation, then run a forbidden-copy search for `Instruct`, `depending on Settings`, and the removed Tab/F/1–9 help rows.
- [ ] **Step 7: Mark plan boxes complete and commit** as `docs: finalize unmute help guide`.

