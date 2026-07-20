# Skill Curator Revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revamp the existing Skill Curator's *memory* and *selection* layers to the decided architecture — a semantically-matched durable Pattern Ledger feeding two-cadence LLM intelligence (two-door graduation + gardening + divergence-driven modification) — while reusing the sound store/writer/collision-guard/rail/popup shell.

**Architecture:** Two-tier memory (Observation Log → Pattern Ledger), two-cadence intelligence (Cadence A = per-session ingestion + **semantic** matching; Cadence B = periodic LLM judge emitting **typed** proposals). LLM makes every judgment; deterministic code does only plumbing. Authoritative spec: `docs/superpowers/specs/2026-07-20-skill-curator-architecture.md`.

**Tech Stack:** TypeScript (Electron main, `electron/remote/`), React renderer (`engine-overrides/renderer/remote/`), Node fs (atomic tmp+rename), the existing `AgentExecutor`/`runOneShot` Claude-Code-session spawner. Tests: the repo's existing `*.test.ts` harness (vitest-style, matching current curator tests).

**Reality baseline (verified against current code, 2026-07-20):**
- `candidates.json` **already persists across sweeps** (`mergeDistill`, `Candidate.occurrences[]`, `total = Σ occurrence counts`). It is NOT reset. The gap is *how entries are matched* and *what they carry*, not persistence.
- Matching today is **`occurrenceKey(title)` slug equality** — brittle; different phrasings never fuse. This is the D2 gap.
- Selection today is a single `synthesize` pass emitting `kind: 'create'|'update'` — no two doors, no gardening, no divergence.
- Reused as-is: `curator-writer.ts` (collision guard, `disable-model-invocation:true`, ownership), `curator-diff.ts`, `skill-usage.ts`, `SkillReviewPopup.tsx`, `OrchestrateWall.tsx` rail, `curator-triage.ts`, the `Curator` scheduler, `runOneShot` spawner, `ProposalConversation` NL-edit.

---

## Global Constraints

Every task's requirements implicitly include these. They are the decisions we made; a task that violates one is wrong even if it "works." Copied verbatim from the spec + decision ledger.

1. **LLM for every judgment; deterministic code for plumbing only.** Judgments = matching, graduation, drafting, gardening, modification, timing. Plumbing = storage, retention, dedup-of-identical, scheduler, collision guard, suppression. No magic-number thresholds for *decisions*.
2. **Exactly one hard numeric floor:** a Door-2 (recurrence) entry must have `occurrences` from **≥2 distinct sessions** before the judge is asked to graduate it. Door-1 (strong prior) may graduate on 1.
3. **Two doors to promotion.** Door 1 = strong prior ("if this never recurs, would a human still be glad this skill exists?"). Door 2 = repeatable core seen ≥2× and judged significant + stable.
4. **Selection = expected future value, not frequency.** Struggle is one input, not the gate.
5. **The tracked unit is the sub-pattern** (repeatable core), with links back to source sessions. Not the whole task.
6. **Skill = self-contained unit:** body + baked-in stable specifics + per-run-varying values as slots + caveats + accreting learnings. **Hardcode vs slot test = "does this value change run-to-run?"** Secrets referenced from env/keychain, never baked. **Skills always independent; only cross-skill relation is parent→child composition; NO cross-skill facts store.**
7. **Modification = observed-behavior-vs-skill on every matching session, invoked or not.** A *single* divergence never modifies; act only on **accumulated divergence in the same direction.**
8. **No auto-apply, ever.** All proposals (create/narrow/split/merge/retire) are presented; nothing changes until the user accepts. Reject → suppress (never re-surface). Edit → boundary signal for that skill only (no global taste model).
9. **Precision-first surfacing** — only high-confidence proposals surface (miss > annoy).
10. **`disable-model-invocation: true` on every curated skill** (never auto-invoked). Writer collision guard touches **only ledger-owned** skills.
11. **Cost is not a v1 constraint,** but curator cost must scale with *sessions + a periodic pass*, never per user action (keep the sequential-distill + single-judge shape). Every intelligent stage is a Claude Code session on the user's subscription (no API key).
12. **Retention/consent default (blessed, revisitable):** distilled patterns persist; raw traces on a short rolling window then dropped; feature discloses it observes sessions. Devlog stays dev-gated (never persists transcripts in the public build).
13. **Reuse, don't recreate.** Extend the existing files; do not rewrite writer/diff/rail/popup/scheduler. Keep `candidates.json` backward-compatible (new fields optional).

