# SDD ledger — plan: docs/superpowers/plans/2026-09-11-current-unmute-ui-replica.md

## Pre-flight

| Tasks | Interface/file relationship | Finding |
|---|---|---|
| 1 → 2 | Manifest fixtures and baseline paths drive native captures | Clean; Task 2 consumes Task 1 output. |
| 1 → 3–8 | Manifest branch inventory drives all generated tests and atlas navigation | Clean; manifest schema must remain backward-compatible. |
| 2 → 3–7 | Native assets and baseline images are consumed by each renderer | Clean; browser implementation cannot precede relevant baselines. |
| 3 → 4–7 | Primitive renderers and tokens are shared by all component families | Clean; Task 3 API is explicit. |
| 4 → 8 | Pill specimens enter atlas navigation | Clean. |
| 5 → 8 | Notch/Pocket specimens enter atlas navigation | Clean. |
| 6 → 8 | Conversation specimens enter atlas navigation | Clean. |
| 7 → 8 | Remaining top-level specimens enter atlas navigation | Clean. |
| 1 | Deletion, audit, manifest, and test form one inventory deliverable | Clean; deletion is authorized by user after invalid result. |
| 2 | Native fixture harness operates against read-only product tree | Clean; generated outputs live only in this worktree. |
| 3 | Foundation API names match downstream consumers | Clean. |
| 4 | Pill events map to source PillEvent branches | Clean. |
| 5 | Geometry precedes visual content and Pocket depends on shared primitives | Clean. |
| 6 | Conversation scope is large but cohesive and independently reviewable | Clean. |
| 7 | Four remaining families share top-level atlas integration but separate modules | Clean. |
| 8 | Atlas consumes all prior renderers and owns final verification | Clean. |

Ruling: The user’s “go ahead” selects continuous subagent-driven execution; no additional plan-choice interruption is needed.

## Task 1 review loop

Implementation commits: `817714c`, `5e90f07`.

Review round 1: FAIL — 2 blocker and 2 important findings in `task-1-review.md`.

Ruling: A render-state manifest is a curated fixture matrix, not a regex branch list. Static audit occurrences remain separate evidence and every occurrence must be classified as render-affecting or non-rendering with a reason.

Ruling: Baselines may be explicitly `pending` in Task 1 because Task 2 creates them; fabricated PNG paths are forbidden. Interactions must be concrete or explicitly `none` with a reason.

Ruling: Lock to current product HEAD `20dfd8fe5135371b7c4b5178a4124225a2e15662`. The intervening commit has no UI-source diff, but “current” should still be literal and drift must remain visible.

Fix round 1 commits: `119590f`, `a2bc8bd`.

Re-review round 1: FAIL — 2 blocker and 1 important finding in `task-1-rereview-1.md`.

Ruling: Delete semantic auto-assignment (`STATE_VARIANTS`, token scoring, zero-score fallback). Render states and backlinks must be manually defined from concrete source model combinations.

Ruling: Every fixture requires family-specific model fields sufficient to render that state, exact representative values, and source-defined control/event/result transitions. Generic `{deterministic, reducedMotion}` data does not count.

Ruling: Occurrence classifications require occurrence-aware reasons and references; file-level boilerplate classification is insufficient.

Fix round 2 checkpoint commits: `d422132`, `070eb12`. Eight focused tests and 25 existing tests pass, but the implementer explicitly reports all nine families remain incomplete.

Ruling: Task 1 was too large for one corrective pass. Split it into sequential family gates: Pill; notch; Pocket; conversation; cockpit; scratchpad; notetaker; new conversation; foundations. Each gate must enumerate exhaustive source-shaped fixtures and transitions before Task 1 re-review.

Pill family gate: completed locally after the worker was stopped for failing to return a bounded checkpoint. Preserved worker changes had 42 states and one failing render-branch test; local completion added source-shaped hover, Mac microphone, selector-row, scratchpad expanded/unarmed, and missing branch mappings. Final Pill count: 47 states. `node --test replica-current/tests/manifest.test.mjs`: 11/11 pass.

Pill semantic review: REJECT — 3 blocker and 3 major findings in `pill-gate-review.md` despite 11/11 tests passing.

Ruling: Pill fixtures must decode against the authoritative `PillState` shape. Local-only view state must be modeled separately and may not masquerade as model payload.

Ruling: Only events emitted by visible source controls count as interactions. Serialized-but-unused PillEvent cases are evidence, not controls. Scratchpad interactions must map to actual ScratchpadView emissions.

Ruling: Predicate coverage records true/false outcomes and validates fixtures against those outcomes; a line-number backlink alone is invalid.

Ruling: `AimedChip` is not a PillView state and moves to its owning task/conversation family. Impossible ProviderMark fallbacks are removed; backend/vendor/terminal combinations follow ProviderMarkArt exactly.

Pill correction commits: `1702148`, `7bb060c`, `a2832a7`.

Pill family gate: APPROVED — zero remaining findings after exact ProviderMarkArt backend-case correction. Focused suite: 21/21 passing. Pill states: 49.

Notch family checkpoint: interrupted worker stopped after failing to return bounded status. Preserved changes contain 46 states and pass 26/26 focused tests. Submitted for semantic review; not yet approved.

Notch semantic review: REJECT — critical defects in compound predicate evaluation, ancestor reachability, control provenance, stable controller reachability, precedence competition, calculated geometry, controller/appearance projections, and behavioral status coverage. See `notch-gate-review.md`.

Ruling: Notch validation must execute source-equivalent compound predicates and ordered early-return ancestry against fixture data. Synthetic shorthand booleans and categorical geometry labels are forbidden.

Ruling: Stable fixtures must be reachable after AppController normalization. Controller-local values may be represented only as exact source-shaped state or explicitly derived projections with provenance and recomputation.

Notch correction commit: `a2ea6f8`. Scoped rereview: REJECT — 1 critical and 1 important finding remain in `notch-gate-rereview.md`.

Ruling: Every cited `NotchState` switch case must be evaluated as an exact case comparison. Reaching a switch or nested state branch requires the four ordered failed early returns followed by the actual selected case; a generic “state switch reached” ancestor is insufficient.

Ruling: Notch event provenance has no exceptions. `userLeft` and `userReturned` must be independently extracted from pinned `AppController.swift` and validated by event type, source path, and exact emit line, just like `tap`, `pocketOpen`, and hover.
