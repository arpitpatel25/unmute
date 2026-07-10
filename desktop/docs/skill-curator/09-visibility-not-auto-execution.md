# Correction: surface for VISIBILITY, the user selects — do not auto-execute skills

Refines `08` Critique 2. Kailik pushed back on my "high confidence → auto-attach
and just use it" tier, and he's right. My take.

## He's right — and it's our own doc-05 boundary

Skills are **specific, discretionary features**; the user may deliberately not
want a given one to fire. Us auto-selecting which skill to invoke is the
**routine** control model (Unmute decides + drives) — and `05` already ruled that
routines and skills have **opposite** control models: skills are user-owned,
user-decided. My "auto-attach when confident" tier quietly imported the routine
posture into the skills world. **Retracted.** For skills, Unmute surfaces; the
**user selects**. We do not execute a skill on the user's behalf.

## Why the video-editor analogy nails it

A skill is a discretionary tool, like "background blur" or "trim" in an editor.
**Which tool fits is context + preference the user holds — not something we should
infer and apply.** Auto-invoking would be the editor deciding to blur your
background because the clip "looked blurrable." Presence/visibility **empowers**;
auto-selection **presumes**. The user won't use every workflow in every project,
but they want them **visible** so they know what exists. So **visibility is the
correct primitive**, not auto-execution.

## The one thing I keep — reframed (and it's small)

My real worry in `08` wasn't "the user shouldn't choose" — it was **friction**. So
the distinction isn't chooser-vs-no-chooser; it's:

- **Optional palette (good):** the relevant skills are *visible and available*;
  the user reaches for one when they want. The task can still proceed on pure
  speech. Nothing blocks. This is exactly the editor's effects panel — always
  there, never stops you from starting.
- **Mandatory gate (bad):** the task can't proceed until the user picks. *This*
  reintroduces the friction the motto forbids.

An always-visible, ignore-if-you-want palette satisfies **both** goals at once:
his visibility (the user always knows what exists and chooses) **and**
zero-friction (a choice is offered, never required). The confidence tiers from
`08` collapse to: **how prominently to surface** (a strong match floats to the
top of the palette), never **whether to auto-run** (never).

## Net effect on v1

The v1 primitive is **intent→skill retrieval for DISPLAY** — surface the relevant
skills so the user knows they exist and can pick — plus the explicit "use my X
skill" resolution when the user names one. **No auto-execution.** Lower-risk and
cleaner than the auto-attach idea: we never wrongly fire a skill, because we never
fire one — the user always pulls the trigger. Retrieval quality now only affects
*ranking within a visible palette*, not *what silently runs*, which is a much more
forgiving bar.
