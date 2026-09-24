# Pocket fix round 1

Status: implemented, verified, ready for semantic re-review. F1–F7 are addressed; this report does not grant family-gate approval. No DOM, native captures, other-family work, or subagents were used.

## Pin and scope

All product reads used immutable Git revision `20dfd8fe5135371b7c4b5178a4124225a2e15662` in `/Users/zodpatel/tools/unmute/unmute-cloud`. The product repository was read-only throughout. Its observed HEAD is `12588986f6f149d79a82ad0a3d2185e75fb9661e`; `audit.json` honestly records `sourceDrift: true`. Its existing modified/untracked files were not touched.

The validator now treats HEAD drift as observational, consistent with the SDD ruling. It still requires the manifest revision to match the audited revision. Source extraction continues to use `git show <pin>:<path>` exclusively; no pin or source allowlist was changed. The test formerly claiming to check current HEAD now checks the approved revision and consistency of recorded drift metadata.

The Pocket inventory grew from 37 to 72 fixtures. A structural comparison against the pre-round Git manifest established that all **49 Pill entries/fixtures and 54 Notch entries/fixtures are unchanged**, including their interactions, predicates, expectations, and audit backlinks.

Existing unstaged edits to `task-1-report.md`, the earlier review/ruling addition in `progress.md`, and untracked spec/plan files were preserved. Only this round's ledger appendix is staged with the implementation.

## Findings disposition

| Finding | Disposition and implementation | Independent verification |
|---|---|---|
| F1 — branch outcomes and ancestry | Fixed. All eight compact-chip ternaries resolve true, with card-container/display/listening ancestry. Ask ink, header dot, title ink, and fallback status retain their required parents. Swipe branches come from actual event samples and running state, with ordered failed early returns. Flat predicates are compared as a complete array, including source/line; `hasNotch` cites line 301. Dead `PocketRow`, `PocketRowMetrics.make` (including 108), and `PocketFace.saying` are non-rendering. Optional `Any?` at catcher line 53 is explicitly classified as a scanner artifact. | Literal compact outcomes/ancestor lists, literal status helper ancestry, true precise-delta/false gesture-end assertions, dead-helper classifications, removed-parent and inverted/deleted-predicate mutations. |
| F2 — snapshot/handoff | Fixed. Render contract distinguishes live card, snapshot card, expanded content, hit testing, and payload provenance. Distinct snapshot/live IDs, titles, asks, statuses, and counts expose override behavior. Both snapshot displays use a card-only header; rail visibility uses snapshot slots while count uses live slots. Toast and capture level stay live. Prepared/unprepared and motion/reduced-motion state sequences cover delay, preservation, frame completion, stale callbacks, and descent. | Literal snapshot identity `snapshot-task`, visible/non-hit-testable flags, `rail: true` with live `1/1`, notched card-only arrangement, live toast/level; snapshot ID/title and expanded-readiness mutations; handoff sequence expectations. |
| F3 — invalid current controls | Fixed. Dashboard, release and both arrows remain available for nonempty invalid current indices; enabled swipe depends on the live slot count. Card expansion is omitted separately. | Exact four-control lists for negative/high indices, card click and Return/keypad Enter no-events, and keyboard arrows on invalid-current fixtures. |
| F4 — exact event contracts | Fixed. Extraction retains Swift argument expressions and marks legacy emissions unreachable. Independent pinned extraction also retains arrow symbol/delta bindings and IPC field/optional-ID serialization. Validation requires the complete derived reachable control set, exact payloads, active emit locations, argument expressions, serialization references, and arrow bindings. | Wrong/missing expand ID, delta 99, both swapped arrow directions, dead line 310, removed controls, wrong serialization line; independently read source arguments and IPC fields; literal current task ID. |
| F5 — event/controller sequences | Fixed. `pocket-sequences.mjs` separately models swipe feeding, the transparent catcher/monitor, keyboard delivery/guards, pointer targets, key focus, authoritative payload updates, capture refits, and content handoff. Sequences record concrete actions, ordered branch traces, emissions, consumption, resulting local/model state, and refits. Catcher teardown/remount follows live Pocket visibility. | Literal tests exercise foreign-window preservation versus bounds reset, enable change versus unchanged enablement, monitor teardown, spent/start/end/momentum behavior, exact axis equality, repeated wheel detents, typing/modifier/window/slot guards, popup Escape precedence, child-button precedence, focus release/reclaim, reordered IDs, quiet/asking refits, capture-level-only non-refits, handoff preservation and stale completion. |
| F6 — missing visual configurations | Fixed. Adds four listening+toast+many-slot display/identity combinations; valid task backend/default and terminal/nil combinations at both mark sizes; a 228pt cutout with long notched title; long toast; nonempty Pocket under cockpit; and closed hover with `at: 2` distinguishing first from current. Closed fixtures now record complete reused bar derivations. | Coverage assertions over actual input combinations, exact first-title result, explicit narrow-side/control arithmetic, and fixed source configurations described below. |
| F7 — tokens, metrics and assets | Fixed. Preserves composed Theme expressions and effective alpha; adds reservation, overlay/stroke/fill/mark metrics, font weights/design/line limits/truncation, mark optical sizing, downstream mic/terminal assets, waveform configuration, plane clipping, and per-field/source references. Geometry inputs are used consistently and pinned constants are validated. | Independent Git-object extraction of height/ink constants; literal 68/106 card, 118/152 frame, 20 horizontal inset, 12 radius, 47 shoulder/control widths, 0.684/0.665 alpha, 14pt mark, 8.5pt mic, and provenance assertions; forged geometry rejected. |

