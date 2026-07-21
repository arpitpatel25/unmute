# Skill Curator Re-Aim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Re-aim the curator from "mine the model's work, gate on struggle" to the user-side model in **§0 of `docs/superpowers/specs/2026-07-20-skill-curator-architecture.md`** — and **delete the old paths**, not leave them dead.

**Authoritative source:** §0 of the architecture spec. Every task's requirements implicitly include it. When this plan and §0 disagree, §0 governs.

**Reuse (do NOT rewrite):** the two-cadence structure, `curator-store` (ledger/cursor/proposals), `curator-writer`+diff+collision guard, `curator-index` (dedup), the scheduler, the **conversation-keyed transcript resolution** (already fixed), `curator-triage` (kept **only** as a cheap material gate).

**Rewrite / re-aim:** `curator-prompts` (all three prompts), the sweep orchestration in `curator.ts`, the accumulator behavior in `curator-match`/`curator-store`.

**Delete (clean-removal, verified at the end):**
- the distill "hunt reusable pieces of the model's WORK" anchor + struggle-first framing;
- **struggle-as-a-skill-signal** — triage stays a material gate, but its `is_error`/backtrack counts must not drive skill selection; the `skillObservation` model-error path;
- the **eager-suspect / fuzzy-confirm / never-decay** accumulator behavior (auto-fold everything, no decay).

---

## Global Constraints (binding — from §0)

1. **User side is the index.** Extraction reads the user's turns; the model transcript is read **only where a user message points** (intent execution → body; a correction → the action it refers to). Never open-scan model output.
2. **Entry signal = actionable intent + reusable context supplied by the user** → a **suspicion**, not a skill. Discussions produce nothing.
3. **Two gates:** entry (suspicion, not surfaced) vs graduation (must **recur**, strict confirm — no fuzzy match). **Decay** kills unconfirmed suspicions within a window.
4. **Struggle = user corrections only** (a user-side utterance), a **bonus never a gate**; its absence must never reject. **No model-error counting as a skill signal.**
5. **Per-session = two extraction modes** (new-work always; skill-usage-audit only when a skill was invoked). **Periodic = one unified judge** (create/graduate/dedup/modify/prune/compose/attach-meaning) — never fragmented.
6. **Every LLM stage returns a structured `reason`** — dev-logged only (`devLogEnabled`), never surfaced, never stored in a skill, never fed into a decision.
7. **Personal, not general** — skills carry the user's specifics; value is context-elimination.
8. **Clean removal is a first-class deliverable.** No old path left dead. A final grep must show the deleted anchors are gone. tsc = 0, tests green throughout.

---

## STAGE 1 — Reasoning capture + logging scaffold (do first; every later stage uses it)

### Task 1: structured `reason` on every stage, dev-logged
- **Files:** `curator-devlog.ts`, `curator-prompts.ts` (the `reasoning` hook), tests.
- Make the `reason`/`reasoning` field **always requested and always dev-logged** for extraction, audit, and judge (not just an optional devMode extra). Add a `devlogReason(stage, sweepId, payload)` helper; ensure it is a no-op when `devLogEnabled()` is false. Confirm `reason` is never written into a proposal draft or ledger skill.
- [ ] Test: `devlogReason` writes under the gate and is a no-op when off; parsers expose `reason` without leaking it into `draft`.
- [ ] Commit: `feat(curator): mandatory dev-logged reasoning on every LLM stage`

---

## STAGE 2 — New-work extraction, user-side anchored (Cadence A, mode 1)

### Task 2: rewrite the distill prompt + parser to user-side extraction
- **Files:** `curator-prompts.ts` (`buildDistillPrompt` → user-side; parser), `curator-store.ts` (`DistillProcedure`/finding shape), tests.
- The prompt reads the **user's turns** and extracts, per (intent), the **reusable context** the user supplied; it reads the model side **only** where the user pointed (to fill a body sketch). Output the **entry test** result: `{ intent, contextSupplied[], isActionable, correction?, reason }`. Emit nothing for discussion-only sessions.
- **DELETE** the old "find reusable recurring pieces of WORK / struggle=primary" content and the model-work anchor. Relocate struggle to a user **correction** field.
- [ ] Test (prompt-content, anti-drift): the rendered prompt contains the user-side-index rule, the entry test (actionable intent + reusable context), and the "corrections are the struggle signal" instruction; asserts the old "pieces of WORK"/"struggle is the PRIMARY" text is **gone**.
- [ ] Test (parser): keeps only findings with an actionable intent + ≥1 context item; a discussion-only output yields `[]`.
- [ ] Commit: `feat(curator): user-side new-work extraction; remove model-work anchor`

---

## STAGE 3 — Skill-usage audit (Cadence A, mode 2, conditional)

