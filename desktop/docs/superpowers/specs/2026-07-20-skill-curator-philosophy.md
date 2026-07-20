# Skill Curator — Product Philosophy

> A living philosophy doc, not a spec. It captures *why* the curator exists and
> the principles that should govern it, distilled from an extended design
> conversation. The implementation spec is
> `2026-07-17-skill-curator-design.md`; this doc is the reasoning that should
> outlive any particular implementation. When the two disagree, this doc states
> intent and the spec states mechanism — reconcile toward intent.

---

## 1. The vision: observability → natural automation

The curator is an **observability layer** over the user's Claude Code sessions
(Unmute-spawned or otherwise). Its job is to watch the work the user already
does — professional, side projects, personal, hobbies, *anything* — and quietly
figure out what can be turned into a reusable skill, so the user automates their
own work **as a byproduct of doing it**, not as a separate chore.

The frame that matters:

- The whole AI wave is moving toward automation, but "automate everything" is
  paralysing — you can't, and it's confusing to try. **Skills are the first
  real step toward automation that a normal person can actually take.**
- A skill is not full automation. It is **variance control**: you stop
  re-typing the same prompts and re-deriving the same path; the tool holds the
  approach so the result is consistent. One rung up the ladder, not the top.
- This has to happen **naturally**. The user should not be forced to author
  skills, and skills they don't author shouldn't rot for lack of attention. The
  user just keeps doing their work; skills get created, updated, refined, and
  retired around them. A month in, the job *feels* automated — meaning they
  write fewer prompts and the tool "understands them" — without anyone having
  sat down to build that.
- **We are not building Jarvis.** Skills are never auto-invoked. The user's
  accumulated work simply exists *as skills*, so invoking them is trivial. The
  intelligence is in the curation, not in taking the wheel.

This is the fundamental reason to build this: it lets people use their coding
agent for *everything* and have that use compound into leverage on its own.

---

## 2. Frequency is neither necessary nor sufficient

The naive selector is "capture what recurs." It is wrong in both directions.

- **Not sufficient:** many things recur *and shouldn't be skills* (they're
  generic, obvious, or too small — "read the transcript"). And a task can look
  end-to-end and complete and still be a **one-off** that never returns.
- **Not necessary:** filing taxes might happen once, with enormous struggle
  across one or several sessions before the right path is found. Frequency ≈ 1,
  yet it is *obviously* worth capturing.

So frequency is only one input to the real quantity, which is roughly:

> **Expected future value of having this as a skill**
> ≈ P(the user hits something like this again)
> × cost of re-deriving the path from scratch
> × how stable/reusable the path is.

Recurrence feeds the first term. Struggle feeds the second. Task type/stakes
feed all three. **The selector is a taste judgment about expected future value,
not a metric.**

### Two doors to promotion

There are two independent ways to *know* something will recur:

1. **Observe it repeat** — empirical, needs history.
2. **Infer it from the nature of the task** — a prior, from world knowledge.
   You don't need to watch someone file taxes twice to know taxes come back.

The tax skill walks through **door two** (strong prior) on first sighting. The
video on-screen-text patch has *neither* a strong prior nor observed recurrence,
so it should **wait** — logged as a watched candidate, not emitted. This is why
selection must be an LLM judgment, not a counter with a threshold: only world
knowledge can supply the prior.

### The single discriminating test for first-sightings

> **"If this literally never happens again, would a human still be glad this
> skill exists?"**

Tax: yes. A one-off video patch: shrug. That question is the whole first-sight
selector. Everything ambiguous that fails the prior falls back to door one and
waits for recurrence.

**Implication we must accept:** a good curator would likely have emitted
*nothing* from a single video-editing session on first sight — it would have
logged "possible gap: on-screen-text repair" and waited. A curator that
confidently emits a skill from one session has the same over-eager bug, just
with better taste about which one-off to emit.

---

## 3. Observation does three different jobs — don't blur them

Watching the same kind of task repeat does three *separable* things:

1. **Should it be a skill at all?** — answerable by prior *or* recurrence (tax
   proves prior alone can suffice).
