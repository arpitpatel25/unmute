# Pill family gate correction report

## Status

The rejected Pill family inventory has been corrected against read-only product revision `20dfd8fe5135371b7c4b5178a4124225a2e15662`. Scope remains Task 1 inventory, generated fixtures/evidence, tests, and this report. No product files were changed and no subagents were used.

The corrected manifest contains 49 Pill specimens. The increase from 47 is the net result of adding a zero-envelope waveform specimen, replacing two invalid provider specimens with four real backend combinations, and removing the non-rendered raw specimen.

## Authoritative source review

Read completely from the pinned Git revision before implementation:

- `PillModel.swift`, including `PillState`, `PillAxis`, `PillOption`, `PillCoaching`, and serialized `PillEvent` cases
- `PillView.swift`
- `Waveform.swift`
- `ProviderMark.swift`
- `ProviderMarkArt.swift`

The source repository remained read-only. The audit still records current product HEAD, the locked revision, and drift status.

## Corrections by rejected finding

### 1. Source-shaped fixtures and local state

- Coaching now uses exactly `condition`, `remedy`, and `level`.
- Codex axes now use exactly `axis`, `values`, and `current`.
- Microphone choices are complete `PillOption` objects rather than strings.
- SwiftUI-owned `selectorOpen`, `padExpanded`, and source-provenanced component hover values live under `viewState`, separate from `PillState`.
- Removed model-like `openMenu` and `presentation` fixture fields.
- Scratchpad payloads now use source fields and derive visibility from non-empty pad content.
- Provider rendering expectations are entry metadata, not renderer input.

### 2. Visible control inventory and provenance

The Pill family now inventories only controls emitted by the visible source tree:

- Pill: stop, cancel, accept draft, undo, pick model, pick axis, pick agent, pick mic, open billing portal, dismiss offline
- Local view: open/close selector state
- Scratchpad embedded beside Pill: arm, remove, deliver, discard

Every control records the exact Swift source file and emitting line. Serialized-but-unemitted `cycleAgent` and `toggleRaw` are excluded. The synthetic scratchpad collapse result is excluded; expansion/collapse remains local binding state.

### 3. Predicate outcome coverage

Line-only backlink assertions were replaced for the rejected predicates by explicit records containing predicate identity, source location, and Boolean outcome. Outcomes are independently recomputed from each fixture during validation. The matrix covers both true and false for:

- `selectorShowing`
- `micOptions.count > 1`
- `!isAgentLane`
- `taskId == nil`
- scratchpad enabled and visible/live
- waveform envelope at or below zero

Mutation tests prove that flipping a recorded outcome is rejected.

### 4. ProviderMark combinations

Removed the impossible `local`/`LA` fallback. Because both pinned base64 assets are populated, all product-defined backends take the image branch. The inventory now covers:

- `claude` → Claude vendor, “Claude Code CLI”, terminal true
- `claude-code-desktop` → Claude vendor, “Claude desktop”, terminal false
- `codex` → Codex vendor, “Codex CLI”, terminal true
- `codex-desktop` → Codex vendor, “Codex desktop”, terminal false

Each expectation records embedded art, so no unreachable text fallback is claimed.

### 5. Waveform ownership and silence

- Added `pill-recording-waveform-zero` with level zero and explicit resting/paused-envelope outcome.
- Kept a nonzero waveform fixture for the opposite outcome.
- Reassigned `AimedChip.compact` branches at `Waveform.swift:142–155` to the existing Pocket aimed-capture specimen. They are no longer counted as Pill coverage.

### 6. Test quality

Tests now validate the decodable schema, separation of local state, exact provider mappings, true/false predicate outcomes recomputed from fixture values, source-line provenance for every emitted control, absence of serialized-only/synthetic actions, zero/nonzero waveform behavior, and AimedChip ownership. Validator mutation cases cover malformed coaching, a false predicate outcome, and forged control provenance.

## TDD evidence

RED was observed with five focused failures after adding the new gate tests:

`node --test replica-current/tests/manifest.test.mjs` → 11 passed, 5 failed.

The failures were specifically missing `viewState`, missing control provenance, absent predicate records, absent real provider combinations, and absent zero-envelope coverage.

GREEN after implementation and regeneration:

`node --test replica-current/tests/manifest.test.mjs` → 16 passed, 0 failed.

Additional verification:

- `node replica-current/scripts/audit-source.mjs --write` completed successfully.
- `git diff --check` completed successfully.
- Generated-control inventory contains no `pillCycleAgent`, `pillToggleRaw`, or `scratchpadCollapse` result.
- Product source drift remains false at the locked revision.

