# Skill Curator — Nuance Inventory & Readiness Map

> The bridge from philosophy → implementation. It enumerates **every aspect** of
> the curator, and for each records: what is **DECIDED**, what is **BUILT**, what
> is **OPEN**, and the **focus points** we must not lose. Companion to
> `2026-07-20-skill-curator-philosophy.md` (the *why*) and
> `2026-07-17-skill-curator-design.md` (the current *mechanism*, now partly
> superseded by the philosophy evolution).
>
> Legend per item: **[DECIDED]** settled intent · **[BUILT]** exists in code
> today · **[OPEN]** unresolved design · **[GAP]** philosophy says X but the
> current build does Y.

---

## 0. Readiness verdict (honest)

- **Philosophy / direction:** high clarity. The vision, the selection principle,
  the unit, the lifecycle, the trust model — settled.
- **Implementation of the *current* build (V2):** exists and partly proven — the
  pipeline runs, the rail + popup render. It implements an *earlier, simpler*
  theory (struggle-driven, emit-per-sweep).
- **Implementation of the *evolved* vision:** **not ready.** The pieces the last
  few discussions added — the durable cross-session record, graduation on a
  repeatable *portion*, two-door promotion, gardening as a peer of creation,
  modification signals+timing, the taste-learning loop, the invocation-feedback
  keep-alive — are largely **unbuilt or GAP**.

**Conclusion:** we should **close the OPEN threads below (the durable record
first — everything hinges on it), then re-plan**, rather than build now. A
scoped first increment is possible (see §15) but the full vision needs the
substrate designed first.

---

## 1. Observation / ingestion

- **[BUILT]** Scheduler observes sessions; reduce/trace step condenses a session
  transcript; distill runs per session (as a Claude Code session).
- **[DECIDED]** Scope = **persistent long-term sessions only**; *all* session
  types, *all* tools/domains (professional, side projects, personal, hobbies).
- **[DECIDED]** Every intelligent stage is a Claude Code session on the user's
  subscription (no API key, no managed API). Devlog gated.
- **[GAP]** §6 says **a skill invocation is itself an observation** (skill run →
  did the user then correct it?). Ingestion today does **not** capture skill
  invocations or the user's post-invocation edits. **Focus:** wire invocation +
  subsequent-correction capture.
- **[OPEN]** What exactly counts as an "observation unit" fed to the durable
  record — a whole session? a task within it? a sub-pattern? (ties to §3.)

## 2. Triage / struggle detection

- **[BUILT]** Deterministic struggle metrics (failed / backtracked / corrected).
- **[DECIDED]** Struggle = evidence of a **capability gap** (a within-session
  signal).
- **[GAP]** Philosophy: struggle is **necessary but not sufficient** and is even
  *biased toward one-offs* (high-struggle rare events) and *blind to frequent
  low-struggle tasks*. Current selection over-indexes on it. **Focus:** struggle
  becomes *one input* to promotion, not the gate.

## 3. The durable cross-session record — THE substrate (philosophy §8) · CRITICAL PATH

- **[GAP/OPEN]** Today the accumulator carries candidates **within a sweep** and
  resets. There is **no** "seen this 3× across 3 weeks" memory. Everything
  downstream (prior, graduation, gardening, taste) rests on this. **Nothing to
  build downstream until this is designed.**
- **[OPEN] What one entry contains (draft list to finalize):**
  - a **sub-pattern signature** (not the whole task — the repeatable core)
  - **occurrence count** + first-seen / last-seen timestamps
  - **inter-instance similarity** and **variance map** (what's constant vs what
    varies per run — feeds hardcode-vs-slot and narrow/re-fit)
  - **struggle evidence** aggregated across instances
  - **prior score** (LLM judgment: "glad even if never recurs?")
  - **status**: watched → graduated → surfaced → accepted / rejected / retired
  - **links** to any skill(s) it produced or belongs to
- **[OPEN] Matching:** how a new observation is matched/merged into an existing
  sub-pattern vs. spawns a new one (anti-unification / similarity threshold).
- **[OPEN] Thresholds:** what moves an entry watched → graduated.

## 4. Selection / promotion — the two doors (philosophy §2)

- **[DECIDED]** Selector = **expected future value**, not frequency. Two doors:
  - **Door 1 — strong prior:** "if this never recurs, would a human still be
    glad the skill exists?" → surface directly (e.g. tax filing).
  - **Door 2 — observed recurrence** of a repeatable portion → graduate.
- **[GAP]** Current build has neither door explicitly; it emits from a single
  sweep on struggle. **Focus:** implement the prior (LLM) + the recurrence path.
- **[OPEN]** Prior computation + calibration; the **confidence threshold** for
  direct-surface; the **significance-and-repeatability bar** for graduation.

## 5. Distillation / skill drafting — creation (philosophy §9)

