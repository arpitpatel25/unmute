# Skill Curator — scoping discussion

> Status: **DISCUSSION, not a plan.** Nothing decided yet. This doc reaches a
> *recommended* conclusion for you to react to (by voice or edit), then we cut
> an implementation plan from it. Branch: `arpit/skill-curator`. Worktree:
> `unmute-skill-curator`.

## 1. What you asked for

> "Use intelligence to monitor user activity and help **create, update, and
> delete Claude Code skills** (`.md` files)."

An agent that watches how you actually work in Claude Code and keeps your
**own** skill library (`~/.claude/skills/*` and project `.claude/skills/*`)
alive — writing new skills when it sees a repeated method, updating skills that
have drifted, and retiring skills that are stale, unused, or wrong.

## 2. The one fact that reframes everything

We already have a librarian. `desktop/electron/remote/` contains a full,
shipping memory system:

- `librarian.ts` — the single serialized writer that curates a skill library.
- `recipe-store.ts` — confidence-graduated store (nursery `recipes/` → graduated
  `skills/`), promote/demote = file move, freshness, frontmatter counters.
- `trace-reducer.ts` — locates the executor's `~/.claude/projects/**/*.jsonl`
  and distills what actually happened into a compact action trace.
- `skill-usage.ts` — counts real `Skill` tool_use invocations from transcripts.
- `gardening.ts` — deterministic prune/dedupe/stale-flag/LRU-evict.

**But that librarian curates Unmute's *own* recipe library** — proven methods
for *voice-remote task-types* — and it lives under `~/.unmute/remote/`. It has
one hard, load-bearing rule, stated verbatim in `skill-usage.ts`:

> "Ownership boundary (hard rule): **we NEVER write into `~/.claude/skills`** —
> the user's own files are their territory. All usage stats live in an
> Unmute-owned sidecar ledger."

So today Unmute *reads* your `~/.claude/skills` (for usage stats) but treats
them as sovereign and never touches them.

**Your new ask deliberately crosses that boundary.** The Skill Curator's entire
job is to write into the territory the existing librarian is forbidden from
touching. That is the defining tension of this feature, and every design choice
below flows from how carefully we cross it.

## 3. Two things are NOT the same — name them apart

| | Existing "librarian" | New "Skill Curator" |
|---|---|---|
| Curates | Unmute's voice-remote recipes | **Your** Claude Code skills |
| Writes to | `~/.unmute/remote/{recipes,skills}` | `~/.claude/skills`, project `.claude/skills` |
| Triggered by | end of a voice-remote task | your general Claude Code activity |
| Sovereignty | Unmute-owned files | **user-owned files — sacred** |
| Failure blast radius | a bad voice recipe | a bad/edited/deleted file *you* rely on |

They share machinery (trace reduction, confidence, frontmatter, gardening) but
must stay **separate systems with separate write paths.** Reusing the code is
right; merging the two libraries is wrong.

## 4. Proposed name & shape

**Name: `skill-curator`** (module + feature). Rationale: the existing metaphors
are "librarian" (writes the book) and "gardening" (prunes the garden); "curator"
is the honest word for CRUD-over-a-collection-you-don't-own — a curator
*proposes* what enters/leaves a collection and answers to an owner. Alternatives
considered: `skill-steward` (good, softer), `skill-smith` (only captures
create), `skill-gardener` (collides with `gardening.ts`). Recommend
**skill-curator**; `skill-steward` is the fallback if you want the humbler tone.

Home for its own state (sidecar, never in your skills dir):
`~/.unmute/skill-curator/` — proposals, an activity index, and an audit log.

## 5. The core design question: how far does it reach into your files?

This is the real decision. Three postures, increasingly bold:

