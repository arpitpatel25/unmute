# Pocket inventory gate report

## Outcome

Pocket inventory is implemented as a reviewable Task 1 family checkpoint, with no DOM or product-repository changes. All evidence is read from immutable Git objects at product revision `20dfd8fe5135371b7c4b5178a4124225a2e15662`; product HEAD was verified at that revision and the audit reports no drift.

The curated Pocket family now contains 37 source-shaped fixtures. Generated `manifest.json` and `audit.json` are deterministic. Pocket controls are independently extracted from pinned `PocketView.swift`, `NotchView.swift`, and `AppController.swift`, then validated by event type, exact source path, and exact emit line.

## Checklist reconciliation (164 checks)

Every item in `pocket-source-review-checklist.md` was reviewed. The reconciliation below groups checks that share one proof while retaining each independent axis in fixtures/tests.

| Checklist area | Reconciliation |
|---|---|
| Pin and authoritative source map | The generator uses `git show <revision>:<path>` for the full pinned source set. PocketView, PocketSwipeArea, PocketSwipeSupport, PocketCardHeight, IPC, NotchView, NotchGeometry, AppController, BarContent, Theme, Waveform/AimedChip, and directly required ancestors remain in the audit. |
| Render ancestry | `expanded` is evaluated before `pocket.isOpen`; task/cockpit suppression, motion handoff snapshot, and Reduce Motion immediate reveal have distinct fixtures. Snapshot uses `transitionPocket` while live toast/capture data remain on `model`. Notched selects shoulders plus `headerInShoulders`; notchless selects card-only. Zero-slot open falls through to bar. |
| Legacy arrangement | Pinned call-site search finds `PocketRow` declaration only. Its view and `PocketRowMetrics.make` branches are explicitly classified non-rendering. Shared metrics/helpers still reached by current card/shoulder/rail/control code remain visual evidence. |
| Closed Pocket | Existing approved Notch fixtures prove waiting 1/N, hover-first-slot detail, routing precedence, and expanded suppression. Pocket adds zero-slot and slots-with-zero-waiting payloads without altering Notch-family data. No duplicate invented card is claimed. |
| Geometry | Expectations recompute width 348; quiet height 68; asking height 106; frame height `card + 12 + cutoutHeight`; notched cutout 34; panel padding 6; fillet 14; plane radius 12 and horizontal padding 20. Quiet/asking × notched/notchless are represented. |
| Current/identity | Valid task, Agent, negative index, and beyond-last index are distinct. Nil current yields “Nothing in your pocket”, Ready, ProviderMark defaults, no expand, and 0/N or N/N count. Agent uses UnMark; notchless suppresses duplicate title while notched shoulders restore card title. Backend and `terminal ?? true` are retained exactly. |
| Demanding/status | All six TaskStatus cases carry exact label/color/isYourMove behavior. Unknown status is tested with demanding true and false; demanding nil is not quiet. Quiet forces a done dot but leaves footer resolved from wire status, preserving the source mismatch. |
| Ask/toast/listening | Nonempty, empty, and nil ask; toast-over-ask; toast-without-ask; status footer; low/high live capture levels; task and Agent listening; and listening-with-ask are represented. The card expectation records two-line/31pt middle-row behavior and compact AimedChip level pass-through. |
| Paging/current updates | One slot and first/middle/last three-slot pages prove rail visibility, exact count, focused content, and current-ID expansion. Negative/high invalid indices cover edge count behavior. Latest payload semantics are represented by deriving current, rail, swipe, and height from each complete PocketP fixture, never cached aliases. |
| Pointer controls | Card expand, dashboard, release, and both arrows use exact events and pinned emit lines. Help strings, SF symbols, glyph sizes, button dimensions, and serialized result payloads are frozen. Shoulder identity has no expansion action; controls remain separate children of the card gesture. |
| Keyboard/focus | Bare left/right, Return, and Escape use exact AppController emit lines and guards. Outside click is represented with exact local `pocketHoldsKey = false` while PocketP remains open. Modified/typing/foreign-window keys are documented non-events under the same guard chain. |
| Swipe/scroll | Source-equivalent arithmetic tests threshold 26, ratio 1.4, wheel detent 0.5, strict axis dominance, both directions, momentum rejection, subthreshold rejection, end reset, and one-step latch. PocketSwipeArea branches retain whole-arrangement enablement, transparent hit testing, window/bounds rejection, event consumption, enable-change reset, and monitor teardown evidence. |
| Metrics/tokens/assets | Expectations freeze card/header/footer/ask/rail/shoulder/control dimensions; exact font sizes; white ink opacities; error/status colors; on-black fill/edge; and the four exact SF Symbol configurations. Agent and task marks remain source-derived UnMark/ProviderMark treatments. |
| Long content | A Markdown fixture exercises long title, emphasis, link, and long question under exact one-/two-line tail truncation. Header control reservation is 46pt notchless and 0pt with notched shoulders. |
| Controller timing | Handoff motion and Reduce Motion are separate. Source review confirms Pocket payload refits whenever visible, opening/index changes claim keys, descending from expanded retains keys, capture-aim changes refit once, and capture-level samples do not resize. These controller-only transitions are retained as source evidence rather than invented render fields. |

No checklist check is left uncovered. Cartesian combinations not emitted as separate fixtures have a source-equivalence proof: capture level only changes AimedChip bars; status only changes the shared status mapping; display arrangement only changes shoulder/header placement and frame cutout addition; ask controls middle-row/frame height; toast controls middle copy/color but not frame height; slot count controls rail/swipe. One representative fixture per pixel/interaction-changing cross-axis is retained, with orthogonal axes independently exercised.

## Tests and deterministic regeneration

- `node --test replica-current/tests/manifest.test.mjs`: 37 passed, 0 failed.
- `npm test`: 25 passed, 0 failed.
- `node replica-current/scripts/audit-source.mjs --write` run twice; both generated artifacts were byte-identical (`cmp` passed).
- Product repository status was read only; no files there were changed.

## Known source concerns

1. Toast without ask: the card draws a fixed 31pt toast row, while AppController sizes the frame from raw `current.ask` and therefore chooses quiet 68pt height. This is a pinned-source clipping risk and has an explicit fixture (`pocket-toast-without-ask`); inventory does not repair product behavior.
2. Invalid `at`: nonempty slots keep `isOpen == true`, but `current == nil`; the card shows fallback identity/status while rail count becomes 0/N or N/N. Both defensive states are explicit and flagged for native baseline review.
3. Visual baseline artifacts remain `pending` by Task 1 contract; Task 2 owns native capture. No baseline was fabricated.
