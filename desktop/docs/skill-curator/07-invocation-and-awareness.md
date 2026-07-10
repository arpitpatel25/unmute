# Invocation & awareness — the other half of the skills problem

Kailik's point: skills only help if they actually get **invoked**. Claude Code is
supposed to auto-invoke them, but often doesn't (skills are specific; the model
misses them). So users invoke manually — but only for the skills they *remember
exist*. Invocation is therefore governed by **presence + the user's awareness of
presence**. Is this genuine? Solvable? My take.

## 1. Yes — genuine, and it's the discovery problem resurfacing from the runtime side

This is the same thing I flagged earlier ("solving variance creates an access
problem — a big library becomes hard to find/invoke"), now seen from the
invocation angle. Kailik arrived at it independently, which is a good sign it's
real. But it's actually **two different failure modes** that need separating —
they have different fixes:

- **(1) Model under-invocation** — the agent doesn't auto-fire a skill it should.
  Causes: a weak/mismatched `description`, competition among many skills, the
  user's phrasing not matching the trigger text, or the skill being
  `disable-model-invocation`. Crucially, this is **structural, not just
  current-model weakness**: Anthropic budgets the skill *listing* at ~1% of the
  context window and **truncates descriptions as the library grows** (research
  doc `02`). So the more skills you have, the *worse* auto-invocation gets — a
  ceiling a smarter model cannot lift, because the descriptions literally fall
  out of context. This will not fully evaporate.
- **(2) User-awareness gap** — the user doesn't manually invoke because they
  don't remember/know the skill exists. A recall problem, worst for large or
  aging libraries.

(1) is why (2) matters: if auto-invocation were perfect, awareness wouldn't be
needed. Both compound as the library grows.

## 2. The reframe: invocation-assist is a BETTER first wedge than creation

This is the important strategic point. The create/update co-pilot depends on the
hard **inference-precision** problem (is this recurrence skill-worthy?).
Invocation-assist does **not** — it only has to match a *spoken intent* to an
*existing, already-named skill*, which is far easier and far lower-risk. And it
delivers value **on day one, with the skills the user already has** — no
monitoring, no library-growth waiting period, no precision bar to clear before
it's useful. Under-invocation of existing skills is a *today* problem; creation
is a *build-your-library* problem. So as an entry point, invocation-assist is
faster-value and lower-risk. Strong candidate to lead with.

## 3. Unmute's unique angle: it is the voice layer *in front of* the agent

Typing `/skill-name` demands exact recall — you must know the skill exists AND
its exact slug. **Speaking** intent is natural, and Unmute sits at a privileged
interception point: **between the user's spoken intent and Claude Code**, holding
the user's full skill library — unconstrained by the agent's 1%-listing budget.
So Unmute can do invocation matching **the base agent structurally cannot**:
resolve fuzzy spoken intent → the right skill, with the whole library in view.
The context ceiling that hobbles the agent's auto-invocation is not Unmute's
ceiling. That's a real, defensible edge, and it's specific to being the voice
remote.

## 4. Solution ladder (safest → boldest)

- **(a) Voice-native invocation resolution — the slam dunk.** User knows they want
  a skill but not the exact slug: they *say* "use my PR-review skill" and Unmute
  resolves natural language → the exact `/pr-review` invocation. Kills the
  "must know the exact name" friction entirely. Low risk (the user already
  decided), high value, uniquely voice-enabled. Build this first.
- **(b) Contextual awareness surface.** Make the user's skills *present* at the
  moment they act — "you have 2 skills relevant to this repo/task." The rail
  already exists (`remote:list-skills`); the upgrade is making it *contextual and
  timely* rather than a static list. Directly attacks the awareness gap.
- **(c) Description-tuning to fix auto-invocation at the root.** The co-pilot's
  *update* operation already rewrites skills — extend it to tune `description` /
  `when_to_use` so the model auto-fires correctly (this is exactly what
  Anthropic's skill-creator does). Ties invocation back to the maintenance
  product: a skill that never triggers is a maintenance defect, not just a
  missing feature.
- **(d) Proactive "this skill applies — use it?"** Unmute detects the spoken
  intent matches a skill the model didn't fire and surfaces it. Highest value but
  carries the **precision risk** again (wrong suggestion = annoyance). Rule:
  **surface/offer, never silently force** — don't override the model's judgment;
  propose and let the user confirm.

## 5. The structural must: invocation-awareness is REQUIRED alongside creation

Not an adjacent nice-to-have. If the co-pilot is busy *creating* skills, it is
manufacturing exactly the library the user then can't remember — so creation
**without** an invocation/awareness layer makes the problem *worse*: unfound
skills get re-authored cold → duplicates → worse discovery. So the co-pilot must
own invocation-awareness as a first-class counterpart to creation, or it is
net-negative. (Same "close the loop" principle as the outcome check in `04`.)

## 6. Honest caveats

- For **casual users with 2–3 skills**, awareness isn't hard — this problem is
  real specifically for the **power user with a growing library**, which is the
  target, and it *grows* precisely as the co-pilot succeeds.
- The bold end (d, auto-suggest) re-imports the precision problem; keep it to
  surface-don't-force until precision is earned (same posture as the Advisor
  ladder in `00`).
- (a) and (b) are buildable now and don't need the inference engine at all —
  which is why invocation-assist can ship ahead of, and independent of, the
  create/update co-pilot.

## Take in one line

Genuine problem, structurally permanent (the 1% listing ceiling), and the same
discovery gap seen at runtime — but it's the **lower-risk, faster-value wedge**:
voice-native invocation resolution + a contextual awareness surface deliver value
on day one with existing skills, are uniquely enabled by Unmute being the voice
layer in front of the agent, and are a *required* counterpart to the creation
co-pilot rather than a separate idea.