- **[BUILT]** Per-session distill drafts candidate skills; parsers stable.
- **[DECIDED]** Task-noun naming; self-contained; group-by-domain; three tests
  (GAP / TASK / REUSE); **disciplines excluded**; **app-navigation excluded**;
  **FEW is the goal.**
- **[DECIDED]** Skill contents = body + **baked-in specifics** + per-run-varying
  values as **slots** + caveats/gotchas + accreting learnings.
- **[DECIDED]** **Hardcode vs slot test = "does this value change run-to-run?"**
  Stable-for-user specifics are baked in (personal, not shared). Secrets live in
  env/keychain, referenced — never baked.
- **[OPEN]** How distill draws the hardcode/slot line from a **single** instance
  (one-shot boundary guess) vs. defers boundary-fitting to repetition.

## 6. Synthesis / judging — cross-sweep (philosophy §2, §5)

- **[BUILT]** Judge candidates; dedup; group; gets existing skills for collision.
- **[DECIDED]** FEW is the goal; convergent with an independent human read.
- **[GAP]** Synthesize gets existing skills for **collision only** — not their
  **occurrence/variance data**, and it can only **create**, not reshape.
  **Focus:** feed occurrence/variance in; add the gardening verbs (§7).

## 7. Gardening — prune / merge / re-fit / narrow / retire (philosophy §5) · peer of creation

- **[DECIDED]** Must be **as strong as creation, arguably stronger** — creation
  makes mediocre choices; gardening fixes them and prevents sprawl-rot.
- **[GAP]** Current build has a **binary retire** notion only. The reshape verbs
  are unbuilt.
