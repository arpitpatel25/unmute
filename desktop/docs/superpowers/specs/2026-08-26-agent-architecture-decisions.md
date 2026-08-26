# The Unmute Agent — architecture decisions

> The decisions reached in discussion on 2026-08-26, with the reasoning that
> produced them. This is the *why*. The *what to change* is in
> `../plans/2026-08-26-agent-rework-plan.md`.
>
> Several of these reverse decisions made during the 26 August build
> (`16d6626`…`282581e`). Where they do, the superseded choice is named, so the
> record shows what was tried rather than pretending the new answer was obvious.

---

## D1 · What is a tool, and what is an instruction

**Decision.** A capability becomes an MCP tool **only where the app itself must
act** — spawn a process, touch the Unmute UI, write the clipboard, or hold a key
the Agent does not have. Everything else is an **instruction** plus a file the
Agent reads with the tools it already has.

**The test.** Can a vanilla harness with `Read`, `Glob` and `Grep` do this
itself? If yes, it is an instruction. If no, it is a tool.

**Why.** A tool constrains the Agent to the queries its author imagined. A
schema taking `query: string` and returning hits ranked by a hand-written
function cannot express "everything in unmute-cloud from Tuesday mentioning the
notch" — trivial with grep over a file. Wrapping readable data in a tool caps
the Agent's intelligence at the API design.

This is the same failure as the regexes deleted in `5ae30b6` / `75014ad`, one
layer up: *"using an intelligent model and then overruling it with a regex is
paying for judgement and refusing to accept it."* Deciding in advance how the
Agent is allowed to query its own data is that mistake in schema form.

**The division, stated once.** A tool executes a deterministic action. Deciding
*which* action, with what arguments, from what evidence, is indeterminate — and
that belongs to the Agent. Tools are the deterministic edge; the harness is the
judgement.

**No confinement cost.** `Read`, `Glob` and `Grep` are already in the Agent's
allowlist. Moving reads from tools to instructions widens the blast radius by
exactly zero — `Bash`, `Write`, `WebFetch` and `WebSearch` remain denied, and
those are what do the security work.

**Worked example — why memory stays a tool and sessions do not.**
Both are real deterministic code. `memory_search` is SQLite FTS5 with BM25
ranking; no model is involved anywhere in the memory subsystem. But the store is
SQLCipher with its key in the Keychain: the Agent has no key and no shell, so it
*physically cannot* read it. The session index is plaintext JSON on the same
disk the Agent can already open. Only the first is unreachable, so only the
first is justified as a tool.

---

## D2 · The session record is flat, dated, and not tiered

**Decision.** One record covering roughly the **last four to five days**, every
session, each stamped with its date. **No 24/48/72-hour tiers.**

**Why.** Tier boundaries are guesses about what "recently" means, and they need
tuning forever. A date is ground truth, and the model does date arithmetic
perfectly well. Any grouping by day is the model's to do at read time.

**Supersedes** the `hot ≤24h / warm ≤72h / cold` tiering in the 26 August design.

---

## D3 · The window bounds generation, not retention

**Decision.** Summarise anything touched in the window. **Keep every summary
forever.**

**Why.** A summary is a few hundred bytes. Deleting one when its session ages
out throws away work already paid for. Kept, "that thing I did three weeks ago"
is also fast — its summary was written when it was fresh. The window means *we
stop updating it*, never *we forget it*. This makes search cover the whole
history at no additional cost and turns the full-disk fallback into a genuine
rarity rather than the normal path for anything over a week old.

---

## D4 · What is summarised, and what is skipped

**Decision.** Filter on **"did a human converse here"**, not on task kind:

- exclude `derived` sessions — subagent forks, plan-task workers, the router's
  classifier REPL, and the Agent's own turns
- require a floor of real user turns
- exclude nothing else

**Why not task kind.** The proposal was "persistent `session` tasks only, not
one-offs." That axis does not exist for most of the corpus: the majority of
sessions on disk were never Unmute tasks at all — they were run in a terminal
and have no `kind`. It also cuts wrong in both directions: a one-off followed up
three times is worth summarising, and a `session`-kind task that is really a
subagent fork is not.

