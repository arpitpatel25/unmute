# How skill invocation actually works (and the actor distinction)

Clarifies a question that could look like a contradiction: are skills
auto-selected by the agent, or manually picked by the user? **Both — by design.**
Grounded in the official docs (see `02`).

## The two native paths (Claude Code / the Agent Skills standard)

1. **Model invocation (automatic).** Every skill's `name` + `description` is
   pre-loaded into the agent's context at startup. When your request matches a
   description, the agent **auto-loads and uses that skill** — you don't name it.
   This is Anthropic's *intended primary path* ("Claude uses skills when
   relevant").
2. **User invocation (manual).** You type `/skill-name` to invoke it directly —
   the explicit path.

**Default: both are enabled for every skill.** Per-skill frontmatter can lock it
to one:
- `disable-model-invocation: true` → **manual-only** (the agent won't auto-fire
  it; used for side-effecting things like `/deploy`).
- `user-invocable: false` → **agent-only** (hidden from the `/` menu; background
  knowledge the user shouldn't invoke as a command).

So the honest answer to "are they auto or manual?" is: **auto by default, with
manual as a first-class path, and each skill can opt into one mode.**

## Why users end up picking manually anyway

Kailik's read is correct: the agent is *supposed* to auto-select, but often
misses, so users fall back to `/invoke`. The misses are **structural**, not just
model weakness: the skill listing is budgeted at ~1% of context and
**descriptions get truncated as the library grows** (`02`), and phrasing may not
match the description. So auto-selection degrades exactly as a user accumulates
skills — which is when they most need it. Manual invocation is the reliable
fallback, and it depends on the user *remembering the skill exists* (the
awareness problem, `07`).

## The reconciliation with `09` — it's about a DIFFERENT actor

This is the crux, and it removes the apparent contradiction with "the user
selects, don't auto-execute" (`09`):

- **The AGENT auto-selecting a skill** (matching its own description) is native,
  intended, and fine. Not our concern to suppress.
- **UNMUTE auto-executing a skill on the user's behalf** — a *layer in front of*
  the agent inserting its own choice — is the **routine posture** we rejected
  (`05`, `09`). Different actor, different call.

So there's no contradiction. Skills *are* auto-selectable **by the agent**; what
`09` rules out is **Unmute** being the one that decides-and-fires. Two different
hands on the trigger.

## Where Unmute's invocation-assist sits (both paths, without usurping choice)

- **Improves the MANUAL path** — surface relevant skills for visibility + resolve
  "use my X skill" → the exact `/slug`. The user still pulls the trigger.
- **Can improve the AUTO path** — the curator's *update* op tunes `description` /
  `when_to_use` so the **agent** auto-fires correctly more often (root-cause fix
  for under-invocation; what skill-creator does).

Neither has Unmute deciding *for* the user which skill runs. We help the user
invoke, and we help the agent auto-invoke better — but the selection decision
stays where `09` put it: with the user (manual) or the agent's own matching
(auto), never with Unmute.

## One line

Skills are auto-selected by the agent by default AND manually invocable by the
user (per-skill configurable); auto degrades as the library grows, so manual is
the real fallback — and `09` isn't a contradiction because it forbids *Unmute*
(a front layer) from auto-firing, not the *agent* from auto-selecting.
