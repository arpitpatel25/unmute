# Skill Curator — design discussion (consolidated)

> **Status: FUTURE WORK. Not being built now.** This directory preserves a
> design discussion so it isn't lost. Nothing here is committed to
> implementation; it's a thinking record to pick up from later.
>
> This README is the synthesis. The numbered docs (`00`–`06`) are the detailed
> record, in the order the thinking happened. Read this for the whole picture;
> drop into a numbered doc for depth on any one thread.

---

## The idea, in a paragraph

An **intelligence layer that watches the user's Claude Code sessions and acts as
a co-pilot for their Agent Skills** — the `SKILL.md` files under `~/.claude/skills`
and project `.claude/skills`. It notices when something recurs enough to deserve
a skill, when an existing skill has gone stale or keeps getting deviated from,
or when a skill is dead, and it **surfaces a suggestion — create, update, or
delete — that the user accepts or rejects.** It never auto-writes the user's
files. Working name: **skill-curator**.

---

## Core conclusions (what we decided)

1. **It's worth pursuing** — as a long-term bet, not a now-build. Valid,
   non-obvious, and resting on a sturdy foundation (see the effort thesis below).
2. **It is a SEPARATE system** from Unmute's existing routine/librarian/
   graduation machinery. They may share plumbing; they must not merge. (`05`)
3. **Lead with UPDATE, not CREATE.** Fixing stale/drifted skills (library
   *health*) is the most defensible, highest-value, least-Anthropic-ownable part.
   Create is the easy on-ramp; maintenance is the durable core. (`03`, `04`)
4. **The moat is the harness, not the model.** Transcript reduction + how we
   represent the existing library + how we frame the create/update/skip decision.
   The frontier model is a rented commodity. (`04`)
5. **Precision is the whole product**, and under the effort thesis it stops being
   a market risk and becomes a concrete engineering target we control. (`04`)
6. **First build = a read-only shadow detector** that logs what it *would*
   suggest over real transcripts — the rig to tune precision before any UI. (`03`, `04`)
7. **The routine engine stays unchanged**; the co-pilot is additive. A few
   integration seams are real but confined to the shared surface + libraries. (`06`)

---

## The thinking, thread by thread (with the nuances)

### 1. Skills vs. routines — they are different animals (`05`)

Unmute already has a memory system: **routines** — how the agent *operates a
specific tool/product*, discovered by exploration, auto-promoted by a
**librarian**, stored under `~/.unmute/remote/`, with **low user control**
(automatic). The new **skills** are the opposite on every axis: a *general
method* for any kind of work (HR screening, PR test cases, frontend design —
anything, tool-agnostic), observed from the user's own sessions, **user-owned**,
under `~/.claude/skills`, in the **`SKILL.md` open-standard format**, with a
**human accept/reject gate on everything**.

The clincher that they're separate: the routine system's own code
(`skill-usage.ts`) states *"we NEVER write into `~/.claude/skills` — the user's
own files are their territory."* The old system is structurally forbidden from
exactly the territory the new one operates in. Keeping them separate is
**load-bearing** — merging would import the routine system's automatic/low-control
model into the user's sovereign files, which is the exact posture the skills
co-pilot exists to reject. Watch the **word collision**: both produce things
called "skills," but an Unmute graduated *recipe* ≠ a user-owned `SKILL.md`.

### 2. What Anthropic actually says about Skills (`02`)

- **Skills are an open standard** (launched 2025-12-18), the MCP playbook again —
  32 tools (Gemini CLI, Cursor, Codex, Kiro, Goose…) read the same `SKILL.md` in
  under 90 days. A skill = a directory with `SKILL.md` (YAML frontmatter +
  markdown), progressive disclosure. **Domain-agnostic by design** — this *is*
  the "skill = general method" model.
- Anthropic states **our promotion trigger verbatim**: "create a skill when you
  keep pasting the same instructions… or a CLAUDE.md section has grown into a
  procedure" = frequency + consistency.
- **The decisive gap:** the standard has **no versioning, no dependencies, no
  composition primitive** — it stops at the single file and punts everything
  *between* files to clients. That between-files lifecycle is exactly our
  territory, and the strongest validation of "the lifecycle is the product."
