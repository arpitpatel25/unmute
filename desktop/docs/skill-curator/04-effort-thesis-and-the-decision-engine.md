# The effort thesis + where the real work is (the decision engine)

Kailik pushed back: don't wait on Anthropic; the problem is real enough now; our
edge is intelligence (model-agnostic) + our approach to analyzing transcripts +
existing skills to decide create/update/delete. And the deeper reframe: this
rests on **"humans don't put effort"** — people won't create/update/delete skills
they *should*, because it's effort, and we remove that effort by observing and
surfacing a reviewable suggestion. My take below.

## 1. The reframe is genuinely stronger — I'm bought in on "should we"

I'll concede this cleanly, because it's not flattery — it's a real category
shift. Last turn I framed the risk as *demand* (do people want library
maintenance?). Your reframe moves it off demand entirely and onto an
**invariant of human behavior**: *people won't do effortful-but-good things.*
That's a different, sturdier footing:

- A **demand** bet needs to *create* a want. Fragile.
- An **effort-removal** bet rides a want that already exists but is blocked by
  friction. You're not convincing anyone that maintained skills are good — they
  already believe it; they just won't do the work. Copilot, autocomplete,
  memory, "1-click" everything — the biggest wins in this space are all
  effort-removers on known-good behavior, not demand-creators. This is the right
  category to be in.

And your evidence is correct and observable: **most people never create the
skills they obviously should**, not because they don't want them but because
authoring is friction with a delayed, invisible payoff. Removing that friction
while keeping a human accept/reject gate is a legitimate, well-shaped product
motion. So I'll stop arguing "should we." We should explore it.

## 2. The one point that survives — and it's *for* you, not against

The effort thesis does not kill the precision problem. It **renames** it — and
makes it the *definition of success* rather than a risk to wave off.

Here's the mechanism: effort-removal only nets positive if
**review-effort < do-it-yourself-effort (or ignore-effort).** The moment a
suggestion is wrong, you didn't remove effort — you *added* it: now the user
spends attention evaluating a bad idea and dismissing it. A wrong suggestion
isn't neutral noise; it's a **broken promise of the exact thing you sell.** Three
mediocre suggestions and the user stops reading — and your effort-remover has
become an effort-adder they mute.

So under your own thesis, precision isn't a "kill risk" to set aside — it *is*
the product working or not. The good news, and why this is a redirection not a
warning: that turns precision from a fuzzy market unknown into a **concrete
engineering target you control.** You don't need the market to cooperate; you
need the decision engine to be good. That's a much better problem to own.

## 3. Your best example is quietly the strongest part: UPDATE, not create

You reached for the update case — *"on multiple occasions the model gets stuck,
or we deviate from the path of the skill, so it's smart to just update the
skill."* That example is doing more work than you gave it credit for. Update is
the **most defensible and highest-value** of the three operations:

- **It hurts more when absent.** A missing skill costs you a re-prompt. A *wrong/
  stale* skill actively fires on every relevant session and degrades output
  silently — a standing liability. Fixing it has compounding upside.
- **Nobody ever does it.** People occasionally create a skill in a burst of
  motivation. Almost no one goes back weeks later to fix one that's drifted. The
  effort-gap is widest exactly here — which is where an effort-remover pays most.
- **Anthropic is least likely to casually own it.** "Suggest making a skill" is
  the obvious first-party feature. "Notice your existing skill is now wrong
  because your codebase/tools/standards drifted, and propose the diff" requires
  sustained cross-session observation — richer, stickier, less obvious.
- **It's the same thing I called library health last turn.** Your update case and
  my "janitor > author" reframe are the same insight from two directions. That
  convergence is a good sign. Lead with update; let create be the easy on-ramp.

Signals that feed update detection, concretely:
- **Deviation** — a skill fires but the transcript shows the user/model
  repeatedly correcting *away* from what the skill says → stale.
- **Getting stuck** — a skill fires and the outcome is failure/rework → a gap in
  the skill.
- **Drift from below** — a tool/dependency/path the skill names changed → the
  skill now points at something that moved.

## 4. On the "intelligence advantage": the model is the commodity, the harness is the moat

You framed the edge as intelligence — GPT-5, Gemini, any model. True that
model-agnosticism is a real feature (and a vendor-neutrality wedge). But I'd
sharpen where the moat actually sits, because it changes what you invest in:

**The frontier model is the commodity here — everyone can call it. Your edge is
what you feed it and how you frame the question.** Specifically:

1. **Transcript reduction** — turning a noisy multi-hour session into the compact,
   faithful signal of "what pattern actually happened here." (We already do a
   version of this — `trace-reducer.ts`.) A great model on a bad reduction makes
   bad calls. This is proprietary engineering, not a model call.
2. **Library representation** — how you encode the user's *existing* skills so the
   engine can ask "is this already covered? is this an update to an existing one,
   or a genuinely new skill?" The create-vs-update fork lives entirely here.
3. **Decision framing** — the prompt/harness that turns "here's a recurrence +
   here's the library" into a calibrated create / update / skip judgment with a
   drafted artifact.

That's *good* news: your moat is your own engineering (2–3 years of tuning the
harness), not privileged access to a model anyone can rent. The model getting
better lifts you and every competitor equally; your transcript-analysis +
decision-framing is the part only you have.

## 5. Concrete shape of the decision engine

A pipeline, mostly buildable on machinery we already have (deterministic counting
+ LLM judgment — the split the librarian/`skill-usage.ts` already use):

1. **Deterministic recall** (cheap, no LLM): scan reduced transcripts for
   candidate patterns — recurrence counts, skill-invocation outcomes, correction
   loops. Produces *candidates*, over-inclusive by design.
2. **Semantic match against the existing library**: for each candidate, is there
   a skill that already covers it? → routes to CREATE (no match) vs UPDATE
   (match, but drift/gap) vs SKIP (covered and fine).
3. **Intelligence judgment**: the model decides *worth it?* — frequency alone
   isn't enough; it weighs consistency-demand and whether a skill would actually
   have helped. This is the calibrated gate that controls precision.
4. **Draft the artifact**: a proposed `SKILL.md` (create) or a diff (update),
   using the standard format from the research doc.
5. **Human accept/reject** — the commit gate. Never auto-write.
6. **Close the loop** (the part that separates this from a sprawl-generator):
   after acceptance, did the skill get used / did it help? Feed that back so a
   bad accept can be walked back. Without this, you automate skill *sprawl* and
   degrade the very discovery the platform already struggles with.

## 6. The first thing to build hasn't changed — only its purpose has

Last turn I proposed a read-only **shadow detector** as a way to test *whether*
to do this. You've set "whether" aside — fine. But the shadow detector is still
the right first build; its **purpose just changes from "decide go/no-go" to
"tune the decision engine before it's allowed to speak."** It's the dev harness:
run steps 1–4 over real transcripts, write the would-be suggestions to a log,
touch nothing, show nothing. Read the log; tune recall + judgment until the
suggestions are consistently "yes, actually." Only then wire a UI and let it
surface to a user. You never ship a mediocre-precision co-pilot, because you
tuned it in the dark first. Same artifact, now a build step instead of a probe.

## My take in one line

The effort-removal reframe is the right footing and I'm bought in on exploring
it; precision stops being a market risk and becomes your core engineering target;
**update/health is the defensible heart, not create**; the moat is the
transcript-analysis-and-decision harness (the model is rented), and the first
build is the shadow detector repurposed as the tuning rig for that harness.
