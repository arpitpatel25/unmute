# The Unmute Agent, improved — design

> Five modules. One of them is already committed (`16d6626`). The rest are
> specified here so they fit together rather than accumulate.
>
> Written 2026-08-26, against `arpit/notetaker` (which is `main` + 108).

---

## 0. What was actually wrong

Not capability. On 25 August the Agent was asked four times to launch a session
and submit a prompt, and refused every time — with `task_create` in its tool
list throughout. The per-turn preamble carried *"Never send, submit, publish, or
commit it"*, the request contained the word *submit*, and a preamble pasted
above the user's own sentence outranks a system prompt in practice.

That is the shape of most of what follows. The Agent's parts are individually
sound; what is missing is that they **do not know about each other**, and where
they overlap they contradict. So the goal is not more tools. It is:

1. what it is told must agree with itself (**§1, done**),
2. it must know what exists before it is asked (**§2**),
3. it must be able to pick any of it back up (**§3**),
4. it must be able to hand back something longer than a caption (**§4**),
5. it must be able to keep a thing the user gives it (**§5**).

---

## 1. Act — the preamble agrees with the constitution · **DONE** (`16d6626`)

The contradictory line is gone and replaced with the constitution's own law.
Two structural gaps that let it ship green are closed: the eval harness served
only `MemoryCapability`'s tools (so every corpus case asserting `task_create`
could never pass), and it piped the bare utterance instead of
`providerTranscript()` (so the preamble was never under test).

**The rule this establishes, and the reason the file now says so in a comment:**
anything asserted in the per-turn preamble MUST agree with `constitution.ts`.
The preamble is for what is true *about this turn*; behaviour lives in the
constitution. Five unit tests pin them together.

---

## 2. Know — the session index

### The problem, in the user's words

> "I did some task a day or two back… I don't know where/what is that claude
> session, or what is that doc called. I don't want to say 'do you remember?'
> and wait for a yes or no."

Today `sessions_list` sees **Unmute-created tasks only** — a fraction of the
truth — and reports `project` as a **UUID**, because it is `basename(task.cwd)`
and cwd is `~/.unmute/remote/local/<uuid>`. There is no way to find a session by
what it was about. The constitution tells the Agent to `Glob`/`Grep`
`~/.claude/projects` instead, which is a blind search over 717 files.

### Scope

Every session on disk, from every harness, regardless of who started it:

| Source | Location | Count today |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 717 across 188 projects |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 344 |

Keyed on **last touched, never created** — a session opened ten days ago and
worked in this morning is this morning's session. `mtime` is the key; no read
is needed to tier.

Tiers: **hot** ≤24h · **warm** ≤72h · **cold** beyond (reachable, deliberately
slower). Today that is 65 + 20 = **85 hot/warm files**, which is the number that
makes the rest of this affordable.

The Agent's own turns are excluded by `cwd` — they live under the agent runtime
directory, which is precisely why the Agent was given its own ground.

### Two tiers of derived data, and this is the load-bearing decision

The open question was *who generates the summaries, when, and where do they
live*. Generating a model summary for 85 sessions on every launch is real money
for data that is mostly never read. So derived data splits:

**Facts — free, no model, computed by reading the file.**
`id · harness · cwd · project (real basename of cwd, not the task uuid) ·
lastTouchedAt · turns · firstUserMessage (truncated) · lastAssistantMessage
(truncated)`.

The first user message is a very strong signal — it is usually literally what
the session is about. For the sample inspected: *"Help me think through the
fundamentals of what a general-purpose computer-use agent needs to handle…"*.
That alone answers most "which session was that?" questions.

**Summary — one paragraph, model-generated, cached, lazy.**
Generated **only when something actually needs it** (a `session_read`, or a
lookup the facts could not disambiguate), then cached keyed by
`(sessionId, mtime)` so it is computed once per change and never on a timer.
Zero background cost; the expensive thing happens only when it is the answer.

**Where it lives:** `unmute-agent/sessions/index.sqlite`, mode `0600`.
Deliberately **not** in the encrypted memory store. Memory is what the user
authored and asked to keep; this is a reconstructible cache over plaintext files
that already sit unencrypted on the same disk. Encrypting a derived index of
public-on-disk data buys nothing and couples two lifecycles that should be able
to fail independently — a corrupt index should be deletable without touching a
single user memory.

### What the Agent is handed without asking

A **digest** injected into every turn by `providerTranscript()`, alongside the
existing recent-exchange summaries: the hot tier, bounded to 25 entries, one
line each — `id · harness · project · when · first-message excerpt`.

This is the difference the user asked for between an ordinary harness session
and an Unmute Agent one: *it already knows what you have been working on before
you finish the sentence.* A bounded digest, not the index — the index is what
`sessions_search` reaches into when the digest is not enough.

### Tools

- `sessions_list` — rewritten over the index. Real project names. All harnesses.
- `sessions_search(query)` — **new.** Over facts first, summaries when present.
- `session_read(id)` — reads the transcript, generating and caching the summary.

---

## 3. Continue — session actions

### The problem, in the user's words

