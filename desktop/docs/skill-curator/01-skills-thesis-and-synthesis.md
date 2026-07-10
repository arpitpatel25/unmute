# Skills Thesis + synthesis

Part 1 is the user's thesis verbatim (the source of truth for *why* we build
this). Part 2 is my synthesis: where it changes the scope in `00`, my resolution
of the open fork, and the one place I push back.

---

## Part 1 — The Skills Thesis (verbatim)

*Working notes on why skills are the durable layer of agent-driven software, and why maintaining them is the product.*

### 1. The starting frame: the agent is the interface

For people who already own the plans and devices, the coding agent (Claude Code, Codex, and the like) is becoming the primary interface for almost all computer work — not just programming, but the full range of white-collar tasks: video editing, image work, payments, project setup, search, and so on.

The important claim is **"the agent is the interface,"** not "everything is literally a coding agent." The *coding* shape is just where capability matured first — text-native, file-native, CLI-driven. That's a power-user surface today. The audience is real but narrow: the person whose job is extracting value from agents.

### 2. Two orthogonal layers — do not conflate them

The single most important distinction in this whole thesis:

**Access is solved by the agent. Variance is solved by skills.**

These answer different questions and must not be collapsed into each other.

**Layer 1 — Access (the learning curve).** What lowers the learning curve is **the agent plus natural language**, and *nothing else*. You stop learning fifty tool UIs because you no longer operate the tool. You describe intent; the agent drives. This is the democratizer, full stop. **Skills have nothing to do with it.**

**Layer 2 — Variance (consistency and repetition).** Once access is free, a second problem remains: a raw prompt is always fresh. Every session is cold. A bare prompt can't guarantee a repeatable, consistent outcome across sessions.

**A skill is the promotion of a recurring, consistency-demanding intent from an ad-hoc prompt into a durable artifact.**

Two conditions gate whether something should become a skill: **frequency** (you do it often) and **consistency-demand** (it has to come out the same way every time). If both hold, you crystallize the pattern into a file so it survives cold starts.

### 3. Why MCP alone is not enough

MCP is the driver layer — how tool-builders expose their software *to the agent*. Building for the agent is the next paradigm. But MCP alone can't deliver consistent output, because quality still rides on the user's prompt. MCP gives the agent *hands*; it doesn't give it *your standards*. Skills supply the missing consistency on top of the MCP substrate.

### 4. Skills are dynamic, not static

Skills are never fixed. You constantly create new ones, edit/revise existing ones, retire ones whose frequency dropped, and update them as tools and standards change. **Learning to author and maintain skills replaces "learning each tool."** The maintenance burden lives *entirely* on this layer — the access layer improves on its own; skills are the part that rots.

### 5. The taxonomy of skills (distribution + composition)

**By scope / reach:** Personal (you), Org/team (shared conventions), Public (thousands).
**By composition:** a skill can be a **sequence or combination of other skills** — a dependency graph, not a flat file.

These are properties *around* a skill, not *of* it. But they matter: **composition** breaks the "just an md file" framing (graphs have versioning + silent-breakage problems); **scopes have opposite lifecycles** — public trends commoditized/model-absorbed, personal is the non-commoditizable residue, org is the sharp middle (shared conventions that must be enforced and kept in sync — where maintenance pain is most valuable to solve).

### 6. "It's just an md file" — true at rest, false in use

At rest, a skill is text — trivially copyable, zero moat. But source code is also "just text" until it runs. The value was never the file; it's everything that goes wrong **between** files: a dependency updates and silently changes a composite's output; a public skill conflicts with a personal override; a skill fired cold assumes context that isn't there. Package managers distribute *versions* fine — but don't tell you the new version now does the wrong thing for you. **The file is trivial. The lifecycle between files is the product.**

### 7. Do personal skills ever die out?

No — structural, not adoption-maturity. To exist at public scope a skill **must generalize** (written for the median of thousands, strips specificity by design). Org skills encode the *team's* conventions, not *your* deviations. There's a **floor of specificity** these scopes can't reach; personal skills live below it.

**The ratchet:** public/org get better → absorb the generic layer (how-to-drive-this-tool, boilerplate). Clearing the floor doesn't shrink personal skills — it **frees you to build more at a higher level**. The generic commoditizes *upward*; personal climbs to sit on top. Total personal skills go **up**. What dies is the **low-level generic skills** people write today out of necessity.

**The taste point:** a skill is an **encoding of a decision about how you want things done.** Public skills embody someone else's decisions; living entirely on them hands back the very workflow autonomy you chose an agent to get. Fixing-public-output-repeatedly *is* authoring a personal skill. Caveat: casual users live on defaults — but they're not the target. For the person extracting value from agents *as a job*, personal skills **are the automation** — the work product.

### 8. The conclusion this points to

Access is commoditized (agent + NL). MCP is the driver substrate — necessary, not sufficient. Skills are the consistency layer — dynamic, constantly maintained. Personal skills are the non-commoditizable, fastest-growing residue. Composition + scope make the layer non-trivial to maintain. Therefore the defensible product is **not the skills** (copyable md files) — it's the **lifecycle surface**: authoring, versioning, purging, discovery, cold-session invocation, mid-flight editing, and keeping composites and shared conventions from silently breaking. **The bottleneck was never writing one skill. It's maintaining a living library of them across stateless sessions. That maintenance surface is the product.**

### One open fork (not yet resolved)