---

## File Structure

**Modified:**
- `electron/remote/curator-store.ts` — extend `Candidate` → ledger entry (new optional fields); add status/variance/divergence/suppression helpers; add retention housekeeping; refactor merge to key on a **matcher-resolved** target, not a title slug.
- `electron/remote/curator-prompts.ts` — enrich distill (emit variance + agree/diverge on invoked skills); **new matcher prompt+parser**; replace synthesize with the **Cadence-B judge** (two doors + gardening verbs); extend `Proposal.kind`.
- `electron/remote/curator.ts` — insert the **matcher stage** into Cadence A between distill and accumulate; feed enriched inputs to the judge; add retention housekeeping call in success bookkeeping.
- `electron/remote/curator-writer.ts` — accept the new proposal kinds (map narrow/split/refine → SKILL.md writes; retire → delete-with-ownership-guard).
- `engine-overrides/renderer/remote/SkillReviewPopup.tsx` + `OrchestrateWall.tsx` — render typed proposals (create/narrow/split/merge/retire); suppression on reject already flows via `appendRejection`.

**Created:**
- `electron/remote/curator-match.ts` — pure helpers for the matcher (retrieval pre-filter, apply-match merge, suppression fingerprinting). Prompt text lives in `curator-prompts.ts`; pure logic here.
- Tests beside each: `curator-match.test.ts`, plus new cases in the existing `curator-store.test.ts` / `curator-prompts.test.ts`.

---

## STAGE 1 — Pattern Ledger data model + retention (foundation)

Everything reads off the ledger; build it first. Pure-logic + storage — fully coded here.

### Task 1: Extend the ledger entry type (backward-compatible)

**Files:**
- Modify: `electron/remote/curator-store.ts` (types near :44-46)
- Test: `electron/remote/curator-store.test.ts`

**Interfaces:**
- Consumes: existing `Candidate`, `CandidateOccurrence`, `CandidatesFile`.
- Produces: enriched `Candidate` (all new fields **optional** so existing `candidates.json` loads unchanged).

- [ ] **Step 1: Write failing test** — an old-format candidate (no new fields) round-trips through read/write and the new accessors default correctly.

```ts
// curator-store.test.ts
test('legacy candidate loads with defaulted ledger fields', () => {
  const legacy: Candidate = {
    key: 'file-taxes', title: 'File taxes', skeleton: '...', total: 1,
    struggle: true, firstSeen: 'a', lastSeen: 'a', occurrences: [],
  }
  expect(entryStatus(legacy)).toBe('watched')       // default
  expect(distinctSessionCount(legacy)).toBe(0)
  expect(legacy.divergenceLog ?? []).toEqual([])
})
```

- [ ] **Step 2: Add fields + pure accessors** to `curator-store.ts`:

```ts
export type EntryStatus =
  | 'watched' | 'graduated' | 'surfaced' | 'accepted' | 'live' | 'rejected' | 'retired'

export interface VarianceMap {
  constant: string[]   // parts stable across every occurrence (skill body)
  varying: string[]    // parts that change per run (become slots)
}
export interface DivergenceObservation {
  sessionId: string
  at: string
  verdict: 'agree' | 'diverge'
  note: string         // what diverged, in the same direction language the judge reads
}

// EXTEND Candidate (all new fields optional — legacy files stay valid):
export interface Candidate {
  key: string; title: string; skeleton: string; total: number; struggle: boolean
  firstSeen: string; lastSeen: string; occurrences: CandidateOccurrence[]
  // --- ledger enrichment (optional) ---
  status?: EntryStatus
  variance?: VarianceMap
  priorScore?: number          // 0..1, the Door-1 judgment
  priorRationale?: string
  linkedSkillId?: string       // skill name this pattern owns, once created
  divergenceLog?: DivergenceObservation[]
}

export function entryStatus(c: Candidate): EntryStatus { return c.status ?? 'watched' }
export function distinctSessionCount(c: Candidate): number {
  return new Set(c.occurrences.map(o => o.taskId)).size
}
```