> "I have a claude session in unmute, I want unmute Agent to help me continue
> that in a new fresh codex session. I expect it to create a new ticket/card in
> orchestrator dashboard as well."

Today `task_create` makes **new** sessions only. There is no resume. (Note the
asymmetry: the *task-facing* MCP tool has `fork_from_session_id`; the Agent's
own `task_create` does not.)

### The machinery already exists

`task-manager.dispatch()` already accepts `forkFromSessionId`, `agent`, `cwd`,
`kind`, `model`, `attachments`; `adoptForkSessionId()` and `resume(id)` exist.
So this module is **exposure, not new plumbing**.

| Ask | Mechanism | Result |
|---|---|---|
| Resume an Unmute task | `manager.resume(id)` | existing card wakes |
| Continue an on-disk Claude session Unmute never started | `dispatch(intent, { forkFromSessionId, cwd })` | new card, inherits the whole conversation |
| Continue a Claude session **in Codex** | `dispatch(summary + intent, { agent: 'codex', cwd })` | new card, seeded with context |

The third is not a fork — you cannot fork across harnesses. It is a **seed**:
the source session's summary (§2) plus the new intent. That is exactly why §3
depends on §2 and is specified with it.

### Tools

- `session_resume(sessionId, intent?)` — same harness, full context, one card.
- `session_continue_in(sessionId, harness, intent)` — cross-harness seed.
- `task_create` gains `cwd` and `fromSession` for parity with the task surface.

**Honesty rule, inherited:** these say what happened. "I've reopened it" only
after the dispatch returned an id — never before.

---

## 4. Answer — a surface longer than a caption

### The constraint, in the user's words

> "It should not appear from the notch. The notch is the place I want to keep
> independent of the unmute agent response. Unmute agent should feel more like
> the computer talking itself."

The caption is right and stays: one line, ≤200 chars, ≤8s, no chrome, no app.
The limit is quantity, not principle — "summarise that note" has an answer that
is inherently longer than a caption and is *itself the deliverable*, not a
pointer to one.

### Decision: the caption gains a persistent twin, not a panel

A **reader** in the caption's own visual language — black slabs, centred, no
border, no title bar, no app affordance — that does not time out. It is the
caption, expanded and held.

- Same renderer and material as `CaptionView`, so it reads as the same voice.
- **Not the notch**, not owned by it, not routed through the wall/rail/stage.
- Persists until dismissed: Escape, click-out, or a new Agent turn.
- Scrolls when it must; never grows past a readable column.

Rejected: a window (reads as another app opening — the precise feeling the
caption exists to avoid); the notch (the user's explicit boundary); a chat
transcript (the philosophy's stated bright line).

The existing rule survives intact and gets **narrower**: text the user asked to
*have* still goes to the clipboard and the caption says so. The reader is for
text the user asked to *read*. `classifyPresentation` decides between caption
and reader; the model does not choose its own surface.

---

## 5. Keep — storage that takes what it is given

### The problem, in the user's words

> "Got some inspirational video for x, y, z purpose. Want to save it so that I
> can retrieve it later."

The store itself is already general — arbitrary `mimeType`, an attachment
pipeline, encryption. Two things block the use case:

1. **A 25 MB cap** (`DEFAULT_MAX_MANAGED_BYTES`) — under a video.
2. **The only way in is a capture handle** — a screenshot taken mid-utterance,
   hardcoded `image/png` at the call site in `init.ts`. There is no path from
   "this file the user is pointing at" to a stored attachment.

### Decision

**The Agent still never handles a path it composed.** That boundary stays; it is
what stops a composed path reaching the shell. What changes is that the *app*
can resolve a **user-designated** file — the frontmost Finder selection, or a
file on the clipboard — into the same opaque handle the capture path mints.

- Raise the managed cap, with a spill-to-reference above it: past the ceiling,
  keep a `reference` to the original location rather than refusing outright.
  Refusing to remember something because it is large is the wrong answer.
- Infer mime beyond the five image types; carry the declared one when given.
- Most "save this video" is a **link**, and `references` already carries URLs —
  what is missing is that nothing tells the Agent to use it. That is a
  constitution sentence, not a subsystem.

---

## 6. Order, and why

```
§1 act ──> §2 know ──> §3 continue
                └────> §4 answer
§5 keep (independent)
```

§1 first because a refusing Agent makes the other four unobservable. §2 before
§3 because you must find a session before you can resume it, and because §3's
cross-harness seed *is* §2's summary. §4 after §2 because session summaries are
the first answers that genuinely do not fit a caption. §5 is independent and
sized accordingly.

## 7. What this design deliberately does not do

- **No new regexes over what the user said.** `5ae30b6`/`75014ad` deleted every
  one; nothing here reintroduces intent matching.
- **No background model calls on a timer.** Summaries are lazy and cached.
- **No writing into the user's sessions.** The index only reads; continuing a
  session goes through `dispatch`, which is the same path the Remote key uses.
- **No second chat surface.** The reader in §4 renders one answer and is
  dismissed; it never accumulates a transcript.