## Event and transition coverage

These are inventory models and deterministic action evidence, not an AppKit or browser renderer.

| Area | Concrete fixture or test evidence |
|---|---|
| Keyboard success | `pocket-keyboard-actions`: key codes 123, 124, 36, 76, 53; exact move/expand/release emissions and consumption. |
| Keyboard rejection | `pocket-keyboard-guards`: command/control/option/shift, editable text, terminal, foreign window, unrelated key. `pocket-keyboard-one-slot` rejects both arrows. Negative/high current fixtures reject Return/Enter but retain navigation. Outside-click sequence stops delivery until reclamation. |
| Escape precedence | `pocket-popup-escape` stops/clears a visible expanded proposal while Pocket stays open. `pocket-stale-popup-escape` releases Pocket because a compact stale popup is not visible. No optimistic local Pocket close is invented for emitted IPC commands. |
| Pointer precedence | Both `pocket-pointer-precedence-*` sequences produce only the target child's event. Shoulder identity has no expand action. Separate tests prove nil-current card no-event and snapshot hit-test suppression. |
| Scroll arithmetic | Concrete precise positive/negative samples, wheel detents, momentum, ratio equality, subthreshold samples, end reset, start reset, and spent latch. Existing arithmetic tests remain. |
| Catcher | `pocket-scroll-containment` carries event window, containment, enabled updates and monitor actions. Foreign window returns before resetting; bounds rejection resets. Unchanged enablement preserves travel. Teardown resets and removes the monitor. Tests also verify state expansion removes the catcher and descent remounts it without a spent latch. |
| Focus and payload | `pocket-payload-focus-refits` releases keys, applies a reordered payload with a new ask, preserves released focus on data-only update, reclaims on inside click/index change/open, and expands the latest ID. It records exact animated 68/106 refits, live slot/count/swipe changes, and closed/open transitions. |
| Capture | `pocket-capture-refits` distinguishes aim change from successive microphone levels and capture ending. `pocket-cockpit-payload-hidden` proves no compact refit under expanded content. |
| Handoff | Four motion/prepared combinations start from live Pocket. A duplicate expanded push preserves the unready snapshot; matching completion clears it and reveals content. `pocket-handoff-stale-completion` rejects an obsolete callback. Descent retains keys. Source conditions: AppController 705–725, 813, 819–827 and SurfaceContentHandoff 143–156. |

The sequence record explicitly preserves local state; events such as `pocketMove` and `pocketRelease` do not silently apply an engine payload. A subsequent `payload` action is necessary to change that data, matching the source IPC boundary.