- [ ] **Step 3: Run tests → pass.** `Run: npx vitest run electron/remote/curator-store.test.ts`
- [ ] **Step 4: Commit** — `feat(curator): enrich ledger entry with status/variance/divergence (backward-compatible)`

### Task 2: Suppression + retention housekeeping (pure + storage)

**Files:**
- Create: `electron/remote/curator-match.ts` (suppression fingerprint helper)
- Modify: `electron/remote/curator-store.ts` (retention prune; suppression check against `rejections.json`)
- Test: `electron/remote/curator-match.test.ts`, `curator-store.test.ts`

**Interfaces:**
- Produces: `suppressionFingerprint(draftName, signature): string`; `isSuppressed(fp, rejections): boolean`; `pruneTraces(paths, now, keepDays): Promise<string[]>`.

- [ ] **Step 1: Failing test** for a stable fingerprint + a rejected-name match, and for trace pruning older than the window.

```ts
// curator-match.test.ts
test('suppression fingerprint is stable and name-anchored', () => {
  const a = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  const b = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  expect(a).toBe(b)
})
test('isSuppressed matches a prior rejection by name', () => {
  expect(isSuppressed('file-taxes', [{ at: 'x', name: 'file-taxes' }])).toBe(true)
})
```

- [ ] **Step 2: Implement** `curator-match.ts` fingerprint (sha256 of `name + ' ' + normalized signature`) and `isSuppressed` (name-anchored, since rejections are keyed by skill name — reuse existing `rejections.json` via `readRejections`). Add `pruneTraces` to `curator-store.ts` mirroring the telemetry prune pattern (parse `<taskId>-<sweepId>.txt`, drop files whose mtime < `now - keepDays*86400e3`). **Retention default: keepDays = 14** (raw traces are the short-window artifact per Constraint 12; distilled ledger persists indefinitely — do NOT prune `candidates.json`).
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Wire prune** into `runSweep` success bookkeeping (curator.ts step 6) — `await pruneTraces(paths, tNow, 14)` best-effort (swallow errors; never break the sweep).
- [ ] **Step 5: Commit** — `feat(curator): suppression fingerprint + rolling trace retention`

---

## STAGE 2 — Cadence A: semantic matching (the D2 core)

Replace title-slug keying with an LLM matcher. This is the load-bearing change; validate fusion quality here (Constraint: watch same-pattern-different-wording).

### Task 3: Matcher prompt + parser

**Files:**
- Modify: `electron/remote/curator-prompts.ts` (add `buildMatchPrompt` + `parseMatchOutput`)
- Test: `curator-prompts.test.ts`

**Interfaces:**
- Produces:
  - `buildMatchPrompt(i: { procedures: DistillProcedure[]; ledgerShortlist: Array<{ key: string; title: string; skeleton: string }>; outPath: string; devMode?: boolean }): string`
  - `parseMatchOutput(raw: string | null): MatchDecision[]` where `interface MatchDecision { procedureIndex: number; matchedKey: string | null; confidence: number; variedThisRun: string[] }` — `matchedKey:null` = new entry.

