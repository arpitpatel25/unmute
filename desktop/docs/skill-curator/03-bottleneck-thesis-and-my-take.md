# The bottleneck thesis + my honest take

Kailik's framing (paraphrased) and my assessment. This is a *long-term* idea —
no near-term build intent. The goal of this doc is to stress-test whether it's
even worth a hunch, not to green-light it.

## Kailik's thesis (as I understood it)

The bottleneck keeps shifting. Humans-who-can't-code → resolved by GPT/Claude.
Coding across large repos / continuously → resolved by Claude Code. Agent loops
→ resolved. **At each stage the human is the bottleneck, something absorbs it,
and the bottleneck moves one step down the pipeline.** The *current* frontier
bottleneck is **skills**: skills are the primary way to customize and get
consistency, but now the human must author, update, and delete them — and humans
are lazy, so libraries rot. Therefore the next thing worth improving is the
skill-authoring bottleneck. Unmute becomes a **co-pilot for skills**: it watches
your Claude Code sessions, notices when something recurs enough to be worth a
skill, and **surfaces a suggestion** (create / update / delete) that the user
accepts or rejects. Never auto-writes. Distinct from routines (which are ours,
tool-exploration-centered); skills can be tiny and general. The suggestion
quality is everything — it's a co-pilot, and a co-pilot that suggests badly is
dead.

## My verdict up front

**It's a valid idea. Not useless — genuinely worth a cheap probe. But it is not
an obvious business, and it has two specific things that can kill it and one
reframe I'd push on you.** I would take a hunch at it — but the hunch I'd take
is a read-only *probe of the risky assumption*, not a build of the product. Rank
it: real direction, uncertain wedge, two kill-risks, cheap to falsify. That
profile says "spend a little to learn, don't commit."

## 1. The bottleneck frame is good — but it has a flaw worth seeing

The frame is mostly right and it's a strong way to think. The flaw: in this
stack, bottlenecks are increasingly **absorbed by the model itself, not by an
external tool.** Anthropic's own skill-creator ships a retire signal — *"if the
base model passes your evals without the skill, its techniques were absorbed."*
That means a chunk of "skills you must author" is **transient** — the next model
eats the generic ones. So "humans must author skills" is not one durable
bottleneck; it's two things wearing one coat:

- **Transient shell** — generic, how-to-drive-this skills. The model + Anthropic's
  tooling will absorb these. Building a co-pilot aimed here is building on
  melting ice.
- **Durable core** — *your taste* (skills encode a decision, §7 of the thesis —
  structurally non-absorbable) and **library health at scale** (dedup,
  discovery, retirement, composition drift — the "between-files lifecycle" the
  spec deliberately omits). This does not get absorbed by a smarter model,
  because it's not an intelligence problem; it's a *curation-of-a-growing-
  collection* problem.

**Implication:** if we chase this, aim at the durable core, not the shell. Which
leads to my reframe (§5).

## 2. Demand: this is a vitamin, not a painkiller — and that's the real risk

The strongest bear case isn't "can we build it." It's: **is the pain acute
enough that anyone adopts a tool for it?** Skill-library rot is *diffuse* pain.
You never have a "my skills are unmaintained, I must fix this now" moment. You
just silently re-prompt and eat a little inconsistency. Diffuse pain is where
products go to die — there's no trigger, no urgency, no willingness to install/
learn/pay. "Humans are lazy" cuts both ways: they won't maintain skills, AND
they won't adopt a maintenance tool that asks anything of them.

**But there's a real escape, and it's exactly your co-pilot instinct.** The
answer to diffuse pain is *ambient* delivery — don't wait for the user to feel
pain, inject the suggestion at the moment of recurrence, zero effort to receive.
That's literally how Copilot beat "learn to write snippets": it made the diffuse
"I could autocomplete this" pain into an inline, ignorable-for-free suggestion.
So the co-pilot framing is not incidental — **it is the whole reason this could
work.** A dashboard you open to "manage your skills" is dead on arrival; an
ambient suggestion at the right moment is the only viable shape. Good instinct,
and it should be treated as a hard constraint, not a UI choice.

## 3. Precision is the entire ballgame — and it's genuinely hard

You said the suggestion "matters heavily." Understating it. **The product's
value is 100% gated on suggestion precision, and precision here is harder than
code autocomplete:**

- **False positives are expensive, false negatives are invisible.** Suggest junk
  and you train the user to dismiss — notification blindness — and once they mute
  you, you're dead and can't tell you're dead. Miss a real one and nobody ever
  knows. This asymmetry forces you to be *conservative*, which fights the "surface
  lots of suggestions" instinct.
