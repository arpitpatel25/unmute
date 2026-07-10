# Intent-driven skill surfacing (speak the task → surface matching skills)

Kailik's refinement of the awareness surface: don't make it repo/workspace-based
(that needs structural setup — per-directory skill grouping, and the user having
selected/warmed-up the right workspace = friction). Instead: the user just
unmutes and **speaks the task**; an intelligence reads that utterance, matches it
against the user's existing skills, and surfaces "these fit." No setup, no
workspace selection. **Motto: make creating/unblocking a new task frictionless —
any friction in task creation kills it.** Grouping still happens, but invisibly
in the backend, learned from which tasks each skill was successfully used in.

My take — with the critiques he asked for.

## Where he's right (and it's the strategic core)

- **The motto is the correct north star.** Unmute's whole reason to exist is
  frictionless task initiation by voice. So ANY skill feature that demands setup
  (select workspace, pre-group, warm up) fights the product's core value. This
  correctly kills repo-selection as a *required step*.
- **Intent-driven surfacing rides the utterance the user already makes.** They're
  speaking a task anyway; piggybacking on that spoken intent costs the user zero
  new actions. That's the right primitive — it's the only trigger that adds no
  friction.
- **Invisible backend grouping, never user-organized.** Correct. Learning grouping
  from success signals (the usage ledger + outcome) rather than asking the user
  to file skills into folders is the right instinct.

So yes — **intent-driven is the better PRIMARY mechanism than repo-based.**

## Critique 1 — it's not repo-vs-intent; repo is a FREE prior, not a rival

He framed it as a choice: intent *instead of* repo. I'd push on the binary. The
repo/workspace context should not be something we *ask for* or make the user set
up — agreed — but it is **available for free at the moment they speak**, because
Unmute knows the session's cwd / the router binds a session to a repo (seen in
`init.ts`). So repo isn't a competing setup-heavy approach; it's a **second input
we get for nothing** that sharpens the intent match ("deploy" means different
skills in repo A vs repo B). Design: **intent is the trigger (always present);
repo is a disambiguating prior WHEN it's known (no setup, no warm-up).** Reject
repo-as-a-required-step (he's right); don't reject repo-as-a-free-signal (that
leaves accuracy on the table). When the repo isn't known yet, intent alone still
works — so nothing is gated on it.

## Critique 2 — the surface must not become a CHOOSER, or it betrays the motto

This is the important one. "Surface 3 relevant skills and let the user pick"
quietly **re-introduces the exact friction the motto forbids** — now the user has
to look, read, and choose before proceeding. An awareness surface designed as a
picker contradicts the whole point. So the motto must discipline the surface into
a **confidence-tiered, never-blocking** shape:

- **High confidence** → just use it. Auto-attach the skill and *tell* the user
  ("using your `pr-review` skill"), don't ask. Zero friction, full value.
- **Medium** → show it as a **glanceable, ignorable** hint; the task proceeds
  without waiting. The user can tap to add, but nothing blocks on them.
- **Low** → say nothing. Silence beats noise.

The task must never stall on "choose a skill first." The surface is an ambient
assist, not a gate.

## Critique 3 — grouping-by-success is a great reranker, but has a cold-start

Learning grouping from "tasks where the skill was successfully used" is a strong
signal — but a **brand-new skill has no success history**, so it can't be
retrieved by that signal yet, and new skills are exactly what the create co-pilot
keeps minting. So retrieval needs two layers:

- **Semantic match** on the skill's own description/content — works on day one,
  no history required. This is the floor.
- **Success-history reranking** — once a skill accrues "used successfully in
  tasks like this" evidence, it ranks higher. This is the improvement over time.

His grouping idea is the reranker; it must sit on top of a history-free semantic
retrieval floor, or new skills are invisible until they somehow get used (which
they can't, if they're invisible — a deadlock).

## The unification worth seeing: (a) and (b) are ONE primitive

From `07`, the two invocation-assist ideas — (a) "use my X skill" → resolve to the
exact `/slug`, and (b) auto-surface skills relevant to the spoken task — are **the
same capability in two modes**: *real-time intent → skill matching on the
utterance.* (a) is the explicit case (the user named a skill, fuzzily); (b) is the
implicit case (the user named only the task). Same retrieval engine, different
entry. So **v1 is a single primitive — intent→skill retrieval on the spoken
task — not two features.** That tightens the earlier claim that invocation-assist
is the v1 wedge: it's one tractable capability, low-friction by construction,
delivering value on the skills the user already has.

## Take in one line

Intent-driven surfacing is the right primary mechanism and the zero-friction
motto is the correct discipline — but (1) use repo as a *free* prior, not a rival
requiring setup; (2) keep the surface confidence-tiered and never a chooser, or it
betrays the motto; (3) retrieval = semantic floor + success-history reranking to
survive new-skill cold-start; and (4) this and "use my X skill" are one
intent→skill retrieval primitive, which is the real v1.