**Posture A — Advisor (read + propose only).** Never writes `.claude/skills`.
Emits proposals ("I'd add a skill `pdf-merge` — draft attached"; "skill `deploy`
looks stale, 3 sessions contradicted it"; "`old-linter` unused 60 days —
retire?"). You apply with one keystroke / voice "yes". **Zero risk, full
reversibility, honors the existing sovereignty rule** — the curator still never
writes your territory; *you* do, on its advice.

**Posture B — Curator with a git-backed safety net.** Writes directly, but only
inside a dir it initializes as a git repo (or a shadow branch), so every
create/update/delete is a commit you can `revert`. Deletes are `git rm`
(recoverable), never `rm`. A "propose vs auto-apply" switch per operation type
(e.g. auto-create, propose-update, always-confirm-delete).

**Posture C — Autonomous gardener.** Watches continuously and edits silently
with periodic digests. Maximum leverage, but it's editing files you didn't ask
it to touch, in your sovereign directory. High trust required; easy to erode it
with one bad edit.

**Recommendation: build A first, ship it, earn trust, then graduate to B behind
a switch — exactly the pattern the memory system already uses** (`librarian`
shipped read-only behind `LIBRARIAN_WRITE_ENABLED`, "earns the pen last"). Never
default to C. Delete is *always* confirm-first and *always* recoverable
(`git rm` or move-to-trash), per the Unmute contract's irreversible-action rule.

## 6. "Monitor user activity" — what's the actual signal?

We do **not** need a keylogger or a background daemon. The signal already exists
on disk: Claude Code writes a JSONL transcript per session under
`~/.claude/projects/**/*.jsonl`, and `trace-reducer.ts` already knows how to
find and distill these. So "monitoring" =

1. **Index sessions** — periodically scan the transcript dir (the curator runs
   lazily/on-demand, not as a hot daemon — same posture as the librarian).
2. **Detect repetition** — the same multi-step method appearing across N
   sessions with no skill covering it → *candidate to create*.
3. **Detect drift** — an existing skill whose steps the transcripts keep
   deviating from / correcting → *candidate to update*.
4. **Detect death** — a skill unused for a long window, or one whose invocations
   keep getting contradicted → *candidate to delete*. (`skill-usage.ts` already
   counts invocations; reuse it.)

Reduced traces feed a curator LLM session (an interactive `claude`, same billing
model as the librarian — no `-p`, no API key) that proposes the CRUD op with a
drafted `.md`. Determinism does triage (usage counts, staleness, dedupe);
intelligence does authoring and judgment. Same division of labor as today.

## 7. Reuse map (what we lift vs build)

**Reuse:** `trace-reducer.ts` (session → action trace), `skill-usage.ts`
(invocation counts + ownership sidecar pattern), the confidence/frontmatter and
gardening ideas from `recipe-store.ts`/`gardening.ts`, the serialized-single-
writer + write-gate + fire-and-forget patterns from `librarian.ts`.

**Build new:** `skill-curator.ts` (orchestrator: index → detect → propose →
[apply]), an activity/candidate index, a proposals store + review surface, and a
git-safety wrapper for Posture B. Detection heuristics for repetition/drift/death.

**Explicitly do NOT:** write into the existing `~/.unmute/remote` library, merge
the two libraries, or run continuously as a hot daemon.

## 8. Open questions for you (the real decisions)

1. **Posture** — start at Advisor (A) and graduate to B, as recommended? Or do
   you want direct-write (B) from day one behind a switch?
2. **Scope of "your skills"** — global `~/.claude/skills` only, or also
   per-project `.claude/skills`? (Per-project is higher-value but noisier.)
3. **Where do proposals surface?** — Unmute desktop UI (a "Skill Curator"
   review panel), a voice digest ("3 skill suggestions — want to hear them?"),
   a CLI/file digest, or all three?
4. **Trigger cadence** — on-demand ("curate my skills" by voice), after each
   voice-remote task, or a periodic sweep (e.g. daily idle)?
5. **Delete policy** — confirm-each vs. auto-retire-to-trash-with-digest.
   (Recommend confirm-each; deletes are the scariest op.)

## 9. Recommended conclusion (my vote)

- Name it **skill-curator**, a **separate** system from the existing librarian,
  sharing machinery but with its own git-safe write path and its own
  `~/.unmute/skill-curator/` state.
- Ship **Posture A (Advisor)** first — reads transcripts, proposes create/
  update/delete with drafted `.md`s, applies nothing until you say so —
  respecting the existing "never write your territory" rule until it's earned.
- Signal = the JSONL transcripts we already parse; detection = repetition /
  drift / death; authoring = an interactive curator `claude` session.
- Graduate to **Posture B (git-backed direct write)** behind a
  `SKILL_CURATOR_WRITE_ENABLED` switch once calibrated. Deletes stay
  confirm-first and always recoverable, forever.

If you're happy with this, the next step is a proper implementation plan
(`superpowers:writing-plans`) cut from §7 + §9. Tell me which of the §8
questions you want to settle first.
