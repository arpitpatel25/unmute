# Skill Curator — Definitive Architecture Spec

**Status:** design-complete, implementation-ready. No code yet.
**Supersedes:** the "§15 Curator Operating Theory v2" section of
`2026-07-17-skill-curator-design.md`. That doc's *mechanism* (store, writer,
rail, popup, scheduler, collision guard) remains valid and is **reused**; its
*selection theory* is replaced by this document.
**Companions:** `2026-07-20-skill-curator-philosophy.md` (the *why*),
`2026-07-20-skill-curator-nuance-inventory.md` (the decision ledger). When any
document disagrees with this one on architecture, this one governs.

---

## 0. REFRAME (2026-07-21) — user-side anchor. **This section supersedes the selection model in §2–§6 below.** The two-cadence structure, storage, writer, scheduler, and conversation-keyed transcript resolution still hold.

The first live runs proved the old selection produced *accurate but useless*
skills (`unmute-native-mcp`, `verify-paywall-edits`) — deep engineering
procedures no user would ever invoke. Root cause: it mined **the model's work**
and gated on **struggle**. Both are wrong. The corrected model:

**A. A skill lives on the USER's side of the conversation, not the model's.**
A SKILL.md is a thing the *user* keeps asking for. So the curator reads the
**user's turns** as the index, and reads the model's transcript **only where the
user's messages point** (the intent it served; the action a correction refers
to). Never open-scan the model side — that is the noise + wrong-anchor source.
- **User side = SELECTS + ANCHORS** — what the skill is, whether it recurs, the
  context to bake in, the corrections/preferences.
- **Model side = FILLS THE BODY** — the steps that actually worked, read only at
  the points the user pointed to.

**B. The entry signal = the user supplied *reusable context* for an *actionable
intent*.** You only bother specifying "look in this field / this order / this
tool / this location" for things you'll do again — so supplied-context is a
proxy for recurrence *and* is the skill's value (context-elimination). Entry
test, judged from the user's messages only: (1) an actionable intent (a task,
not discussion) AND (2) reusable context/preferences supplied. Clears both → a
**suspicion**. Neither → ignored. Discussions produce nothing — the normal case.

**C. Context earns a *suspicion*, not a skill. Two gates:**
- **Entry (suspicion):** actionable intent + reusable context → onto the
  watch-list. NOT surfaced.
- **Graduation (skill):** the same intent+context genuinely **recurs** (strict
  confirm, no fuzzy "close enough"). Only then does it surface for review.
- **Decay:** a suspicion that doesn't earn a real confirmation within a window
  **dies**. One-offs (even context-rich ones) quietly expire on the watch-list.
- Stingy at entry + strict at graduation + decaying is *safe*, because recurring
  things recur — missing one on first sight costs nothing; a bloated/fuzzy
  watch-list actively manufactures junk.

