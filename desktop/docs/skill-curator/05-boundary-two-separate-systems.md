# Boundary decision: the skills agent is SEPARATE from routines/librarian

**Decision: AGREED.** The new skills agent (skill-curator) is a distinct system
from the existing routine/graduation/librarian machinery. They may share
low-level plumbing; they are not the same product and must not be merged.

## Why they're separate on every axis (not two flavors of one thing)

| Axis | Routines (existing) | Skills agent (new) |
|---|---|---|
| **What it captures** | how the agent *operates a specific product/tool* — exploration-derived | a *general method/standard* for any kind of work, tool-agnostic |
| **Origin** | Unmute discovers it while doing a voice-remote task | observed from the user's own Claude Code sessions |
| **Owner** | Unmute-authored | user-owned |
| **Control** | **automatic** — the librarian promotes/demotes; user has ~no say (can only delete) | **human commit gate** — user accepts/rejects every create/update/delete |
| **Trigger** | end of a voice-remote task | ambient monitoring of general CC activity |
| **Storage** | `~/.unmute/remote/{recipes,skills}` (Unmute territory) | the user's `~/.claude/skills` + project `.claude/skills` (user territory) |
| **Format** | Unmute's confidence-graduated recipe frontmatter | the `SKILL.md` open standard |

Different on substance, origin, ownership, control model, trigger, storage, AND
file format. That is not one system with two modes — it's two systems.

## The clincher: the old system's own code forbids the new system's territory

`skill-usage.ts` states the boundary verbatim: *"we NEVER write into
`~/.claude/skills` — the user's own files are their territory."* The existing
routine/librarian system is **structurally forbidden** from touching exactly the
place the skills agent is built to operate. You cannot get a cleaner proof that
they're separate: the old system draws the line; the new system's entire job is
to cross it — carefully, with user consent, which is why it needs a different
control model in the first place.

## Watch the word collision (important)

Both systems produce things called "skills," but they are **different objects**:
- Existing "graduated skill" = an Unmute-owned voice-remote *recipe* that got
  promoted, still living under `~/.unmute`, still auto-managed by the librarian.
- New "skill" = a user-owned `SKILL.md` under `~/.claude/skills` that the user
  controls and that every agent they run (Claude Code, Codex, Cursor…) reads.

Same word, different thing. This collision is a real source of future confusion
and is itself a reason to keep the systems — and probably the naming — distinct.
(The routine system's "graduation to a skill" is an *internal* Unmute promotion;
it is NOT the same event as the skills agent proposing a user `SKILL.md`.)

## Where they legitimately touch (reuse ≠ merge)

Sharing *plumbing* is fine and smart; sharing the *system* is not. Reusable
low-level pieces:
- transcript location + reduction (`trace-reducer.ts`),
- the deterministic-count + LLM-judgment split (as in `skill-usage.ts` /
  librarian),
- the single-writer / proposal-before-write patterns.

Using those libraries in both places does not make them one product. The control
model, the ownership, and the storage stay opposite.

## Why the separation is load-bearing (not just neat)

If you merge them, you inherit the routine system's **automatic, low-user-control**
model — and apply it to the user's sovereign files. That's the exact posture the
skills agent is designed to reject (human accept/reject on everything). Merging
would quietly import the wrong control model into the wrong territory. So the
separation isn't housekeeping; it's what preserves the new product's core
promise.

## One forward note (not now)

Separate does not mean they can never *interact* later — e.g. a proven routine
might someday inform a suggested user skill. But interaction is an integration
between two systems, not a merger. Keep them separate now; revisit interaction
only after the skills agent stands on its own.