### Task 3: detect invocation + a focused audit pass
- **Files:** `curator.ts` (sweep: detect a skill invocation via `skill-usage.extractSkillUses` on the session; if present, run one focused audit one-shot), `curator-prompts.ts` (`buildAuditPrompt` + parser), tests.
- Audit question: did the invoked skill **finish the job**, or leave the user at stage X so they hand-drove the rest → an **extend/modify** signal on that skill. Returns `{ skill, verdict: 'ok'|'extend'|'wrong', note, reason }`. Runs **only** when a skill was invoked (most sessions skip it).
- **DELETE** the old distill-embedded `skillObservation` agree/diverge (moved here, as its own focused pass).
- [ ] Test: a session with a `Skill` tool-use triggers the audit pass; a session without one does not; parser validates the verdict enum.
- [ ] Commit: `feat(curator): conditional skill-usage audit pass (extend signal)`

---

## STAGE 4 — Watch-list discipline: suspicion entry + strict confirm + decay

### Task 4: suspicion entry + strict matching
- **Files:** `curator-store.ts` (entry = suspicion status; entry requires the entry-test), `curator-match.ts` (matching for confirmation is **strict** — a genuine same intent+context, not fuzzy token overlap), tests.
- **DELETE** the auto-fold-everything behavior: a finding only enters the ledger if it passes the entry test; confirmation requires a strict match, not "close enough."
- [ ] Test: a finding without reusable context does NOT create a suspicion; two genuinely-same intents confirm, two loosely-similar-but-different intents do NOT.
- [ ] Commit: `feat(curator): stingy suspicion entry + strict confirmation`

### Task 5: decay
- **Files:** `curator-store.ts` (`pruneSuspicions(file, now, windowDays)` — drop suspicions with no confirmation within the window), `curator.ts` (call it in bookkeeping), tests.
- [ ] Test: an unconfirmed suspicion older than the window is dropped; a confirmed/recent one survives.
- [ ] Commit: `feat(curator): watch-list decay (unconfirmed suspicions expire)`

---

## STAGE 5 — The unified periodic judge (Cadence B)

### Task 6: rewrite the judge prompt + selection
- **Files:** `curator-prompts.ts` (`buildSynthesizePrompt` → the unified judge; parser), `curator.ts` (feed it the ledger + skill set + audit signals), tests.
- One judge emits typed proposals: **create** (only for graduated suspicions — recurrence OR a genuine "you'll predictably ask again" prior, **not** "it was hard"), **narrow/split/merge/refine** (from audit/divergence), **retire**, and attaches **meaning** (when-to-use) to each. Dedup via `curator-index` (global + project skills). Emit `reason`.
- **DELETE / replace** the struggle-and-three-tests selection framing where it conflicts with §0. Door-1 prior test becomes **"will the user predictably ask for this again"**, not difficulty.
- [ ] Test (prompt-content): asserts the graduation rule (recurrence or predictable-recurrence prior), the "difficulty is not the test" exclusion, the extend-from-audit path, and dedup; asserts the old "struggle is primary / would-base-model-have-struggled" framing is **gone**.
- [ ] Commit: `feat(curator): unified judge — user-value graduation, extend, prune, meaning`

### Task 7: wire the two cadences in the sweep
- **Files:** `curator.ts` (Cadence A = new-work extraction per session [+ conditional audit]; Cadence B = the one judge over the accumulated ledger), tests.
- Keep the conversation-keyed resolution, cursor-on-success, and rate-limit semantics intact.
- [ ] Test: an end-to-end stubbed sweep runs extraction → (audit if invoked) → judge → proposals, with `reason` logged at each stage.
- [ ] Commit: `feat(curator): two-mode extraction + unified judge orchestration`

---

## STAGE 6 — Clean-removal verification + finish

### Task 8: prove the old paths are gone + regenerate the explainer
- [ ] Grep the codebase for the deleted anchors (old distill "pieces of WORK" text, struggle-as-skill-signal, auto-fold/fuzzy-confirm/no-decay). **Zero hits** outside tests that assert their absence.
- [ ] Full suite green + `tsc -p tsconfig.typecheck.json` = 0 errors.
- [ ] Regenerate the design explainer artifact to reflect §0 (the *shipped* design).
- [ ] Commit: `chore(curator): verify clean removal of old selection paths`

---

## Self-Review
- **Spec coverage:** §0 A→G each map to a task (A/B/user-side→T2; C/decay→T4-5; D/struggle→T2+T3; E/two-cadence→T3,T6,T7; F/reason→T1 + every stage; G/personal→T2,T6). Removal list → T2, T3, T4, T6, verified T8.
- **Removal is first-class:** every rewrite task names what it DELETES; T8 gates on grep-clean.
- **Reasoning capture** is Stage 1 (before anything uses it) and asserted per stage.
- **Reuse honored:** store/writer/diff/index/scheduler/conversation-keying/triage-as-gate untouched except where §0 requires.

## Execution
Subagent-driven, one task at a time, review between, clean-removal grep as the final gate. No dev-flag flips in committed code. Build a `dev.N` only when we want to field-test the re-aimed curator live.