**D. Struggle is RELOCATED from the model side to the user side.** Do NOT count
model errors / backtracks (`is_error` tool results — noisy, drags toward
hard-implementation tasks). The meaningful signal is **the user had to correct
the model** — a user-side utterance ("no, do it this way", "why did you use the
desktop app"). It reveals *how the user wants it* (→ body) and *the real gap a
skill should close* (→ value). Struggle stays only in this form, as a **bonus,
never a gate** — its absence must never reject a candidate.

**E. Per-session extraction has TWO modes; judgment is periodic and unified.**
- **Cadence A (per session):**
  - **New-work mode (always):** extract user-side intent+context → suspicions /
    confirm existing suspicions. Returns a structured `reason`.
  - **Skill-usage-audit mode (only if a skill was invoked — detected
    deterministically):** did the invoked skill finish the job or leave the user
    at stage X (then they hand-drove the rest)? → modification/**extend** signal.
    Its own focused pass. Returns a structured `reason`.
- **Cadence B (periodic): ONE unified judge** over the accumulated ledger + skill
  set — create / graduate / dedup / modify / prune / compose / attach-meaning.
  Never fragmented into per-type passes (they must see each other to stay
  coherent). Returns a structured `reason`.
- Rule of thumb: needs only *this transcript* → per-session extraction; needs the
  *whole accumulated picture* → the periodic judge.

**F. Reasoning capture (global constraint).** Every LLM stage returns a
structured `reason` for its decision. **Dev-logged only** (devLogEnabled gate) —
never shown to the user, never stored in a skill, never fed back into a decision.
Purely for our analysis of what went wrong (prompt vs context vs judgment).

**G. Personal, not general.** These skills carry the user's specifics (their
locations, tools, preferences). Their whole value is context-elimination for
*this* user. Borrow SKILL.md *format* and recognizability from skills.md /
Anthropic; never borrow their "generally useful" selection criterion.

**Old code to REMOVE (not leave dead), when implementing this reframe:**
- the distill prompt's "hunt reusable pieces of the model's WORK" anchor and its
  struggle-first framing → replaced by user-side intent+context extraction;
- struggle-as-selection (triage's `is_error`/backtrack counting used as a
  *skill* signal — triage may stay as a cheap material gate, but struggle must
  not drive skill selection);
- the eager-suspect / fuzzy-confirm / never-decay accumulator behavior →
  replaced by stingy-entry + strict-confirm + decay.

---

## 1. Goal

An **observability layer** over the user's Claude Code sessions that watches the
work they already do — across any domain, tool, or project — and turns the
*recurring, valuable* parts into **user-facing Agent Skills** (`~/.claude/skills/
<name>/SKILL.md`, `disable-model-invocation: true`), which the user reviews and
accepts, and which are **never auto-invoked**. The system also **maintains** that
skill set over time (create + garden). This is a **production feature, not a
pilot** — the full substrate ships, build order may stage it.

## 2. The selection principle

Skills are selected on **expected future value**, not frequency:

> value ≈ P(the user hits something like this again) × cost-of-re-deriving ×
> stability-of-the-path.

Two independent **doors** promote a candidate to a proposal:

- **Door 1 — strong prior:** the LLM judges "**if this literally never happens
  again, would a human still be glad this skill exists?**" (e.g. tax filing:
  frequency≈1, huge struggle, obviously worth it). Can surface on a single
  sighting.
- **Door 2 — observed recurrence** of a repeatable *portion* (see §5): the
  repeatable core is seen ≥2 times and the judge deems it significant + stable.

Struggle is **one input** (evidence of a capability gap), not the gate. **FEW is
the goal** — disciplines and *incidental* navigation are excluded; a *recurring
navigation-heavy task* (e.g. "each morning sweep my Gmail accounts → fetch X →
drop into a Google Doc") **is** a skill.

## 3. Architecture spine

**Two-tier memory, two-cadence intelligence, and one hard rule: the LLM makes
every _judgment_; deterministic code does only _plumbing_.**

- **Tier 1 — Observation Log:** on each periodic pass, every session's
  **delta since its cursor** (live or closed — never wait for a session to end)
  is distilled (LLM) into compact structured **findings**, read with a lookback
  window before the cursor so the delta never starts mid-thought. Raw trace
  retained on a short rolling window.
- **Tier 2 — Pattern Ledger:** the durable cross-session memory. Entries are
  **sub-patterns** (repeatable cores), surviving months. This is the substrate
  everything else reads.
- **Cadence A — Ingestion & Matching** (each periodic pass, cheap): every
  session's delta-since-cursor (live or closed) is distilled and its findings are
  matched (LLM) into the ledger — merged or added. Runs on the same
  twice-daily/material-gated schedule as Cadence B, not on session end.
- **Cadence B — Judgment & Gardening** (periodic; existing twice-daily,
  material-gated schedule; expensive — the real intelligence): an LLM judge reads
  the ledger + the existing skill set and emits **typed proposals**.

**Deterministic plumbing only:** storage, retention housekeeping, dedup of
identical findings, the scheduler, the collision guard, suppression of
already-rejected proposals, and exactly one definitional floor — a Door-2 entry
must be seen **≥2** times before the judge is asked to consider it (recurrence
requires two). Everything above the floor — matching, graduation, drafting,
gardening, timing — is **LLM judgment on accumulated evidence**, never a magic
constant.

## 4. Data model

### 4.1 Observation-Log finding (Tier 1)
- `sessionId`, `timestamp`
- `signatureDraft` — NL description: what work, what domain
- `struggle` — failed/backtracked/corrected evidence for this finding
- `approachSummary` — what the user actually did (the observed path)
- `invokedSkillIds` — skills invoked during this session, if any
- `rawTraceRef` + `retentionExpiry` — pointer to raw trace on the rolling window

### 4.2 Pattern-Ledger entry — the durable unit (Tier 2)
- `id`
- `signature` — canonical NL description of the sub-pattern (the repeatable core)
- `varianceMap` — **what's constant vs what varies per run** (drives hardcode-vs-
  slot in §5, and narrow/re-fit in §6)
- `occurrences[]` — `{sessionId, timestamp, struggle, approachSummary}`; count &
  `firstSeen`/`lastSeen` derived
- `priorScore` + `priorRationale` — the Door-1 judgment
- `status` — `watched | graduated | surfaced | accepted | rejected | live |
  retired` (§7 state machine)
- `linkedSkillId?` — the skill this pattern produced/owns, if any
- `divergenceLog[]` — for entries with a skill: accumulated **agree / diverge**
  observations from §8, each `{sessionId, verdict, note}`
- `suppressedFingerprints[]` — rejected-proposal fingerprints; never re-surface

### 4.3 Skill artifact (unchanged format, reused writer)
SKILL.md with frontmatter (`disable-model-invocation: true`, ownership record);
body = approach + **baked-in stable specifics** + **per-run-varying values as
slots** + caveats/gotchas + accreting learnings. Secrets are **referenced from
env/keychain**, never baked in. Skills are **always independent**; the only
cross-skill relation is **parent→child composition**. **No cross-skill facts
store.**

## 5. Cadence A — ingestion & matching (per session)

1. **Distill** the ended session → findings (LLM). *(Reuses today's distill
   stage.)*
2. For each finding: **retrieval pre-filter** the ledger to a shortlist of
   plausibly-related entries (keeps the LLM from diffing the whole ledger; may be
   a no-op while the ledger is small), then **LLM adjudicates** — does this finding
   *extend an existing entry* or *start a new watched entry*? Matching is
   **semantic, not cosine**, so different phrasings of the same pattern fuse.
3. On merge: append the occurrence, update `varianceMap` (what newly varied),
   aggregate struggle.
4. If the matched entry **has a linked skill** → also record an **agree/diverge**
   observation into `divergenceLog` (§8) — invoked or not.
5. Deterministic housekeeping: identical-finding dedup, retention expiry.

**Boundary-fitting note:** a pattern seen once yields an *over-fit* entry
(specifics baked into `signature`/`varianceMap`). Repetition is what factors the
varying 20% into slots — the LLM's one-shot guess is a prior on the boundary;
repetition corrects it.

## 6. Cadence B — judgment & gardening (periodic)

One LLM judge reads the ledger (watched entries, entries-with-skills +
their divergence logs) and the existing skill set, and emits **typed proposals**:

- **create** — a `watched` entry passes **Door 1** (strong prior) or **Door 2**
  (≥2 sightings + significant, stable repeatable core). Drafting: extract the
  stable core as the skill body, factor `varianceMap` variables into slots, bake
  stable specifics, attach caveats.
- **narrow** — an existing skill whose `divergenceLog` shows the user reliably
  does a *subset*; tighten to the stable core.
- **split** — one skill that is really two sub-patterns.
- **merge** — two skills that co-occur/overlap heavily.
- **refine / add-learning** — fold an accumulated correction into a skill.
- **retire** — a skill unused across enough time/observation that the judge deems
  it dead.

**All timing is judgment on accumulated evidence**, not fixed N/K/T: occurrence
count, similarity, recency, struggle, and divergence-direction are *inputs* the
judge weighs. The only hard number is the Door-2 ≥2 floor.

**Precision-first gate:** only high-confidence proposals surface (miss > annoy;
configurable later). **Suppression:** drop any proposal matching a
`suppressedFingerprint`.

## 7. Lifecycle state machine (per ledger entry)

```
            (new finding, no match)
  ─────────────► watched ──────────────────────────────────┐
                   │  Door 1 or Door 2 (Cadence B)          │ never recurs / low prior
                   ▼                                        ▼
               graduated ──► surfaced ──► accepted ──► live ──► (retired)
                                 │            ▲          │
                              rejected        │          │ divergence accumulates (§8)
                                 │            └──────── narrow/split/refine (re-proposed)
                                 ▼
                            suppressed (never re-surface)
```

`live` skills stay observed forever — every matching session feeds §8; graduation
is **not** terminal.

## 8. Modification = observed-behavior-vs-skill (not correction-after-invocation)

The modification signal is general: on **every** session, when a matched pattern
**already has a skill**, compare *what the user did* against *what the skill
says* — **invoked or not**:

- **invoked → user edited the result** → strong divergence.
- **not invoked, user did it manually** → divergence = skill stale / too-specific
  / a new variant.
- **matches the skill** → confirmation, leave it.

This is the same Cadence-A matching machinery (no separate invocation-watcher).
**Guardrail:** a *single* divergence never modifies — divergence can be a stale
skill, legitimate per-run variation, or a one-off. The judge acts only on
**accumulated divergence in the same direction** (§6 discipline).

## 9. Surfacing & review UX (reused shell)

Rail SUGGESTIONS section + `SkillReviewPopup`, summary-first, show-details.
Renders **typed** proposals (create/narrow/split/merge/retire) with evidence.
**No auto-apply, ever** — the user accepts/rejects/edits; nothing changes until
they do. Accept → `curator-writer` writes with the collision guard. Reject →
record `suppressedFingerprint`. Edit → the edit is the correct boundary for that
skill, fed to refinement (not a global taste model). **Known cosmetic fix:**
backfill struggle sub-fields into the evidence panel (the "0 min of work" bug).

## 10. Storage, retention, consent, privacy

- Distilled ledger persists indefinitely; **raw traces on a short rolling window,
  then dropped**.
- The feature **discloses that it observes sessions**. Devlog/telemetry stays
  dev-gated (never persists transcripts in the public build).
- **DEFAULT blessed (revisitable):** persist distilled patterns; short-window raw
  retention; disclosed observation. Revisit if privacy posture changes.

## 11. Cost

Full intelligence; cost is **not a v1 constraint**. Safe because curator cost
scales with *number of sessions* (distill once each) + a *periodic* judgment
pass — **not per user action** → single-digit-% overhead, never a 2-3× multiplier
on the user's own usage. Every intelligent stage is a Claude Code session on the
user's subscription (no API key). *Watch* only that passes stay periodic.

## 12. Reuse map (what changes vs stays)

- **Stays:** `curator-store` (schema-extended for the ledger), `curator-writer` +
  collision guard + slug guard, rail sections, `SkillReviewPopup`, scheduler
  (Cadence-B trigger), distill stage (feeds Cadence A), dev-gated logging.
- **Replaced / added:** accumulator → **durable Pattern Ledger**; struggle-emit
  selection → **two-cadence LLM judgment** (matching, two-door graduation);
  **gardening verbs** + typed proposals; **divergence-driven modification** (§8);
  suppression store.

## 13. Validated during build (not a pre-gate)

- **D2 — matching/comparison quality:** watch fusion of same-pattern-different-
  wording early; add the retrieval pre-filter when the ledger grows. Normal
  build-time validation; does not block planning.

## 14. Non-goals / trust model

Never auto-invoke (`disable-model-invocation`); user reviews everything; **not
Jarvis**; skills are **personal, not shareable-by-design**; skills are always
independent (composition-only); no cross-skill facts store; memory (declarative,
mem0-class) is **secondary** and largely already met by CLAUDE.md — skills are
the **procedural** layer, the open gap this feature fills.

---

## 15. Next step (when the user says go)

Write the implementation plan (superpowers:writing-plans) against this spec,
staged: **(1)** Pattern Ledger + storage/retention → **(2)** Cadence-A ingestion
& matching → **(3)** Cadence-B two-door graduation + drafting → **(4)** gardening
verbs + §8 modification → **(5)** typed-proposal review UX + suppression →
**(6)** finish V2 loose ends (click-test accept/reject/edit, live sweep, evidence
backfill). No code until then.
