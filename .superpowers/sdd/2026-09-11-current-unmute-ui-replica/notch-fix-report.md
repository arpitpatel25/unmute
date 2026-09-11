# Notch semantic-gate correction report

## Status

The rejected notch inventory was corrected against pinned, read-only product revision `20dfd8fe5135371b7c4b5178a4124225a2e15662`. Changes are confined to the Task 1 auditor, generated audit/manifest artifacts, focused manifest tests, and this report. No product, DOM, or other family implementation was changed; no subagents were used.

The corrected manifest contains 54 stable notch fixtures. The unreachable stable `dormant`/no-notch fixture was removed. Four precedence fixtures were added, and the numeric geometry matrix now has eight fixtures covering fit, truncation, the exact 54-point retention boundary, and drop behavior on both notched and no-notch paths.

## Corrections by finding

### Exact BarContent outcomes and reachability

- The evaluator now resolves bar content in source order: toast, Agent activity, routing, closed Pocket, then `NotchState`.
- Every retained render-branch backlink records an independently recomputed Boolean outcome and the ordered successful ancestor conditions required to reach it.
- The silence guard evaluates the full compound predicate: not hovering, not expanded, and exact set membership of the resolved `BarContent.signature`.
- `notch-silenced-hardware-empty` now uses the real badge-bearing signature `needs-user|Needs you|Which environment should I deploy to?|1`; the hover exemption records the guard as false.
- Later branches no longer fold failed predecessors into synthetic predicates. Precedence is demonstrated with competing fixtures proving toast > activity > routing > Pocket > state.

### Notch event provenance

- A separate pinned-source extractor reads `NotchView.swift` and finds the conditional `.pocketOpen`/`.tap` emission at line 89 and `model.onHover(hovering)` at line 100.
- Closed Pocket fixtures with slots emit `pocketOpen`; empty Pocket fixtures emit `tap`.
- Hover interactions now carry `{type: "hover", hovering: true|false}` and line 100 provenance. Invented `pointerEntered`/`pointerExited` result payloads and the comment-line citation were removed.
- Validation matches Notch controls against independently extracted event type, source, and exact line. Departure events remain tied to their AppController emit chain.

### Numeric geometry

- Removed categorical `rightAllocation` labels.
- Geometry expectations recompute `barFillet`, `roomRight`, wanted and allocated right widths, the below-54 drop, physical-cutout or 18-point middle, bottom radius, total mass, and rounded top-pinned frame.
- Both display paths include full fit, constrained truncation, exactly 54 retained, and 53 dropped specimens.
- Text widths are deterministic AppKit measurements made with the exact `BarContent` 11.5-point regular and 11-point medium system fonts. The generator fails if a rendered fixture string lacks a pinned measurement. `wantsRightWidth` then applies the source `ceil(7 + measuredText + 13)` formula.
- The wordmark width is recomputed from the pinned `UnMarkArt` 126:78 aspect at 13 points plus two points of trailing air.

### Source-shaped state and behavioral semantics

- Stable off-notch dormant is rejected by validation, matching `AppController.applyState` normalization to idle.
- Invented `recentExplicitGesture`, categorical `departure`, `reduceTransparency`, and appearance `fill` opacity interpretations were removed.
- Auto-present uses `autoPresent || surfaceIsAlreadyExpanded || lastGestureAgeSeconds < 6`; the explicit-gesture specimen uses 5.999 seconds with an initially compact surface.
- Departure fixtures store the explicitly derived `SurfaceDepartureTransition` phase and exercise awaiting-compact, idle/no-op, and returning semantics.
- Surface fill is a 0.40–0.95 geometry fraction. The 0.70 specimen recomputes a 1058×687 frame at `(227, 295)` on the 1512×982 fixture screen; Space Gray paint remains a tone choice rather than a made-up opacity field.
- Every `TaskStatus` fixture records `isYourMove`, exact `Theme.statusLabel`, system color mapping, and attention alarm. Agent fixtures record BarContent status/label/alarm mappings; only `complete` and `failed` are terminal and clear after the source-defined 2.2 seconds.

## TDD evidence

RED: five new focused tests failed on the contradictory silence outcome, absent precedence fixtures, categorical geometry, absent Notch emit extraction, and invented/unreachable controller/appearance fixtures.

GREEN: `node --test replica-current/tests/manifest.test.mjs` passes 31/31. Mutation cases additionally reject a wrong signature, categorical geometry metadata, forged line 77 control provenance, a wrong 54-point allocation, and stable off-notch dormant state.

## Verification and self-review

- Generated artifacts are byte-identical across two consecutive auditor runs.
- `node --test replica-current/tests/manifest.test.mjs`: 31 passed, 0 failed.
- `npm test`: 25 passed, 0 failed.
- `git diff --check`: passed.
- Product HEAD equals the pinned revision and product changes present before this task were not touched.
- Existing unrelated changes to `task-1-report.md` and untracked specification/plan documents were excluded from this work.

## Concerns

- AppKit text widths are pinned to measurements from this acceptance Mac, as the source itself uses AppKit. A macOS/system-font revision may change those measurements; that should be treated as baseline drift and deliberately remeasured, not silently approximated.
- This correction approves only the notch inventory gate. Other incomplete family gates and Task 2 native baselines remain outside this change.

## Scoped rereview correction

The two remaining findings in `notch-gate-rereview.md` were addressed in a second TDD pass.

- `evaluateNotchBranch` now starts from false, explicitly evaluates each cited state case at lines 230, 235, 257, 275, and 285, and records the fixture's actual selected `NotchState` case as an ancestor.
- State cases and nested idle/resting/hover and active/single-processing branches carry the complete ordered ancestry: toast not selected, Agent activity not selected, routing not selected, Pocket not selected, then the actual state case selected.
- Independent wrong-state evaluations and a manifest mutation prove a hard-coded true switch outcome or a self-consistent fixture relabel cannot pass.
- The independent event extractor now scans pinned `AppController.swift` for `model.emit(.userReturned)` at line 1831 and `model.emit(.userLeft(...))` at line 1862.
- The blanket AppController provenance exception was removed. All five Notch event types are validated against independently extracted type/source/exact-line evidence, with forged-line mutations for both departure events.

Scoped rereview RED: focused tests reported 30 passed and 2 failed for missing state-case ancestry and missing departure emit evidence.

Scoped rereview GREEN: focused tests report 32 passed and 0 failed. Full project verification is recorded in the final commit handoff.