Is consistency a skills problem, or a **memory problem wearing a skills costume**? "Make it a skill" is a manual promotion step — the user must notice recurrence, decide it's worth it, author the file. But recurrence is *detectable*. The stronger product may not just edit skills you decided to write — it may **surface promotion candidates** ("you've done this shape four times, promote it?") and manage demotion when frequency drops. Conscious authoring vs. inferred promotion are two very different products; only one may be defensible. This is the next thing to decide.

---

## Part 2 — Synthesis (my response)

### 2.1 The fork dissolves once you split *detection* from *action*

The fork reads as binary — conscious authoring **xor** inferred promotion — but it
only looks binary because it bundles two independent decisions:

- **Detection** (spotting recurrence) is cheap, safe, and strictly additive.
  Surfacing "you've done this shape 4× — promote?" has no downside; it's a
  suggestion the user ignores for free. This should **always run.**
- **Action** (writing / editing / deleting a file the user owns) is the only
  part carrying risk. *This* is the trust boundary — and the whole subject of
  `00`'s Advisor→git-safe→never-silent ladder.

So the product isn't authoring XOR promotion. It's **inferred promotion as the
proposal engine + conscious authoring as the commit gate.** That is exactly
Posture A. And it's not a compromise — it's forced by the thesis's own §7 taste
point: a skill encodes a *decision*, and **you cannot infer a decision.** You can
only infer the *recurrence that prompts* one. The machine detects the pattern;
the human ratifies the decision. Detection is inferred; authorship stays
conscious. Both, cleanly divided — not one or the other.

### 2.2 It IS memory in a skills costume — and the costume is load-bearing

"A memory problem wearing a skills costume" is correct, and the costume is the
point. Memory you can't read, edit, diff, share, or compose is a black box. The
reason to make the promotion *target* a portable, hand-editable `.md` the user
owns is that it converts opaque memory into an **auditable, composable, shareable
artifact.** Same engine; the artifact is what makes it a skill and not a hidden
weight.

And the engine the fork describes — *detect recurrence, promote on confidence,
demote on frequency-drop* — **already exists in this repo and ships today.** It
is the librarian + confidence-graduated recipe store + gardening
(`librarian.ts`, `recipe-store.ts`, `gardening.ts`), currently pointed at
Unmute's own voice-remote recipes. Skill-curator is that identical engine
**repointed at the user's sovereign skills.** That materially de-risks the
"which product is defensible?" fear: the inferred-promotion machine isn't
speculative — it's built. The only genuinely new question is **how much authority
to give it over files the user owns** — i.e. the ownership boundary in `00`.

### 2.3 Composition is the sharpest argument, and `00` under-weighted it

Drift in `00`§6 was framed top-down (user deviates from a skill). Composition
adds **bottom-up drift**: a dependency updates and your composite silently does
the wrong thing — and `npm/npx update` will cheerfully ship exactly that, because
a package manager validates *versions*, never *intent-fit*. That gap is the one
failure mode a package manager **structurally cannot** close, and it's the
cleanest "real product, not a script" argument in the thesis. It becomes a
first-class curator detector, alongside repetition / drift / death:

> **dependency-drift** — "skill X depends on Y; Y updated; the 2 sessions since
> behaved differently — review X?"

(Deferred to v2: it needs a dependency model first. v1 treats skills as flat.)

### 2.4 One pushback: the orthogonality leaks at personal-library scale

"Access is solved by the agent, nothing else; skills have nothing to do with it"
holds globally but **leaks once your library is large.** Owning 150 personal
skills makes *invoking the right one in a cold session* its own access problem —
one you **created** by solving variance. Discovery + cold-session invocation
(both in §8's lifecycle list) are Layer-1 problems for your Layer-2 output.

This changes what we build: the curator needs a **discovery / index** surface,
not only an authoring one. Otherwise it manufactures variance-solved skills
faster than the user can find them — and an unfound skill is a dead skill: the
user re-authors it cold, creating a duplicate, which is itself a death/dedup
signal the curator must catch. Authoring without discovery just moves the mess.

### 2.5 What this does to `00`

- **Product definition, elevated.** `00` said "curate the user's skill files."
  Correct target, wrong altitude. The product is the **lifecycle surface**:
  promotion-candidate detection · authoring · versioning · composite
  dependency-drift · discovery · cold-session invocation · purge/demotion —
  with the **ownership boundary as the trust axis.** Skill-curator **v1** = the
  *detect → propose → safe-apply* slice, personal scope, on the existing engine.
- **Open decision #1 in `00` is resolved,** and replaced by a sharper dial.
  Not "authoring vs promotion" — always detect; the dial is **authority over the
  user's files:** propose-only (Advisor) → git-safe auto-apply behind a switch →
  never silent. Recommendation unchanged: **Advisor first.**
- **New v1 scope call:** v1 surfaces **both** promotion *and* demotion/purge
  candidates — frequency-drop is as detectable as frequency-rise, and the thesis
  names purging as core lifecycle. Create-only v1 would be half the product.
- **Org scope is the commercial wedge** (thesis §5: "the sharp middle"). We start
  personal, but must not architect personal-only in a way that walls off an
  org-sync path later. The same detector that *proposes* a personal skill is what
  *enforces/syncs* a shared convention at org scope.

### 2.6 The decision now on the table

1. Commit to **"inferred promotion + human commit"** as the v1 product (Advisor
   posture, detection always-on)? — *my recommendation: yes.*
2. v1 scope = **repetition-promote + demote/purge**; **composition
   dependency-drift deferred to v2** (needs a dependency model)? — *my rec: yes.*
3. Everything else stays as `00`'s open decisions (scope: global vs +project;
   surface: desktop panel / voice digest / CLI; trigger cadence; delete policy).

Settle 1–2 and I cut the implementation plan.
