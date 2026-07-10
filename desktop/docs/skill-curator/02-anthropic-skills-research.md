# What Anthropic officially says about Skills / SKILL.md — research + implications

Researched from Anthropic's primary sources (Jul 2026). Purpose: ground
skill-curator against the real spec and find where our proposed product sits
relative to what Anthropic already ships. Sources listed at the bottom.

## The headline

Anthropic launched **Agent Skills as an open standard on 2025-12-18** and is
running the **exact MCP playbook** — turn your format into the industry default.
It worked: **32 tools** (Gemini CLI, JetBrains Junie, AWS Kiro, Block Goose,
Cursor, Codex…) read the same `SKILL.md` in **under 90 days**. Skills are not a
Claude-Code feature; they are a cross-vendor standard.

## What a Skill officially is (confirms Kailik's skills-vs-routines split)

> "organized folders of instructions, scripts, and resources that agents can
> discover and load dynamically to perform better at specific tasks" — turning
> "general-purpose agents into specialized agents."

A skill = a **directory** with a required `SKILL.md` (YAML frontmatter + Markdown
body), optional `scripts/`, `references/`, `assets/`. **Domain-agnostic by
design** — Anthropic's own examples span PDF/Excel/BigQuery/commit-messages/code-
review/research-synthesis, i.e. *any* white-collar task, not tool-operation. This
is precisely the "skill (general method), not routine (tool-exploration)"
distinction from `03`-of-our-discussion. Anthropic's model IS the skills model;
our old "routine/exploration/librarian" system is a *different, narrower* thing.

**Anthropic even states the promotion trigger we theorized:**
> "Create a skill when you keep pasting the same instructions, checklist, or
> multi-step procedure into chat, or when a section of CLAUDE.md has grown into
> a procedure rather than a fact."

That is *frequency + consistency-demand* verbatim — the thesis's two gating
conditions, from Anthropic's own docs.

## The full spec (agentskills.io) — and its decisive GAP

Frontmatter fields, entire standard:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | ≤64 chars, `[a-z0-9-]`, must match dir name |
| `description` | yes | ≤1024 chars — **the discovery key** |
| `license` | no | |
| `compatibility` | no | ≤500 chars, free-text env needs |
| `metadata` | no | arbitrary string map (e.g. `version: "1.0"`) |
| `allowed-tools` | no | experimental |

Claude Code *extends* this with: `disable-model-invocation`, `user-invocable`,
`when_to_use`, `argument-hint`/`arguments`, `disallowed-tools`, `model`,
`effort`, `context: fork` + `agent`, `hooks`, `paths`, `shell`.

**THE GAP that matters for us:** the standard has **no versioning, no
dependencies, no composition primitive.** "Version" is just a free-form string
inside `metadata` — not enforced, not pinned, not resolved. There is no field
that says "this skill depends on skill X ≥ 1.2." So the thesis's composite-
silently-breaks problem is **not solved by the standard — it's a structural
hole in it.** That is the single strongest validation of our "the lifecycle
between files is the product" claim: the spec deliberately stops at the single
file and punts everything *between* files to clients. Which is our territory.

## Scope hierarchy (maps to personal/org/public taxonomy)

| Level | Path | Precedence |
|---|---|---|
| Enterprise | managed settings | highest (overrides all) |
| Personal | `~/.claude/skills/<name>/SKILL.md` | overrides project |
| Project | `.claude/skills/<name>/SKILL.md` | |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | namespaced, no clash |

Same-name → enterprise > personal > project > bundled. Nested `.claude/skills/`
load on demand per working directory (monorepo). **Anthropic ships the exact
scope ladder the thesis calls personal/org/public.** Our v1 (personal) and the
org-wedge both have first-class homes already.

## The one that reshapes our product: `skill-creator` already exists

Anthropic ships a first-party plugin, **`skill-creator`**, that helps *create,
test, measure, and refine* skills. It does:
- eval test cases per skill (`evals/evals.json`), one **isolated subagent per
  case**, grading with evidence;
- **benchmark** with-skill vs without-skill (pass rate, tokens, time);
- **blind A/B** between two skill versions before you commit an edit;
- **description tuning** (generates should-/should-not-trigger prompts, measures
  hit-rate, proposes description edits);