2. **What are the skill's boundaries?** — this one **cannot** skip repetition.
   "The file / branch / ticket / task-id changes but the analysis is constant"
   is literally anti-unification: you can only see what's invariant by diffing
   multiple instances. **The ~80% that's constant across instances = the skill
   body; the ~20% that varies = the parameters/slots.**
3. **Should it be reshaped or retired?** — ongoing occurrence/variance tracking;
   also inherently multi-observation.

So a skill can be *born* over-fit from one session (specifics baked in) and only
*refined* into a clean, reusable shape once the pattern is seen again. **Birth
and boundary-fitting are different events on different timescales.** A design
that collapses them into one emission will over-fit.

Nuance: an LLM *can* hypothesise the slots from a single instance (it knows an
SSN is specific and "download the 1040" is generic). That one-shot guess is a
useful **prior on the boundary** — better than raw over-fit — but repetition is
what *confirms or corrects* it. Keep repetition as the corrector; don't discard
it just because one-shot guessing is possible.

---

## 4. Composition: skills wrap other skills

Skills are a **graph, not a set of leaves.** A user can download a generic skill
(e.g. an off-the-shelf tax skill), layer their own specifics and steps on top,
and the *whole* — "how *I* do *my* taxes, using that generic skill as a
subroutine" — is the real skill worth capturing.

This changes what the curator hunts for. One detection target is "a novel
recurring task." A *different* target is **a recurring personalization around an
existing capability**: "you keep invoking skill-X and then doing the same three
wrap-around steps every time" → propose the wrapper. We do nothing with this
today; it matters.

It also settles the "what even is a skill" worry. **We don't compete with
skills.md / Anthropic skills — we sit above them.** Theirs are authored,
generic, shareable products. Ours are personal, observed, variance-controlling
routines. Composition is the bridge: the generic skill is the reusable
subroutine; *the user's personal wrapper is what our curator captures.*

---

## 5. Gardening is a first-class peer of creation (arguably more)

"Keeps improving by itself" has a failure mode baked in: **accretion without
gardening.** If skills are created/updated automatically and the user just keeps
working, then in two months there are 40 skills, a third stale, several
over-fit, two that should be merged — and the value *inverts*, because neither
the user nor their agent can hold the set in their head.

Creation makes mistakes and mediocre choices; that's tolerable *only because*
the pruning / merging / re-fitting loop can fix or break them and make the whole
set better over time. **The gardening loop must be as strong as creation, if not
stronger.** Most systems build creation and bolt on a weak binary retire step.
For this to work, prune / merge / re-fit / narrow must be first-class
operations, not afterthoughts.

Concretely, the curator needs at least these verbs, not just "create":
- **narrow** — an over-fit skill down to the stable core (the 80%).
- **split** — one skill that's really two.
- **merge** — two skills that are really one.
- **re-fit** — move a boundary as variance data accumulates.
- **retire** — kill the unused/dead.

---

## 6. Skills stay alive — graduation is not terminal

A skill reaching "good" is not the end state. It keeps changing. Because this is
an observability system, **every invocation of a skill is itself an
observation** of that skill:

- Skill invoked, user accepted the result as-is → the skill did its job.
- Skill invoked, **user then had to change something** → the skill
  underperformed. That correction is a signal: does the skill need refining? Did
  it do something the user disliked? Should part of it split off into a new
  skill?

This is the loop that keeps skills from stagnating, and it's the same substrate
as boundary-fitting: user corrections after invocation are labelled variance.

---

## 7. The taste-learning loop — what makes it "understand me"

The reason the system would *feel* like it gets you a month in is **not** that
it observed more tasks. It's that **your accept / reject / edit decisions taught
it your personal answer** to "would a human still be glad this exists?" and where
*your* skill boundaries sit.

- You reject the video patch → your bar for that class went up.
- You accept the tax skill → prior confirmed.
- You edit an over-fit skill down to its 80% → you taught the boundary.