- **[OPEN] Signals + timing per verb** (the user's explicit "how long to wait /
  what signals"):
  - **narrow** ← a skill's parts show per-run variance across invocations; the
    user repeatedly edits the same section; a stable core + varying remainder
    emerges. *Timing:* after **N** invocations/observations show the same
    stable/variable split (N TBD).
  - **split** ← the user uses only part of a skill; two distinct sub-patterns
    live in one skill.
  - **merge** ← two skills co-occur or overlap heavily across sessions.
  - **retire** ← unused for **T** time / **K** sweeps (T,K TBD).
  - **refine / add-learning** ← skill invoked → user corrected the output → fold
    the correction in (immediate, atomic).
- **[OPEN]** All the **N / K / T thresholds** — none are set. These are the
  "how long do we wait for modification" numbers.

## 8. Modification signal = observed-behavior-vs-skill (resolved 2026-07-20)

- **[DECIDED]** The modification signal is **not** "detect a correction after
  invocation." That is only the loudest case. The general signal is: on **every
  session**, when a matched sub-pattern **already has a skill**, compare *what the
  user actually did* against *what the skill says* — **invoked or not.** Three
  outcomes: **invoked → user edited result** (strong divergence); **not invoked,
  user did it manually** (divergence = skill stale / too-specific / new variant);
  **matches the skill** (confirmation, leave it).
- **[DECIDED]** This **collapses old D7 into D2.** There is no separate
  invocation-watching subsystem — it is the same Cadence-A matching, just noting
  "matched pattern has a skill" and asking the LLM agree-or-diverge. Invocation
  is the highest-signal instance of the general compare.
- **[DECIDED — guardrail]** A **single** divergence never triggers modification.
  Divergence can mean (a) stale skill, (b) legitimate per-run variation, or (c) a
  one-off different approach. Modification is an LLM judgment over **accumulated
  divergence in the same direction** (same D8 discipline as graduation).
- **[CONSEQUENCE]** **D2 (matching/comparison quality) is now the single
  empirical unknown** on which both graduation *and* modification rest. Validate
  D2; D7 is no longer a separate risk.

## 9. Surfacing / review UX (philosophy §10)

- **[BUILT]** Rail SUGGESTIONS section + SkillReviewPopup; summary-first;
  show-details; accept / reject / edit buttons **render and open**.
- **[DECIDED]** **Intelligent, confidence-gated surfacing** — surface only when
  confident, by type. **No auto-apply, ever (for now)** — always present, user
  accepts/rejects, nothing changes until then.
- **[OPEN/UNTESTED]** accept / reject / edit **not click-tested end-to-end**.
- **[OPEN]** How **modification** proposals render vs **new-skill** proposals;
  the confidence threshold that governs direct-surface.
- **[KNOWN BUG]** Evidence panel "0 min of work" — synthesize doesn't populate
  struggle sub-fields; should backfill from the accumulator (cosmetic).

## 10. Writing / collision guard

- **[BUILT]** curator-writer writes to global `~/.claude/skills`; `isValidSkillName`
  slug guard (path-traversal + frontmatter-injection fixed); D10 collision guard
  touches **only ledger-owned** skills; `disable-model-invocation: true` on every
  curated skill; deterministic unified-LCS diff; compact ownership record.
- **[DECIDED]** Global destination; clean names + ownership record.

## 11. Taste-learning loop (philosophy §7) · what makes it "understand me"

- **[DECIDED]** The user's accept / reject / edit is the **training signal** that
  bends the promotion-prior and boundary-fitting toward *this user* over time.
  Without it the system is a static heuristic, identical day 1 and day 60.
- **[GAP]** `skill_feedback` **captures** decisions but they are **not fed back**
  into selection. **Focus:** close the loop — feedback → prior/boundary tuning.

## 12. Scheduling / cadence / cost

- **[BUILT/DECIDED]** Twice-daily (configurable) + catch-up-on-wake +
  material-gated; rate-limit backoff (proven correct: cursor untouched on limit).
- **[DECIDED]** Token overhead single-digit % (analyzed, accepted).

## 13. Scope guards & known tensions

- **[DECIDED]** Persistent long-term sessions only; disciplines excluded;
  app-navigation excluded; librarian **parked**; detailed profile **parked** —
  **skills are the whole product for now.**
- **[DECIDED]** Memory is **secondary** and **declarative** (mem0/supermemory
  class); the declarative need is already met by **CLAUDE.md + Claude Code
  memory**. Skills are the **procedural** layer = the open gap.
- **[OPEN TENSION]** Navigation-exclusion leaves **computer-use know-how
  homeless** (librarian parked). Accepted for now; revisit if it recurs.

## 14. Non-goals / trust model

- **[DECIDED]** Never auto-invoke (`disable-model-invocation`); user reviews
  everything; **not Jarvis**; skills are **personal, not shareable-by-design**;
  **skills are always independent** — the only cross-skill relation is
  **parent→child composition**; **no cross-skill facts store**.

---

## 15. Critical path to "ready to implement"

Ordered by dependency — each unlocks the next:

1. **Design the durable cross-session record (§3).** Everything rests on it.
   Close: entry contents, matching/merging, watched→graduated thresholds.
2. **Define the two-door promotion (§4)** on top of the record: the prior
   (LLM + calibration), the confidence threshold, the graduation bar.
3. **Define gardening signals + all N/K/T thresholds (§7)** and the invocation
   feedback loop (§8).
4. **Close the taste-learning loop (§11):** feedback → prior/boundary tuning.
5. **Re-plan the build** against 1–4 (the current V2 build is the create-only
   skeleton; these extend/replace its selection + accumulator layers).
6. **Finish V2 loose ends regardless:** click-test accept/reject/edit, live
   sweep once rate limit clears, fix the "0 min" backfill, test substitution-only
   dictation in a noisy setting.

**Smallest honest first increment** (if we want to ship *something* true to the
philosophy before all of the above): keep create-only, but (a) add the durable
record as a **watch list that suppresses first-sight one-offs** (door-2 skeleton),
(b) surface only door-1 strong-prior candidates, (c) leave gardening + taste loop
as fast-follows. This ships the "few, high-value, no one-offs" behavior without
the full graduation/gardening machinery. *(Superseded — see §17: we build the
full feature, not an increment.)*

---

## 16. Final decision resolutions (2026-07-20, later)

- **Taste-learning loop — dropped as a pillar.** Feedback volume is low and
  reject is ambiguous. Accept/reject/edit is kept only for **(1) suppression** of
  re-surfacing rejected proposals and **(2) per-skill boundary correction** from
  edits — not a global "taste" model.
- **Cost — not a v1 constraint.** Full intelligence; spend what it needs. Safe
  because curator cost scales with *sessions* + a *periodic* pass, not per user
  action → single-digit-% overhead, never a 2-3× multiplier. Only *watch* that
  passes stay periodic.
- **D2 (matching) — downgraded from gating spike → normal build-time
  validation.** It is a bounded **new-session-findings vs stored-findings**
  compare (not N×N session comparison), squarely in LLM competence. Residual
  risks: description **drift** (handled by LLM *semantic* compare, not cosine) and
  **scale** (retrieval pre-filter once the ledger grows). Watch fusion quality
  early; it does not block the architecture.
- **Surfacing aggressiveness — precision-first** (miss > annoy), configurable
  later.
- **Retention + consent — DEFAULT set, needs user's yes/no only:** distilled
  patterns persist; raw traces on a short rolling window then dropped; feature
  discloses it observes sessions. *(This is the one remaining item requiring the
  user's explicit blessing — a values/consent call, not engineering.)*

## 17. Scope: full feature, not an increment (2026-07-20)

Per the user's constraint — "production-ready, complete feature, not a prototype
or pilot" — we build the **full substrate**: durable ledger + two-cadence LLM
intelligence + two-door graduation + gardening (create/narrow/split/merge/retire)
+ modification via observed-behavior-vs-skill (§8). Build *order* may stage it
(ledger → matching → graduation → gardening) but scope is not cut.

**Net readiness:** architecture fully decided. **Nothing blocks planning** except
one yes/no from the user on the §16 retention/consent default. D2 is validated
during build, not before it.