## Self-review

- Confirmed all changes are confined to Task 1 generator, generated inventory/evidence, tests, and this report.
- Confirmed unrelated pre-existing changes to `task-1-report.md` and untracked specification/plan files were not edited or staged.
- Confirmed provider expected output is not mixed into renderer input.
- Confirmed predicate validation does not trust stored outcomes; it recomputes them from fixture data.
- Confirmed control provenance checks exact event-to-line mappings rather than merely requiring a citation-shaped object.

## Concerns

The waveform fixture uses pushed `PillState.level` as the deterministic fixture value corresponding to the private `Waveform.envelope` outcome. Native capture in Task 2 must allow SwiftUI's `onChange`/envelope update to settle before capturing the nonzero specimen; the zero specimen is the initial resting state and requires no settling.

## Pill fix rereview round

The three findings in `pill-gate-rereview.md` were addressed in a second TDD pass.

### Reachability-bound branch evidence

- Every retained Pill render-branch backlink now stores the evaluated predicate, Boolean outcome, and all required ancestor-view predicates.
- Validation recomputes the branch outcome and ancestor chain from the linked fixture and rejects mismatches or an unreachable ancestor.
- Child predicates are recorded only when their containing view is reachable: mic predicates require live chips, Agent predicates require `AgentModelControl`, task-addressing predicates require the selector, and waveform predicates require the recording waveform rather than countdown.
- Contradictory mappings were corrected: mic count links to a multi-mic fixture, `!isAgentLane` links to a non-Agent-lane fixture, and `taskId == nil` links to the unaddressed open selector.
- Legacy cosmetic/environment backlinks that cannot be evaluated from a Pill fixture are no longer claimed as fixture branch coverage; they remain explicitly classified render inputs.

### Strict local state

- `viewState` is allowlisted to `selectorOpen`, `padExpanded`, and optional source-backed `hover` records.
- Hover records carry the actual `@State` declaration location and Boolean value.
- Removed invented `controlState` and `pillHover` inputs.
- Removed `agentRim` from local state; it is derived only from the exact `PillState.isAgentLane` inputs (`kind`, `agentOptions`, and `modelOptions`).
- Mutation coverage rejects any unknown local-state key.

### Independent controls and providers

- A separate source scanner extracts `model.emit`, `scratch.emit`, selector toggle, and outside-click selector-close sites directly from pinned `PillView.swift`.
- Manifest control provenance is validated against those extracted sites rather than against the table that constructs controls.
- Selector dismissal now includes toggle-close at line 853 and outside-click close at line 253. Both require a true `selectorShowing` visibility predicate.
- Provider expectations are independently recomputed from the fixture's selected `PillOption`: backend-to-vendor mapping, backend-to-accessible-name mapping, terminal capability, and embedded-art outcome.
- Mutation tests reject expectation text drift and fixture terminal/backend drift.

### Second TDD evidence

RED: `node --test replica-current/tests/manifest.test.mjs` reported 16 passed and 4 failed. The four failures were missing branch-link outcomes/reachability, permissive local state, absent independent control scanning/selector close, and absent provider recomputation.

GREEN: `node --test replica-current/tests/manifest.test.mjs` reports 20 passed and 0 failed. The full repository test command and final generated-artifact check are recorded in the commit handoff.

## ProviderMarkArt exact-case blocker

The remaining blocker from `pill-gate-rereview-2.md` was corrected with an exact encoding of `ProviderMarkArt.name` switch semantics:

- Line 87, `"codex"`, links only to `pill-provider-codex-cli` and evaluates `backend == "codex"`.
- Line 88, `"codex-desktop"`, links only to `pill-provider-codex-desktop` and evaluates `backend == "codex-desktop"`.
- Line 89, `"claude-code-desktop"`, links only to `pill-provider-claude-desktop` and evaluates `backend == "claude-code-desktop"`.
- Line 90, `default`, links only to `pill-provider-claude-cli` and evaluates true only when the backend is none of the three explicit cases.

The evaluator no longer uses provider vendor groups for these branches. Negative assertions prove `codex` and `codex-desktop` cannot satisfy each other's cases and that `claude` cannot satisfy `claude-code-desktop`. A validator mutation changes the Codex CLI fixture backend to `codex-desktop` while also updating its provider expectation, proving the line-87 branch backlink independently rejects the alias.

TDD evidence for this round:

- RED: focused suite reported 20 passed, 1 failed on the incorrect line-87 state backlink.
- GREEN: focused suite reports 21 passed, 0 failed.