## Visual configurations and bounded equivalence

The coverage assertion requires listening+toast+many-slot for task/Agent on each display. These specimens retain an ask, so they also exercise the taller card and constrained footer with long middle copy. Existing fixtures separately cover task listening with ask without toast, notched Agent listening without ask, toast without ask, status footer, single-slot footer, and both quiet/asking display heights.

Omitted full Cartesian products are represented only where the source configuration is identical in the affected region:

| Axis/product | Concrete configurations and layout argument |
|---|---|
| Status × display/identity/listening | All six status labels/colors are literal Pocket states. Status selection is independent of header placement. When listening is true, `PocketView:511–520` removes the status footer entirely. Quiet dot/footer disagreement remains its own specimen. This does not claim that distinct visible labels are equivalent. |
| Ask/toast × footer | `PocketView:449–455` changes only the fixed middle row; footer has its own fixed 21pt height and 6pt spacing. Four many-slot listening/toast fixtures cover the shared constrained footer. Removing the middle row changes height, separately verified at 68 versus 106, but does not change footer width/configuration or its interaction guards. Toast-without-ask remains a separate clipping-risk specimen. |
| Backend/terminal × display | New valid-task fixtures cover Claude, Codex, Claude desktop, nil and unknown/default backend, with true/nil terminal behavior; existing Codex desktop fixtures cover false. Both 14pt card and 16pt shoulder contexts are present. Nil/unknown backend select embedded Claude art at the pin, not an invented missing-art fallback. Terminal uses size × 0.78 and spacing size × 0.31. |
| Provider × listening/footer | Provider controls only header/shoulder mark width (`ProviderMark:49–58`); the footer is a separate full-width HStack. Representative many-slot/listening/footer layouts and provider configurations are independently frozen. Their combination does not share a horizontal text budget across rows. |
| Many-slot count × current position | First/middle/last and both invalid boundaries remain distinct. Count comes from live payload even when snapshot rail visibility is based on the override. Reorder/payload sequence verifies identity, count and refit changes instead of treating static pages as transitions. |
| Display × long content | Long notchless title/ask and long notched title exist. Header reservation is 46/0 and overlay inset 9. The narrow notched specimen allocates a 228pt cutout within width 348 and two 13pt outer insets: `(348 - 26 - 228) / 2 = 47`. Dashboard/close plus gaps need `17 + 6 + 17 + 7 = 47`; the valid task mark without terminal needs `8 + 7 + 16 + 7 = 38`. No declaration-only `pocketMass` sizing is used. Native text truncation/rounding still requires Task 2 capture. |
| Listening level | Compact configuration is 7 bars, 9pt band, 2pt width/floor, 1.5pt gap, 5pt mic gap, 7/3 padding. Low/high live levels remain distinct inputs; color is flat white. Envelope response, initial zero, level-change smoothing and paused clock are source-referenced. Exact animated native pixels are deferred, not inferred from raw level alone. |

## Checklist reconciliation

Numbering follows the review's 164-check table. This supersedes the prior report's unsupported exhaustive-coverage claims.