- philosophy: **"skills as living artifacts requiring continuous assessment."**

**Where it sits vs. us — this is the key strategic read:**
`skill-creator` is **author-driven and manual.** *You* decide a skill should
exist, *you* invoke it, *you* write the evals, *you* run the loop. It is an
**authoring + evaluation primitive.** It does **not**:
- monitor your activity or detect recurrence ("you did this 4×, promote?"),
- decide *what* to create/update/delete across your whole library,
- manage **demotion/retirement** on frequency-drop,
- solve cross-skill **composition/version drift**.

So our proposed product is **not competing with skill-creator — it sits above
it.** Skill-curator = the **detection + lifecycle-orchestration layer**
(monitor → infer promotion/demotion candidates → propose) that could *call*
something like skill-creator as its authoring/eval engine. The primitive is
built; the **orchestration over a living library is the open space.**

## Two concrete signals Anthropic hands us for free

1. **Model-absorption = a real retire signal.** skill-creator's stated logic:
   > "If the base model starts passing your evals without the skill loaded,
   > that's a signal the skill's techniques may have been incorporated."
   This operationalizes the thesis's *ratchet* — the generic commoditizes
   upward. It's a crisp **death/demotion detector** beyond frequency-drop: run
   the eval without the skill; if it passes, retire the skill.

2. **Discovery degrades as the library grows — validates my pushback.** The
   skill *listing* (names+descriptions) is budgeted at **~1% of the context
   window**; with many skills Claude Code **truncates descriptions**, dropping
   the least-used skills' text first. Anthropic literally documents that a large
   personal library becomes a **discovery/selection problem**. That's exactly
   "the access/variance orthogonality leaks at scale" — so a **discovery/index
   surface** isn't optional polish; the platform's own scaling limit demands it.

## Maintenance is officially a manual human loop (our automation opening)

Anthropic's best-practices prescribe a **manual** iterate loop: "Claude A"
(refines the skill) ↔ "Claude B" (fresh instance uses it) ↔ human observes gaps
and carries them back. Eval-driven development ("build evaluations *first*").
It's rigorous — and entirely hand-driven. **The gap Anthropic leaves open is
automating that observe-refine-test loop from real activity.** That is the
skill-curator thesis restated in Anthropic's own frame.

## Net implications for skill-curator

1. **Build on the standard, not our routine system.** Target real `SKILL.md`
   dirs at the official scopes (`~/.claude/skills`, project `.claude/skills`).
   The routine/librarian machinery is a *different* system; reuse plumbing, not
   the model.
2. **Our moat is the between-files lifecycle the spec omits:** detection,
   version/composition drift, discovery, demotion/retirement. The spec's lack of
   versioning/dependencies is an invitation, not a blocker.
3. **Don't rebuild `skill-creator`; wrap it.** Position as the monitoring +
   inferred-lifecycle orchestrator that uses an authoring/eval primitive under
   the hood. v1 detection→proposal, human commit (Advisor), consistent with `00`.
4. **Free signals to bank now:** model-absorption eval as a retire trigger;
   description-listing budget as the hard reason discovery is in-scope for v1.
5. **Compatibility flag:** skills are cross-vendor (Codex/Cursor/etc. read the
   same files). A curator that manages `~/.claude/skills` is implicitly managing
   the user's skills for *every* agent they run — bigger surface than "Claude
   Code only."

---

### Sources
- Anthropic Engineering — *Equipping agents for the real world with Agent Skills*: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Claude Code docs — *Extend Claude with skills*: https://code.claude.com/docs/en/skills
- Claude platform docs — *Skill authoring best practices*: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Agent Skills open spec: https://agentskills.io/specification
- Anthropic blog — *Improving skill-creator: test, measure, and refine Agent Skills*: https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills
- anthropics/skills (public repo): https://github.com/anthropics/skills
- Context/adoption: The New Stack — *Agent Skills: Anthropic's Next Bid to Define AI Standards*: https://thenewstack.io/agent-skills-anthropics-next-bid-to-define-ai-standards/