If those decisions feed back into the promotion-prior and the boundary-fitter,
day-60 selection is calibrated to you and day-1 wasn't — *that* is the
"understands me" feeling, concretely. If they don't feed back, the system is a
static heuristic, identical on day 1 and day 60, and never feels personal no
matter how much it observes. **Capturing accept/reject (we do) and *learning*
from it (we don't yet) are different things; the second is what makes the vision
land.**

---

## 8. The durable unit

Everything above — the prior, anti-unification, the taste loop, gardening,
the stay-alive loop — needs a **durable per-candidate record that survives
across sweeps and months**, not one reset each sweep. Today the accumulator
carries candidates *within* a sweep and then the sweep ends; there is no "I've
seen this gap three times across three weeks" memory. That memory is the
substrate the whole philosophy stands on, and its shape determines what's even
possible. (Open thread — to be worked out: exactly what lives in that record.)

---

## 9. The skill is the unit — resolved (2026-07-20)

"Skill" is a loaded word, and some useful things we observe aren't skills in the
Anthropic/skills.md sense. But the resolution is **not** to proliferate artifact
categories. The skill is *the* unit, and it is self-contained.

**Why memory is secondary — the structural reason.** Productised memory
(mem0, supermemory, Zep/Graphiti) is a *declarative* layer: an LLM extracts
facts/preferences/entities and retrieves them at query time. It makes an agent
**consistent about what it knows**; it does **nothing** to make it **do a task
the same way twice**. Skills are the *procedural* layer. Declarative vs
procedural is the whole distinction — memory and skills aren't competitors, they
are different axes, and only the procedural one drives automation. Moreover the
declarative need is *already covered* for a heavy Claude Code user by **CLAUDE.md
+ Claude Code's own memory**. So the open ecosystem gap is the procedural layer =
skills. Skills-first isn't just a preference; it fills the actually-open hole.
A preferences/details memory may still exist, but it is not this project's focus.

**The skill is self-contained.** It holds: the body (approach) + baked-in
specifics + the small subset of per-run-varying values as slots + caveats/gotchas
+ learnings that accrete over time via the invocation-feedback loop (§6).

- **Hardcode vs slot — the only test is "does this value change from run to
  run?"** Stable-for-this-user specifics (your Gmail account IDs, your doc
  target) are just *baked into the body* — a generic skill with those stripped
  out is *worse*, not cleaner, because these skills are personal, not shared.
  Only values that vary per run (ticket id, branch, file, task id) become slots.
  This sharpens §3: the "~20% that varies" means *varies per run*, not merely
  "is specific."
- **No cross-skill facts store. Skills are always independent.** Duplicating a
  fact into two skills is cheap; a shared store buys coupling and "which skill
  owns this fact" complexity we don't want. If a duplicated fact goes stale, the
  **modify loop heals it** through normal observation — no shared state needed.
  The *only* legitimate cross-skill relationship is **parent→child composition**
  (§4): a skill that sequentially calls a few others, each still independent.
- **Secrets are not baked into skills** (distinct from the above): API
  keys/credentials live in env/keychain; the skill references them.

## 10. Surfacing & the graduation lifecycle — resolved (2026-07-20)

Surfacing and creation are **intelligent, never automatic.** A candidate takes
one of two paths:

- **Generic-enough / strong prior** — intelligence judges "likely reused in
  future" → **surface directly** for accept/reject (door one, §2).
- **Specific / possibly one-time / not even tool-specific** — do **not** ignore,
  do **not** surface yet → **observe and track.**

The key detection move: **do not wait for the whole task to recur — watch for the
repeatable *portion*.** Even if the full action never returns, a significant,
similar, repeatable *sub-pattern* inside it may. When that sub-pattern crosses a
significance-and-repeatability bar → **graduate that portion into a skill** →
surface it → **keep tracking after graduation** (invocations + user corrections
feed §6). This pushes the boundary-fitting idea (§3) *upstream* into detection:
the tracked unit is not "the task" but **the sub-patterns within tasks**;
graduation fires on a repeatable *core*, not a repeated *whole*.

**No auto-apply, ever (for now).** Modifications and new skills are always
presented for the user to accept or reject; until then nothing changes. The
intelligence goes into *what* and *when* to surface, not into acting unattended.

**Consequence for the durable record (§8):** it must store sub-patterns — with
occurrence counts and inter-instance similarity — not just whole candidates with
a count, so a repeatable core can surface even when its surrounding task never
repeats.