- [ ] **Step 1: Failing test** — parser drops malformed rows, coerces `confidence` to a number, defaults `variedThisRun` to `[]`, and accepts `matchedKey:null`.
- [ ] **Step 2: Implement prompt** — the matcher reads each distilled procedure and, against the **shortlist only**, decides for each: which existing entry (by `key`) it *extends* (same repeatable core, ignoring per-run specifics), or `null` for new. **Contract (JSON to outPath, tmp+rename):** `{"matches":[{"procedureIndex":N,"matchedKey":"..."|null,"confidence":0..1,"variedThisRun":["..."]}]}`. Prompt MUST instruct: match on the *repeatable core*, treat differing file/branch/ticket/account values as `variedThisRun` (slots), not as reasons to call it a new pattern (this is what fuses phrasings). `devMode` adds top-level `reasoning`.
- [ ] **Step 3: Implement parser** with the same defensive discipline as `parseDistillOutput`.
- [ ] **Step 4: Run tests → pass.**
- [ ] **Step 5: Commit** — `feat(curator): semantic matcher prompt + parser`

### Task 4: Retrieval pre-filter + apply-match merge (pure)

**Files:**
- Modify: `electron/remote/curator-match.ts` (`shortlist`, `applyMatch`)
- Modify: `electron/remote/curator-store.ts` (refactor merge to key on a resolved target)
- Test: `curator-match.test.ts`

**Interfaces:**
- Produces:
  - `shortlist(file: CandidatesFile, proc: DistillProcedure, limit: number): Array<{key;title;skeleton}>` — cheap keyword/token overlap ranking (no LLM; keeps the judge input bounded as the ledger grows; while small it may return all).
  - `applyMatch(file: CandidatesFile, proc: DistillProcedure, decision: MatchDecision, ctx: { taskId; sweepId; at; tracePointer }): CandidatesFile` — pure; if `matchedKey` set, append occurrence to that entry and fold `variedThisRun` into `variance.varying` (dedup); else create a new `watched` entry (keyed by `occurrenceKey(title)` for a stable id, but existence is now matcher-decided, not slug-decided). Idempotent per (key, taskId, sweepId), preserving the current `mergeDistill` idempotency guarantee.

- [ ] **Step 1: Failing tests** — (a) a matched proc appends an occurrence to the existing entry and grows `variance.varying`; (b) an unmatched proc creates a new `watched` entry; (c) re-applying the same (key, taskId, sweepId) is a no-op (idempotent).
- [ ] **Step 2: Implement** `shortlist` (token-overlap score on title+skeleton, top `limit`, default 12) and `applyMatch` (reuse the occurrence-append + `total = Σ counts` logic from `mergeDistill`; set `status:'watched'` on new entries; keep `firstSeen/lastSeen/struggle` semantics identical to current `mergeDistill`).
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Commit** — `feat(curator): retrieval shortlist + apply-match merge`

### Task 5: Wire the matcher into Cadence A

**Files:**
- Modify: `electron/remote/curator.ts` (runSweep, between distill loop and accumulate — current :397-412)
- Test: `curator.test.ts`

**Interfaces:**
- Consumes: `buildMatchPrompt`, `parseMatchOutput`, `shortlist`, `applyMatch`, `runOneShot`.