| Checks | Disposition |
|---|---|
| 1–2 | Immutable pin preserved; independent axes have concrete fixtures/actions or the regional equivalence arguments above. |
| 3–27 | Read authoritative pinned PocketView, NotchView, NotchGeometry, PocketCardHeight, IPC, PocketSwipeArea, PocketSwipe, AppController, BarContent and Theme ranges, plus Waveform, ProviderMark/Art, UnMark/Art, MarkdownText in NotchShape, and SurfaceContentHandoff. Pinned call-site search confirms dead row/make/saying/pocketMass usage. |
| 28–39 | Live/snapshot/expanded precedence, card-only snapshots, live transient values, display arrangement, dead paths, clip/padding, zero slots, invalid current, ask-based frame sizing: F1/F2/F3/F7. |
| 40–47 | Full closed fallback derivations added; approved Notch waiting 1/N/routing specimens preserved; nonzero-index hover discrimination and nonempty cockpit payload added. |
| 48–54 | Quiet/asking displays retained; open-under-expanded task/cockpit and handoff motion/prepared/reduced cases explicit. |
| 55–72 | Invalid/current task/Agent identity, demanding states, provider/terminal/default configurations, all statuses and fallback paths retained or expanded; compact chip evidence corrected. |
| 73–82 | Ask nil/empty/nonempty, toast precedence/height concern, listening/status and low/high configurations covered; composed ink fixed. |
| 83–89 | Counts/invalid boundaries retained; latest payload/reorder/action/refit sequences added. |
| 90–105 | Exact payload/serialization/provenance validation and negative keyboard/pointer/focus cases added. |
| 106–119 | Whole-arrangement transparent catcher, scope, resets, consumption, monitor lifetime, precise/wheel arithmetic and boundaries have concrete sequence evidence and literal expected tests. |
| 120–140 | Exact geometry, fonts, truncation, reservation, shoulder/cutout, tokens, mark art/configurations and SF Symbol configurations are source-mapped; independent arithmetic tests added. |
| 141–162 | Defect-focused requirements addressed by F1–F7 and the mutation tests; schemas enforce complete live, snapshot and update payloads. |
| 163 | Native visual baselines and SF Symbol/PNG generation remain honestly pending under Task 2. No fabricated baseline or visual-equivalence approval. |
| 164 | Regional equivalence arguments above identify concrete fixtures, source conditions and independent configuration checks; no claim that arbitrary omitted screenshots have identical pixels. |

## TDD and mutations

Initial new tests failed against the old implementation on compact outcomes, equal snapshot/live payloads, missing invalid-current controls, accepted wrong-task expansion, missing visual combinations and incorrect ask token. New F5 tests first failed because no sequence evaluator existed. Additional red checks caught missing extracted argument expressions, missing parent/display ancestry, missing pointer action execution/optical sizing, incomplete snapshot schema/closed bar derivation, and catcher lifetime across expansion. Each was implemented and rerun green.

The new mutation table runs against a clean valid inventory and rejects 21 individual corruptions: wrong/missing expand ID; previous delta 99; swapped previous and next deltas; dead expand provenance; removed controls; deleted/inverted predicates; removed required ancestor while leaf stays true; snapshot ID/title changes; unready reduced-motion content; released keyboard ownership with stale key expectations; forged width/padding/fillet; missing live/snapshot `remoteKey`; wrong IPC line; changed scroll window; reordered transition payload; extra wire field. Existing height/identity/provenance and schema/backlink mutations remain.

Expected outputs in the new semantic tests use literals, hand-checked action sequences, or independently extracted pinned constants, not the generator as their expected-value oracle. General manifest consistency recomputation remains useful but is no longer the only test.

## Verification

- `node --test replica-current/tests/*.test.mjs`: **52 passed, 0 failed** (37 existing plus 15 new regression groups).
- `npm test`: **25 passed, 0 failed**.
- Two independent `createInventory(await auditSource())` runs compared byte-for-byte to both saved JSON artifacts: equal; `validateManifest` returned `[]`.
- Git manifest comparison: 49 Pill and 54 Notch entries and corresponding fixtures structurally identical to the pre-round commit.
- `git diff --check`: passed.

One intermediate full-suite failure was the historical test demanding product HEAD equal the pin. It was corrected to report drift without changing the pin or approved family semantics; no test failure remains.

## Concerns and next gate

1. Native visual baselines, actual SF Symbol rasters, text measurements, and animated frame equivalence remain Task 2 work; this Task 1 fix does not begin them.
2. Pinned toast-without-ask can draw a 31pt row inside a quiet 68pt card/frame. It remains an explicit source concern, not a repaired product behavior.
3. Invalid current indices remain defensive source states with `0/N` or clamped `N/N` counts. Recovery controls are now retained.
4. Product HEAD differs from the pin and the product worktree is dirty. Both are observational; no product files or revision pin were changed.
5. Pocket requires semantic re-review before approval or advancement to another family.