Measured: **16 of 81** recently-touched sessions are derived — a fifth of the
corpus removed before a token is spent.

---

## D5 · Both sides of the transcript, text only

**Decision.** Summaries read **user turns and assistant prose**. They drop
`tool_use` blocks, `tool_result` payloads, thinking, and `isSidechain` lines.

**Why not user-turns-only, as the Skill Curator does.** The curator asks *"what
does this person do repeatedly?"* — the user's own words are the entire signal
and the assistant's actions are noise. A summary asks *"what happened here?"*,
and what happened is on the assistant's side. User-turns-only yields intent
without outcome, which is the `opening` failure one level up.

The noise is removable without losing the answer: the assistant's *prose* says
what it did ("fixed the arbiter, added two tests"); the tool payloads are what
make transcripts megabytes.

**Reuse, do not re-derive.** `transcript.ts` already does this filtering with
measured justification: on a real session **211 lines carry `type: "user"` and
only 17 are a human talking** — the other 194 are tool results, which Claude
Code records as user turns because that is how the API frames them. The rule is
`message.content` being a **string** (a person) versus an **array** (tool
results), with `toolUseResult` as an independent second tell, and
`isSidechain === true` excluding subagent conversations entirely.

`agent/sessions/transcript-facts.ts` currently reimplements a weaker version of
this and does not check `isSidechain` at all. It must reuse `transcript.ts`.

**Also worth stealing:** the curator's shape is *"the reduced trace is the
user-side index; distill Read/greps the raw file on demand to pull the exact
assistant actions."* Index cheaply, reach for the raw file when specifics are
needed. That is exactly D1 — the summary is a convenience, the transcript is
always still there.

---

## D6 · Cursor, append-only, no full regeneration

**Decision.** Per-session cursor recording how far the transcript has been read.
Each update processes **only new turns**. A transcript is read **once, ever**.

Summary shape is **structured fields, not prose**:

| field | update rule |
|---|---|
| what it is about | revisable, from *(old headline + new items)* — never re-reading |
| what has been done | **append-only list of discrete items** |
| where it stands | replaced each update |
| what it touched | accumulating set |

**No full regeneration.** Explicitly rejected: re-reading a whole transcript
periodically is a token tax paid forever on every long session, charged to the
user.

**How drift is handled without it.** Drift only occurs when old content is
re-compressed. An append-only done-list never re-compresses anything — turn 5's
item survives verbatim at turn 500 because nothing rewrites it. Only the
headline needs revision, and that is done from the existing headline plus the
new items, never from the transcript. If the list grows long, roll up the oldest
items into one line — a small targeted operation, not a re-read.

**Supersedes** the "periodic full regeneration" guard proposed on 26 August.

**First-pass cap.** A session started three weeks ago and messaged today enters
the window with a cursor at zero, so its first summary would be built from the
whole transcript. This is the one genuinely expensive operation in the design
and it does not announce itself. Cap it: beyond a size threshold, summarise from
the most recent N turns and **mark the summary as partial**.

---

## D7 · Triggered by session-idle, not by a clock

**Decision.** A session is summarised when it has been **quiet for a couple of
minutes**, not on an hourly sweep.

**Why.** An hourly sweep does the wrong work twice — it captures sessions
mid-turn, in a state about to change, and re-processes anything touched in that
hour regardless of whether a turn completed. Idle is the only moment the state
is coherent.

---

## D8 · The record is pointed at, never injected

**Decision.** The per-turn digest is **removed**. In its place, a short standing
instruction saying the record exists, where it is, and when to reach for it.

**Why.** Three reasons, in order of weight:

1. **It stops fitting.** A digest holds fifteen one-liners. It cannot hold
   several days of sessions with real summaries. The moment summaries get good
   they no longer fit, so pointing is the only shape that survives the content
   improving.
2. **Context pollution.** Session openings sitting directly above every request
   bias the model toward thinking about sessions. This is the same class of bug
   as the preamble that caused the 25 August refusal — text near the question
   outranks text far from it.
3. **Cost.** Roughly 400–500 tokens on every turn, for a capability used in a
   minority of them.

