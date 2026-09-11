# Task 1 Report: Auditable state manifest

## Status

Implemented and committed Task 1 from `docs/superpowers/plans/2026-09-11-current-unmute-ui-replica.md` against the source revision required by `docs/redesign/current-ui-replica-spec.md`.

Implementation commit: `817714c82eae39955b99b698933e18a90f6c7142`

## Changes

- Added `replica-current/scripts/audit-source.mjs`.
  - Reads source directly from immutable Git objects in the read-only product repository.
  - Locks the audit to full revision `2c3c22bd4049b11b8f030b96069423a945571c12`.
  - Audits every Swift source under `desktop/native-notch/Sources/` and every non-test TypeScript/TSX path containing `pill` or `notetaker` at that revision.
  - Reports source files, enum cases, conditional branches, SF Symbols, literal metrics, and color/material tokens as JSON.
  - Generates the deterministic manifest with `--write-manifest` or emits it to stdout with `--manifest`.
  - Exports manifest generation and validation functions for direct behavioral testing.
- Added `replica-current/fixtures/manifest.json`.
  - Contains 1,728 branch-backed state entries and 1,728 known fixture IDs.
  - Every entry provides `id`, `family`, `source`, `symbol`, `condition`, `fixture`, `interactions`, and `baseline`.
  - Every audited branch has an explicit audit reference; no exclusions were added.
- Added `replica-current/tests/manifest.test.mjs`.
  - Validates the checked-in manifest against a fresh source audit.
  - Mutation checks prove rejection of a missing source revision, duplicate entry IDs, absent citations, unknown fixture IDs, and uncovered audited branches.
- Deleted only the five explicitly invalid files under `replica-v2/`: `index.html`, `styles.css`, `app.js`, `README.md`, and `verify.mjs`. They were untracked before deletion, so their removal does not appear in the implementation commit.
- Left the pre-existing untracked spec and plan files untouched.

## TDD evidence

Red:

`node --test replica-current/tests/manifest.test.mjs` exited 1 because `replica-current/fixtures/manifest.json` did not exist (`ENOENT`), exactly as required.

Green:

After implementing the auditor and generated manifest, the same focused command passed 1 test with 0 failures. Its invalid-manifest mutations also passed, proving each required validation failure is observable.

## Audit inventory

- Source files: 118
- Enum cases: 427
- Conditional branches: 1,728
- SF Symbols: 42
- Literal metrics: 1,887
- Color/material tokens: 81
- Manifest entries: 1,728
- Fixture IDs: 1,728

All occurrence IDs were checked for uniqueness in every report category.

## Verification

- `node --test replica-current/tests/manifest.test.mjs`: 1 passed, 0 failed.
- `npm test`: 25 passed, 0 failed.
- `node replica-current/scripts/audit-source.mjs`: emitted valid JSON.
- `git diff --check`: clean before commit.
- Staged self-review confirmed only the three Task 1 inventory artifacts were included in the implementation commit.

## Self-review

- Confirmed the source repository was never modified; all baseline reads use `git ls-tree` and `git show`.
- Confirmed source paths, symbols, and conditions are present on every generated specimen.
- Confirmed every fixture reference resolves and every audited conditional branch is covered.
- Confirmed there is no exclusion or ignore mechanism that could hide uncovered branches.
- Confirmed the five authorized invalid replica files no longer exist.
- Mutation review: deleting the revision, duplicating an ID, clearing a citation, changing a fixture reference, or removing an audit reference causes the focused test to fail.

## Concerns

- The product checkout currently points to `20dfd8fe5135371b7c4b5178a4124225a2e15662`, while the approved specification locks visual truth to `2c3c22bd4049b11b8f030b96069423a945571c12`. Task 1 deliberately audits the locked commit. If “current” is intended to mean the newer product HEAD, the spec and source revision must be updated before later visual-baseline work.
- The manifest is intentionally a complete branch skeleton. Interaction arrays and baseline paths are placeholders for the later implementation tasks described by the approved plan; Task 1 establishes auditable coverage but does not create native screenshots or browser renderers.
