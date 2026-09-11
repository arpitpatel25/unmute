# Task 1 Report: Auditable state manifest

## Status

Task 1 and review fix round 1 are implemented against product revision `20dfd8fe5135371b7c4b5178a4124225a2e15662`.

Commits:

- Initial inventory: `817714c82eae39955b99b698933e18a90f6c7142`
- Initial report: `5e90f0709eb2de8b6f5e4194163c5e1e195feeb4`
- Review fix implementation: `119590fd63a5443f9bdb4fe6378b04d5702e0988`

## Final architecture

- `replica-current/fixtures/audit.json` is static audit evidence, separate from render states. It records every selected source file, enum case, conditional branch, SF Symbol, literal metric, and color/material token plus an explicit `render-affecting`, `render-input`, or `non-rendering` classification, state backlinks where applicable, and a written reason.
- `replica-current/fixtures/manifest.json` is a curated matrix of 154 render states across foundations, pill, notch, Pocket, conversation, cockpit, scratchpad, notetaker, and new-conversation families. It is no longer one entry per syntax branch.
- Every fixture has a state backlink and concrete renderer input containing `surface`, `variant`, and deterministic state data.
- Every state has either concrete control/event/result interactions or an explicit noninteractive reason.
- Every baseline is `{status: "pending", reason: "...Task 2..."}`. No nonexistent PNG path is presented as an artifact.
- `replica-current/scripts/audit-source.mjs` reads immutable Git objects from the read-only product repository, records current product HEAD and source-drift status, scans only approved visual source sets, generates both artifacts deterministically, and validates their independent schema and relationships.

## Source scope

The audit includes:

- Every Swift file under `desktop/native-notch/Sources/`.
- `desktop/electron/remote/notch/pill-controller.ts`.
- `desktop/electron/remote/notetakerWidget.ts`.
- `desktop/engine-overrides/renderer/widget/pillBridge.ts`.
- Non-test TypeScript/TSX files under `desktop/engine-overrides/renderer/notetaker/`.

Backend STT, Electron notetaker processing utilities, tests, paywall pills, and unrelated filename matches are excluded from the visual source set.

## Final inventory

- Selected source files: 91
- Enum cases: 427
- Conditional branches: 1,456
- SF Symbols: 42
- Literal metrics: 1,711
- Color/material tokens: 81
- Total classified audit occurrences: 3,717
- Curated render states: 154
- Concrete fixtures: 154
- Pending baselines: 154
- Interactive states: 40
- Explicitly noninteractive states: 114

## Fix-round TDD evidence

Red 1: the expanded focused suite failed all five tests because `scanSourceText` and `audit.json` did not exist and the old manifest lacked the revised schema.

Green 1: after separating audit evidence, curating states, adding concrete fixtures/interactions/pending baselines, and strengthening validation, all five focused tests passed.

Red 2: the classification-count test failed with 1,456 classifications versus 3,717 total occurrences, proving non-branch audit evidence lacked explicit classification.

Green 2: classifications and relationship validation were extended to enum, branch, symbol, metric, and token occurrences; all five focused tests passed.

Red 3: the current-HEAD test failed because audit evidence did not expose `productHead` or `sourceDrift`.

Green 3: both fields were added and validation now rejects recorded source drift; all five focused tests passed.

## Independent validation coverage

The focused tests use hand-authored Swift and TypeScript syntax fixtures to check multiline conditions, nested lexical symbol attribution, enum cases, SF Symbols, ternaries, and logical conditional rendering independently of product-source output. Mutation tests reject:

- Missing or mismatched source revisions.
- Duplicate state IDs and absent citations.
- Unknown fixture IDs, orphan fixtures, broken fixture backlinks, and empty fixture inputs.
- Invalid interaction and baseline schemas.
- Unknown audit IDs and source/symbol/condition disagreement with primary evidence.
- Missing occurrence classifications, unknown state backlinks, and missing bidirectional state/audit backlinks.

## Verification and self-review

- `node --test replica-current/tests/manifest.test.mjs`: 5 passed, 0 failed.
- `npm test`: 25 passed, 0 failed.
- Re-running `node replica-current/scripts/audit-source.mjs --write` produced byte-identical manifest and audit artifacts.
- Stale revision and fabricated baseline path scans were empty.
- `git diff --check` passed.
- Product source remained read-only; source content is obtained only with `git ls-tree`, `git show`, and `git rev-parse`.
- The five explicitly invalid untracked `replica-v2` files remain deleted. Existing `replica/` and `experience/` are untouched.
- Pre-existing untracked authoritative spec and plan files remain untouched and uncommitted.

## Concerns

- The scanner is syntax-aware and independently fixture-tested but does not use full SwiftSyntax or TypeScript compiler AST dependencies, which are not present in this dependency-free project. The explicit classifications and syntax fixtures make its supported extraction contract auditable; future new syntax forms require adding a failing fixture before extending extraction.
- Fixture payloads define the renderer-facing state contract for Task 1. Later renderer tasks must consume these fields directly or evolve the manifest schema and tests deliberately rather than silently replacing them.