- **`skill-creator` already exists** (first-party) — it creates/tests/measures/
  refines skills (evals, benchmark with-vs-without, blind A/B, description
  tuning). **But it is author-driven and MANUAL.** It does not monitor activity,
  infer promotion, manage demotion, or handle drift. So **skill-curator sits
  ABOVE it** as the detection + lifecycle orchestrator that could *wrap* it — not
  a competitor.
- **Two free signals banked:** (a) *model-absorption as a retire trigger* — "if
  the base model passes your evals without the skill, its techniques were
  absorbed"; (b) the skill listing is budgeted at ~1% of context and truncates
  descriptions as the library grows, so **a big library literally degrades its
  own discovery** — proof that discovery is a first-class v1 need, not polish.

### 3. The philosophy: bottleneck-shifting → the effort thesis (`03`, `04`)

The human is always the bottleneck; each layer gets absorbed and the bottleneck
shifts down: can't-code → GPT/Claude; large-repo/continuous coding → Claude Code;
agent loops → resolved. The **current frontier bottleneck is skills** — the
primary lever for customization and consistency, but now the human must author
and maintain them, and **humans don't put effort into effortful-but-good things.**

That reframe matters: it moves the bet off **demand** ("do people want library
maintenance?" — fragile) and onto an **invariant of behavior** ("people won't do
the effortful thing") — the **effort-removal** category (Copilot, autocomplete,
memory). People already believe maintained skills are good; they just won't do
the work. We remove the friction and keep a human accept/reject gate.

**The nuance that survives (and reshapes the risk):** the effort thesis doesn't
kill precision — it *renames* it and makes it the definition of success.
Effort-removal only nets positive if review-effort < do-it-yourself/ignore effort.
A wrong suggestion is a **broken promise of the exact thing we sell** — worse
than neutral noise; a few of them and the user mutes us. So precision *is* the
product, now framed as an engineering target we control rather than a market
unknown.

### 4. Is it valid / should we even try it? (`03` → `04`)

Landed at **yes, worth a real hunch**, after honestly walking the bear cases:
- **Demand is diffuse** (a vitamin, not a painkiller) — *answered* by the
  effort-removal reframe + ambient delivery (inject at the moment of recurrence;
  a "manage your skills" dashboard is dead on arrival).
- **Precision is hard** (higher bar than code autocomplete; false positives kill
  via notification blindness, false negatives are invisible) — *accepted* as the
  core engineering target.
- **Anthropic's shadow** is the biggest strategic risk (they own the transcripts,
  client, standard, and ship skill-creator). Thin-but-real wedges: an ambient-
  monitoring / local-first posture a first-party vendor won't ship by default;
  **vendor-neutrality** (manage your skills for *every* agent — Codex, Cursor,
  Gemini — the most durable, most underrated wedge); and speed.

### 5. The reframe: janitor > author (`03`, `04`)

Creation is the seductive framing *and* the least defensible — the model,
skill-creator, and Anthropic all converge on it. The un-owned durable part is
**library health**: dedup, retirement, composition/version drift, and
**discovery**. If we only automate creation, we automate **skill sprawl** — more
mediocre skills, worse discovery, net-negative. So the loop must close:
**suggest → accept → did it actually help? → keep / refine / kill.** Accept/reject
alone is too low-bandwidth.

### 6. The decision engine (the actual product) (`04`)

A pipeline, largely buildable on machinery we have (deterministic counting +
LLM judgment, as in the librarian / `skill-usage.ts`):

1. **Deterministic recall** (cheap, no LLM) — scan reduced transcripts for
   candidate patterns: recurrence, skill-invocation outcomes, correction loops.
   Over-inclusive by design.
2. **Semantic match vs. the existing library** — routes each candidate to
   **CREATE** (no match), **UPDATE** (match but drift/gap), or **SKIP** (covered).
3. **Intelligence judgment** — *worth it?* Weighs consistency-demand, not just
   frequency. The calibrated gate that controls precision.