- [ ] **Step 1: Failing test** — with a stubbed executor returning a canned match JSON, a sweep fuses two differently-titled procedures from two sessions into ONE ledger entry with 2 occurrences (proves semantic fusion replaces slug-keying).
- [ ] **Step 2: Implement** — after the per-session distill loop, run ONE matcher session per sweep: gather all procs, build `shortlist` per proc, `buildMatchPrompt`, `runOneShot('match', ...)`, `parseMatchOutput`, then fold via `applyMatch` in place of the current `mergeDistill` loop. Keep it a **single** matcher session (Constraint 11 — don't multiply quota). On matcher failure (null/parse-empty) fall back to `matchedKey:null` for all (create-new) so a bad matcher never loses data.
- [ ] **Step 3: Run tests → pass.** `Run: npx vitest run electron/remote/curator.test.ts`
- [ ] **Step 4: Commit** — `feat(curator): Cadence-A semantic matching replaces slug merge`

---

## STAGE 3 — Cadence B: two-door graduation + drafting

Rework `synthesize` into the judge. This is prompt-contract work (the judgment is the LLM's), so tasks specify **contracts + parser shapes + the deterministic floor**, not algorithmic code.

### Task 6: Extend the Proposal kind union + parser

**Files:**
- Modify: `electron/remote/curator-store.ts` (`Proposal.kind`), `curator-prompts.ts` (`parseSynthesizeOutput` / rename to `parseJudgeOutput`), `NAME_RE` unchanged.
- Test: `curator-prompts.test.ts`

**Interfaces:**
- Produces: `Proposal.kind: 'create' | 'narrow' | 'split' | 'merge' | 'retire'` (drop `'update'`; `narrow`/`refine` are the update-family; keep back-compat read of any persisted `'update'` by mapping it to `'narrow'` on load).

- [ ] **Step 1: Failing tests** — parser accepts each new kind; `narrow|split|merge` require `targetSkill`; `retire` requires `targetSkill` and needs no `draft.body`; `create` unchanged; a legacy persisted `'update'` proposal loads as `'narrow'`.
- [ ] **Step 2: Implement** the union change + parser validation per kind. `retire` proposals carry `{ kind:'retire', targetSkill, rationale, evidence }` and an empty/placeholder draft (the writer handles deletion).
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Commit** — `feat(curator): typed proposal kinds (create/narrow/split/merge/retire)`

### Task 7: The Cadence-B judge prompt (two doors + drafting)

**Files:**
- Modify: `electron/remote/curator-prompts.ts` (`buildSynthesizePrompt` → `buildJudgePrompt`)
- Test: `curator-prompts.test.ts` (assert the rendered prompt contains the binding rules — this is how we pin the decisions into the prompt)

**Interfaces:**
- Consumes: enriched `Candidate[]` (with `status`, `distinctSessionCount`, `variance`, `priorScore`, `divergenceLog`), `curatedIndex`, `rejections`, `feedback`.

- [ ] **Step 1: Failing test** — the rendered judge prompt string contains, verbatim, the binding instructions: the Door-1 human-glad test, the Door-2 "≥2 distinct sessions" rule, "struggle is one input not the gate", "FEW is the goal", the hardcode-vs-slot rule, "skills independent — no cross-skill facts", and the typed-proposal output contract. (Prompt-content tests are our anti-drift guard.)
- [ ] **Step 2: Implement** `buildJudgePrompt`. It receives, per candidate, the evidence the judge weighs (occurrences, distinct-session count, struggle, variance, priorScore, divergenceLog) and the existing skills. **It emits typed proposals** (create for graduation; narrow/split/merge/refine/retire for gardening — Stage 4 supplies the divergence inputs). **Deterministic pre-gate applied in code before the prompt** (Constraint 2): only pass a candidate as a *Door-2 create* candidate if `distinctSessionCount ≥ 2`; a candidate with `<2` sessions may only be proposed via Door-1 (strong prior). The prompt states both doors explicitly; timing is otherwise the judge's call.
- [ ] **Step 3: Implement `parseJudgeOutput`** (from Task 6's parser) to the extended `Proposal[]`.
- [ ] **Step 4: Run tests → pass.**
- [ ] **Step 5: Commit** — `feat(curator): Cadence-B judge — two-door graduation + typed drafting`

### Task 8: Prior scoring + status transitions in the sweep

**Files:**
- Modify: `electron/remote/curator.ts` (Cadence-B stage), `curator-store.ts` (status setters)
- Test: `curator.test.ts`, `curator-store.test.ts`

- [ ] **Step 1: Failing test** — after a judge run proposes `create` for entry X, X's `status` becomes `graduated`→`surfaced` (proposal persisted) and carries `linkedSkillId` only after accept (set in the existing `curator:accept` path).
- [ ] **Step 2: Implement** deterministic status plumbing: when the judge emits a `create` for a candidate, set that entry `status:'surfaced'`; on `curator:accept` set `status:'accepted'`/`'live'` + `linkedSkillId = draft.name` (extend the existing accept handler in `init.ts:1948`); on `curator:reject` set `status:'rejected'` (suppression already via `appendRejection`). The **prior score** is produced by the judge (LLM) and written back onto the candidate when present in its output; code only *stores* it (Constraint 1).
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Commit** — `feat(curator): status lifecycle + prior persistence`

---

## STAGE 4 — Gardening + §8 modification (observed-behavior-vs-skill)

### Task 9: Distill emits agree/diverge on skills present in the session

**Files:**
- Modify: `electron/remote/curator-prompts.ts` (`buildDistillPrompt` — extend the `usedCuratedSkill` reporting to a general agree/diverge), `curator-store.ts` (`DistillProcedure` gains an optional `skillObservation`)
- Test: `curator-prompts.test.ts`

**Interfaces:**
- Produces: `DistillProcedure.skillObservation?: { skill: string; verdict: 'agree'|'diverge'; note: string }` — set when the session's work corresponds to an existing skill, **whether or not it was invoked** (Constraint 7).

- [ ] **Step 1: Failing test** — `parseDistillOutput` reads `skillObservation` when `{skill,verdict,note}` are valid (verdict ∈ {agree,diverge}), drops it otherwise.
- [ ] **Step 2: Implement** — the distill prompt is given the list of existing skill names+descriptions and instructed: if the work in this trace matches an existing skill, report whether the user's actual approach **agreed with** or **diverged from** it, and how — invoked or not. Extend the parser.
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Commit** — `feat(curator): distill reports agree/diverge vs existing skills`

### Task 10: Accumulate divergence into the ledger; judge acts on accumulation

**Files:**
- Modify: `electron/remote/curator-match.ts` (`applyMatch` folds `skillObservation` into the matched entry's `divergenceLog`), `electron/remote/curator.ts` (pass observations through), `curator-prompts.ts` (judge reads `divergenceLog`)
- Test: `curator-match.test.ts`, `curator-prompts.test.ts`

- [ ] **Step 1: Failing tests** — (a) `applyMatch` appends a `DivergenceObservation` to the entry linked to that skill; (b) the judge prompt, given an entry whose `divergenceLog` has ≥2 same-direction `diverge` observations, is instructed it MAY propose `narrow`/`refine`, and given a single divergence it MUST NOT (Constraint 7 — assert the rule text is present + a code pre-gate: don't surface a modify proposal unless `divergenceLog` has ≥2 same-direction diverges).
- [ ] **Step 2: Implement** the fold + the code pre-gate `hasAccumulatedDivergence(entry): boolean` (≥2 diverge in the same direction — "same direction" approximated deterministically by identical `note` bucket / the judge refines; the pre-gate only prevents single-event thrash, the *decision* stays the judge's).
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Commit** — `feat(curator): divergence accumulation gates modification proposals`

### Task 11: Writer handles narrow/split/merge/refine/retire

**Files:**
- Modify: `electron/remote/curator-writer.ts` (`writeSkill` kind handling), `init.ts` accept handler
- Test: `curator-writer.test.ts`

- [ ] **Step 1: Failing tests** — `narrow`/`split`/`refine` write a full SKILL.md exactly like the old `update` path (collision guard: must be owned); `merge` writes the merged skill and marks the absorbed one for retire; `retire` **deletes** the skill dir **only if owned** (ownership-guarded, mirroring the collision guard) and removes its ownership entry; a `retire`/write on an unowned name returns `{ok:false,error:'collision'}` and touches nothing.
- [ ] **Step 2: Implement** — extend `writeSkill`'s kind switch. `create|narrow|split|refine` → existing render+guard+write. `merge` → write target + emit follow-up retire of the absorbed name. `retire` → owned-check → `rm -rf` skill dir + drop ownership entry, all inside `serialized(...)`.
- [ ] **Step 3: Run tests → pass.**
- [ ] **Step 4: Commit** — `feat(curator): writer supports gardening verbs incl. ownership-guarded retire`

---

## STAGE 5 — Typed-proposal review UX + suppression

### Task 12: Rail + popup render all proposal kinds

**Files:**
- Modify: `engine-overrides/renderer/remote/OrchestrateWall.tsx` (SUGGESTIONS chips), `SkillReviewPopup.tsx` (kind-aware header + evidence)
- Test: manual + existing renderer tests if present (else a small render assertion)

- [ ] **Step 1:** Extend the rail chip (`OrchestrateWall.tsx:911-928`) from `edit`/`new` to a per-kind chip label (`new` / `narrow` / `split` / `merge` / `retire`); `proposals` state type gains `kind` (already present as `'create'|'update'` — widen the union).
- [ ] **Step 2:** `SkillReviewPopup.tsx` — widen the local `Proposal.kind` union; kind-aware summary line ("Retire *X* — unused since …", "Narrow *X* to the part you actually repeat", etc.); `retire` shows no body/diff, just evidence + rationale; Accept on `retire` calls the same `curatorAccept` (writer deletes).
- [ ] **Step 3: Suppression** — verify reject path records `appendRejection` (it does, `init.ts:1974`) and that a suppressed name does not re-surface: add a code check in the judge input assembly to drop candidates whose `draft.name` is in `rejections` (Constraint 8). Add a test in `curator.test.ts`.
- [ ] **Step 4: Commit** — `feat(curator): typed-proposal review UX + reject-suppression`

---

## STAGE 6 — Finish V2 loose ends (verification)

### Task 13: Evidence backfill, accept/reject/edit click-through, live sweep

**Files:**
- Modify: `electron/remote/curator.ts` (backfill `evidence.struggle` from the accumulator so the popup's "N min of work" is real — the known cosmetic bug), tests.

- [ ] **Step 1:** Backfill `evidence.struggle.{errors,recoveries,wallClockMin}` from the matched candidate's aggregated occurrences when the judge omits them (fixes "0 min of work"). Test in `curator.test.ts`.
- [ ] **Step 2:** Manual verification checklist (record results in the ledger, not code): click-test Accept (writes SKILL.md, disappears from rail), Reject (suppressed, does not return next sweep), Edit (NL-edit rewrites `draft.md`, Accept picks up the edited body with `userEdited:true`), and one live end-to-end sweep once the subscription rate-limit window is clear.
- [ ] **Step 3: Commit** — `fix(curator): backfill struggle evidence; V2 verification pass`

---

## Self-Review (done at plan-write time)

- **Spec coverage:** ledger (§4)→T1-2; Cadence-A matching (§5, D2)→T3-5; two-door graduation (§2,§6)→T6-8; gardening + §8 modification→T9-11; typed UX + suppression (§9)→T12; V2 loose ends (§15.6)→T13. Consent/retention (§10)→T2 (14-day prune) + Constraint 12. Cost shape (§11)→Constraint 11 + single matcher/judge session.
- **Decisions pinned against drift:** the binding rules live in **Global Constraints** AND are asserted as **prompt-content tests** (T7 Step 1, T10 Step 1) — the judge prompt is verified to literally contain the two-door test, the ≥2 floor, "struggle is one input", "FEW", hardcode-vs-slot, and "skills independent / no cross-skill facts." This is the concrete guard against the "builds against what we decided" failure mode.
- **Reuse honored:** writer/diff/skill-usage/rail/popup/scheduler/runOneShot all extended, not rewritten (Constraint 13). `candidates.json` stays backward-compatible (Task 1 legacy test).
- **The one hard number:** only the ≥2-distinct-sessions Door-2 floor and the ≥2-divergence anti-thrash gate are numeric; every promotion/gardening *decision* is the LLM judge's (Constraint 1). Retention 14 days and shortlist top-12 are plumbing knobs, not decisions.
- **D2 validation:** T5 Step 1 proves semantic fusion replaces slug-keying; fusion quality is watched during T3-5 (the build-time validation the spec called for).

## Execution Handoff

Plan saved. Per the user: **do not execute yet.** When ready, REQUIRED SUB-SKILL = superpowers:subagent-driven-development (fresh subagent per task, task-review between, broad review at end). Stages are ordered by dependency; Stage 1 is the foundation and must land first.