- **"Recurs enough + consistent enough" is fuzzy and personal.** The threshold
  isn't global. Two sessions that *look* similar may not want the same skill;
  genuine reusable structure ≠ surface repetition. Detecting the difference is an
  unsolved problem, not plumbing.
- **The bar is brutal.** Copilot can be right 30% of the time and still win,
  because the cost of a bad suggestion is one keystroke. A *proactive* skill
  suggestion that interrupts costs attention; its precision bar is far higher.

This is where I'd put all the skepticism. The idea is valid; whether we can hit
the precision bar is the open question the whole thing rests on. **If precision
is mediocre, the product is worse than nothing — it's noise on top of work.**

## 4. Defensibility: Anthropic is standing exactly here

Be clear-eyed: this sits directly in Anthropic's path. They own the transcripts,
the client, the standard, and they already ship skill-creator. "Watch your CC
sessions and suggest skills" is the *obvious* native feature for them to build —
they have the data and the surface, we'd be renting both. If it's valuable and
obvious, the platform owner ships it and the third-party version evaporates.
That's the single biggest strategic risk and it's not hypothetical.

Three things that could still leave room — none guaranteed:
- **Posture Anthropic won't take.** Ambient monitoring of everything you do is
  "creepy" for a first-party vendor to ship by default; a smaller, opt-in,
  local-first product can take a posture the platform won't. (Local-first /
  privacy-preserving becomes a *feature*, not a footnote — the transcripts are
  already on the user's disk; we never need to exfiltrate them.)
- **Vendor-neutrality.** Skills are cross-vendor (Codex, Cursor, Gemini CLI read
  the same files). A curator that manages *your skills for every agent you run*
  is something a single vendor is structurally disinclined to build. This is the
  most durable wedge, and it's underrated.
- **Speed / focus.** Anthropic is conservative about auto-touching user files;
  a focused team can out-execute on this specific loop for a while.

Honest read: the wedge is real but thin. This is a "ride the platform and pray
they're slow / stay vendor-neutral so you're not a feature" bet, and those bets
usually need the vendor-neutral angle to survive.

## 5. The reframe I'd push: health-of-a-library > birth-of-new-skills

Creation is the seductive framing ("suggest converting this into a skill!") and
it's also **the least defensible part**, because creation is exactly what the
model, skill-creator, and Anthropic all converge on. The part nobody owns — the
durable core from §1 — is keeping a *large library healthy*: deduping
near-identical skills, retiring absorbed/unused ones, catching composition
drift, and **fixing discovery** (the platform truncates skill descriptions past
a context budget, so a big library literally degrades itself — a real, documented,
un-sexy problem with no owner). My push: **the defensible product may be the
janitor, not the author.** Creation-suggestion is a fine wedge to get in, but if
we only automate *making* skills, we automate skill *sprawl* — more mediocre
skills, worse discovery, net-negative. Whatever we build must close the loop:
suggest → accept → *did it actually help?* → keep / refine / kill. Accept/reject
alone is too low-bandwidth; a skill accepted but never validated fires wrongly
and is worse than no skill.

## 6. Timing

Long-term is the right call, and the uncertainty cuts both ways. **Too early:**
skills shipped Dec 2025; almost nobody has a library big enough to *need*
curation yet, so the pain isn't there to sell against. **Too late:** Anthropic
absorbs it. The window is "personal libraries get big enough to be
unmanageable, but before native curation ships" — real, but narrow and
unpredictable. For a long-term idea that argues *against* building now and *for*
cheaply instrumenting now so you can see the window open.

## 7. What I'd actually do (the cheap hunch)

Don't build the co-pilot. Build the **shadow detector**: a read-only pass over
your own real Claude Code transcripts (we already locate + reduce these —
`trace-reducer.ts`) that, on some cadence, **logs what it *would* have suggested**
— promote this, retire that — and writes nothing, shows no UI, touches no file.
Run it against your own and a few teammates' real usage for a few weeks. Then
read the log with one question: *"looking at these would-be suggestions, how many
make me go 'yes, actually'?"*

That single probe attacks both kill-risks for near-zero cost:
- **Precision** — you directly measure the hit rate before building anything.
- **Revealed demand** — if you read the log and *want* to act on the suggestions,
  that's real signal; if you shrug, that's the vitamin-not-painkiller answer,
  learned cheaply.

If the shadow log is consistently "yes, actually," the idea has legs and you've
earned the right to build the ambient surface. If it's mostly noise or you don't
care, you spent days, not months, to find out. Either way you're deciding on
data, not on the (genuinely appealing) narrative.

## One-line take

Valid, non-obvious, worth a hunch — but the hunch is a read-only precision probe,
the defensible core is library *health* not skill *birth*, and the real enemies
are diffuse demand and Anthropic's shadow, not feasibility.
