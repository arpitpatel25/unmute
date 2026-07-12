# The "everything is a coding agent" hypothesis — can it happen?

Kailik's foundational bet (the why behind MCP + skills): as coding agents (Claude
Code, Codex) grow in quality and most people own a pro plan, the coding agent
becomes the **primary interface to the computer** — not just for coding but for
every task (Canva, video editing, Jira, Slack, Outlook, file management, browser).
It offers an abstraction layer: the human states intent in natural language; the
agent interprets → decomposes → executes across any tool. Can this actually
happen? My assessment.

## Split it into two claims — they have very different validity

**Claim A (the engine):** a general NL→decompose→execute agent with universal
tool reach becomes the dominant *abstraction layer* for computer work.
**Claim B (the maximalist form):** *everything*, *every* task, gets done *through
a coding agent*.

**A is strongly plausible and already underway. B overreaches.** Separating them
is the whole point.

## Why Claim A is strong

- **Already happening at the edges.** People use Claude Code / Codex for non-coding
  work today: file ops, data wrangling, infra, web automation, MCP integrations
  (Slack/GitHub/Jira/Notion). The evidence Kailik cites is real, not speculative.
- **Text/file/API/DOM is a near-universal substrate.** Most computer state is
  ultimately files, APIs, or a DOM — all things a coding-shaped agent can touch.
  So the *reach* is plausibly universal.
- **The abstraction is genuinely valuable.** State intent once instead of learning
  N tool UIs. This is the "access is commoditized" leg of Kailik's own skills
  thesis — real democratization.
- **MCP + skills are the right infra bet.** MCP standardizes tool-reach (USB-for-
  tools); skills standardize *how well* it's done. Both are precisely the
  infrastructure this future needs — which is why building on them is sound.
- **Economic gravity.** Once you own + pay for a capable agent, routing one more
  task-type through it is ~zero marginal cost, and one interface beats twelve.
  There's a real pull toward consolidation.

So the directional bet is good. The disagreement is only with the word
"everything" and the words "coding agent."

## Where "everything, via a coding agent" breaks — three axes

**1. Form: the engine generalizes, the SURFACE diversifies.** Kailik's own thesis
already says "the agent is the interface, NOT everything is literally a coding
agent." That caveat is load-bearing. The coding *shape* (terminal/CLI/text) is
where capability matured first, but it's a **power-user surface**. The universal
interface likely keeps the coding-agent *engine* while shedding its *form* —
becoming voice/chat/ambient for most people. So "everything is a coding agent" is
right about the **engine**, wrong about the **surface**. (This distinction is not
academic — see §Unmute.)

**2. Task type: tight-loop / perceptual / subjective tasks resist delegation.**
Coding agents win at *specifiable, verifiable, asynchronous* tasks: define →
decompose → execute → check. They're weak where the loop is *real-time,
perceptual, or taste-driven* — live video scrubbing, design where the eye is in
the loop, anything with a fast human feedback cadence. NL→decompose→execute has
round-trip cost; where the human wants direct manipulation and immediate visual
feedback, an agent intermediary adds latency and loses fidelity. The frontier is
**delegatable** tasks, not *all* tasks. Direct manipulation survives where the
loop is tight and perceptual.

**3. Market structure: embedded vertical agents contest the orchestrator.** Every
tool (Figma, Canva, Jira, Notion) is *also* racing to put its own agent inside
itself. So the real contest is: does the **horizontal orchestrator** (one agent →
many tools via MCP) or the **embedded vertical agent** (each tool's own) own the
user's primary interaction? Likely both coexist — the orchestrator wins
**cross-tool workflows, glue, and the long tail**; the embedded agent wins
**deep single-tool work**. So "the coding agent becomes THE interface for
everything" is too strong; it becomes the interface for **orchestration + the
long tail**, while deep vertical work stays partly in specialized agents.

**Plus a gating factor — consequence asymmetry.** Reversible, low-stakes tasks
(organize folders, draft) delegate frictionlessly. Irreversible/high-stakes
(send money, publish, email a client) need confirmation, which keeps a human
gate. So delegation is uneven across the consequence spectrum — near-total for the
reversible majority, gated for the irreversible tail.

## Calibrated verdict

- **YES** to the engine becoming the dominant abstraction layer for
  **delegatable, verifiable, cross-tool, and long-tail** computer work — a very
  large fraction, and already visible.
- **NO** to a literal "*everything*, via a *coding-agent form*." It overreaches on
  form (surface diversifies beyond the terminal), task type (tight-loop/
  perceptual/subjective work resists full delegation), and market structure
  (vertical embedded agents keep deep single-tool work).
- **Defensible version:** *the agent-engine becomes the primary interface for the
  large delegatable majority of computer tasks, in surfaces that mostly won't look
  like a coding agent.*

## Why this matters for Unmute (the punchline)

The single most important nuance — **engine generalizes, surface is the
constraint** — is Unmute's entire reason to exist. Unmute is not betting on
"coding agents win" (that's already happening, and betting on the obvious wins
nothing). It's betting on the *corollary*: **if the universal engine is a coding
agent but its native surface (the terminal) is a power-user ceiling, the
opportunity is to be the SURFACE — voice/ambient — on top of the generalizing
engine.** Skills + MCP are what make that engine capable across tools; the
invocation/awareness layer (docs 07–10) is what makes the voice surface *reliable*
on top of it. So Kailik's hypothesis isn't just true-enough — its *failure mode*
("everything won't be a literal coding agent") is precisely the gap Unmute fills.
The stronger case for Unmute is not that the hypothesis is 100% right; it's that
it's right about the engine and wrong about the form, and Unmute owns the form.

## Leading indicators (how we'd know it's happening)

- The ratio of **non-coding to coding** invocations of these agents rises.
- **Cross-tool MCP workflows** grow faster than in-tool (embedded-agent) usage.
- People increasingly do Slack/Jira/file/browser tasks *through* the agent rather
  than each tool's own UI.
- Skills/MCP for non-dev tools proliferate faster than dev-only ones.

If those trend up, Claim A is validating. Watch whether they do it in a *terminal*
or in *voice/chat/ambient* surfaces — that ratio is the read on whether the form,
not just the engine, is up for grabs (i.e., whether Unmute's wedge is opening).