**Supersedes** the always-injected digest shipped in `2c3bed9`.

---

## D9 · The lookup ladder, and the rule it must not collide with

**Decision.** A scoped, ordered ladder:

1. the recent record — the last few days, every session, dated
2. the summaries — everything ever written, however old
3. **raw `Glob` / `Grep` / `Read` over the whole disk**

If the user names something explicitly older, skip to 2 or 3 directly.

**Strictly additive.** The Agent must never be *less* capable than a vanilla
harness. The index is a fast path in front of a capability that remains whole,
never a fence around a smaller one. "I could not find it" is only true after
step 3.

**A regression to repair.** `a64ab19` replaced the constitution paragraph that
said *"Glob to find the files, Grep to narrow them, Read to open the few that
matter"* with one describing the index. The tools remain in the allowlist
(`mcp__unmute, Read, Glob, Grep`) but the constitution now mentions `Glob` and
`Grep` **zero times**. The Agent keeps the capability and loses the instruction
to use it — it will behave less capable than a bare session while holding the
tools that would answer.

**The collision to avoid.** The constitution already says, correctly:

> RETRIEVAL MEANS YOUR MEMORY, AND NOTHING ELSE… If it is not there, say so
> plainly… **Do not go looking**, do not make a task, do not treat an empty
> result as permission to search.

That exists to stop the Agent inventing work rather than admitting it does not
know. A naively worded fallback contradicts it and produces an Agent that crawls
the filesystem whenever asked where something was saved. **The ladder must be
scoped to questions about past work**, with an explicit seam saying a question
about what is *saved* remains memory-only.

---

## D10 · Seeding is the general operation; resume is the narrow case

**Decision.** The primitive is:

> **start a session, on harness H, seeded from sources [S₁…Sₙ], with intent I**

- N = 1 and H matches the source's harness → native resume, full fidelity
- everything else → seed from summaries

**Why the previous framing was wrong.** "A conversation cannot move between
harnesses" overstated a narrow technical fact into a product limitation. What is
true is only that *the provider's own resume mechanism* is harness-specific.
The **content** crosses freely, because a transcript is a plaintext file — and
harnesses being pluggable at all is a consequence of that property.

**This also fixes a case the old shape could not express:** same-harness,
many-sources. Three Claude sessions into one new Claude session is not a resume
— `--resume` cannot merge threads. It must be a seed. So seeding is the general
case even without crossing harnesses.

**The honesty rule survives, for a better reason.** A seeded session carries the
summary, not every detail, and the source sessions still exist untouched. So:
*"started a Codex session from those three"*, never *"moved them to Codex"* —
not as an apology for a limitation, but because the user may go looking for the
originals.

---

## D11 · `task_create` gains a context field

**Decision.** Split one field into two:

- **`intent`** — what the person asked for, in their words, **nothing more**.
  Rule and cap unchanged.
- **`context`** — material carried from prior work, framed as background to get
  familiar with, **not instructions to execute**. Its own generous cap.

**Why.** `intent`'s current description forbids exactly what seeding requires:

> *What the person asked for, in their own terms — and NOTHING MORE. […] The
> session that picks this up is fully tooled, so every extra clause you invent
> is work it will actually go and do.*

That rule is correct and load-bearing — it stops a one-sentence errand becoming
an expedition. But an Agent following it faithfully will drop all carried
context and be right to. Two registers need two fields.

`MAX_INTENT_LENGTH` is also `2_000`, which cannot hold a multi-session seed.

---

## D12 · Spend has a ceiling and a switch

**Decision.** Summary generation is the **first thing in the Agent that costs
money on a schedule rather than on a request**. It ships with a bounded
concurrency, a first-pass cap (D6), and an environment kill switch in the shape
of the existing `UNMUTE_AGENT_RUNTIME` revert.

---

## What is not being changed

- **Act** (`16d6626`) stands as shipped. The preamble/constitution agreement
  rule and the eval-harness repairs are unaffected by anything above.
- **Answer** and **Keep** are agreed as they stand for now, with their gaps
  recorded in the 26 August design's §9. Storage ingestion remains open.