4. **Draft the artifact** — a proposed `SKILL.md` (create) or a diff (update).
5. **Human accept/reject** — the commit gate; never auto-write.
6. **Close the loop** — after acceptance, did it get used / help? Feed back so a
   bad accept is walked back.

**Update-detection signals:** *deviation* (skill fires but the user/model keeps
correcting away from it → stale), *stuck* (skill fires, outcome is failure/rework
→ a gap), *drift from below* (a tool/dependency/path the skill names changed).

### 7. Impact on the existing routine workflow (`06`)

Verified in code: the routine **engine stays unchanged** — and that should be an
explicit constraint (if we ever need to change routine behavior to fit the
co-pilot, that's a **merge smell**). But "literally unchanged" is inaccurate,
because the current product **already** reaches into the user's skills read-only:
- voice-remote tasks run with the real HOME, so `~/.claude/skills` are already
  visible inside routine tasks;
- the **skill rail** (`remote:list-skills`, `init.ts`) already merges
  `~/.claude/skills` into one earned-trust ranking;
- the **usage ledger** already credits the user's own skills while never writing
  them.

So three **additive** touchpoints, none touching routine behavior:
- **(A) Rail provenance** — the rail is the co-pilot's natural home; once user
  skills become live/mutating it likely needs origin tags (Unmute-owned vs
  user-authored vs co-pilot-suggested).
- **(B) Usage-ledger extension** — the co-pilot needs deviation/stuck/outcome
  signal beyond "runs"; additive columns, routine keeps its half.
- **(C) Re-scope the write-boundary invariant** — "Unmute never writes
  `~/.claude/skills`" becomes "the *routine system* never writes them; the
  co-pilot writes only with explicit user consent." Hard wall → consent-gated
  door.

---

## Open decisions (unsettled — for when we pick this up)

- **Posture ladder:** ship Advisor (propose-only) first, then graduate to
  git-backed direct writes behind a switch? (recommended) (`00`)
- **Scope:** global `~/.claude/skills` only, or also per-project `.claude/skills`?
- **Surface:** the existing Unmute rail, a voice digest, a CLI/file, or a mix?
- **Trigger cadence:** on-demand, after each session, or a periodic sweep?
- **Delete policy:** confirm-each (recommended) vs. auto-retire-to-trash-with-digest.
- **v1 scope:** repetition-promote + demote/purge in v1; composition/version
  dependency-drift deferred to v2 (needs a dependency model first). (`01`)

## Recommended first step (when the time comes)

Build the **read-only shadow detector** — steps 1–4 of the decision engine over
real transcripts (we already reduce these via `trace-reducer.ts`), logging
would-be suggestions, writing nothing, showing no UI. Run it on real usage,
tune recall + judgment until suggestions are consistently "yes, actually," and
only then wire a surface. It probes precision **and** revealed demand for
days-not-months of cost, and doubles as the tuning rig for the decision engine.

---

## Document index

| Doc | What it covers |
| --- | --- |
| `00-scoping-discussion.md` | Initial scoping; ownership boundary; Advisor→git-backed posture ladder; first open decisions |
| `01-skills-thesis-and-synthesis.md` | The user's Skills Thesis (verbatim) + synthesis resolving the authoring-vs-promotion fork (detect vs act) |
| `02-anthropic-skills-research.md` | Primary-source research on Anthropic's Skills / `SKILL.md` — the open standard, the versioning gap, skill-creator |
| `03-bottleneck-thesis-and-my-take.md` | Bottleneck-shifting framing + first honest assessment (valid, cheap-probe, kill-risks, janitor>author) |
| `04-effort-thesis-and-the-decision-engine.md` | The effort-removal reframe + the decision engine as the real product; moat = harness |
| `05-boundary-two-separate-systems.md` | Decision: skills agent is separate from routines/librarian; why separation is load-bearing |
| `06-impact-on-existing-routine-workflow.md` | Code-grounded: routine engine unchanged; the three additive integration seams |
| `07-invocation-and-awareness.md` | Invocation & awareness — the runtime half of the discovery problem; why invocation-assist is a lower-risk, faster-value wedge than creation |
