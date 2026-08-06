# The natural session — design

**Status:** implemented on `arpit/natural-session`.
**Date:** 2026-08-06.
**Baseline:** `a984063`.

Unmute stops modifying the Claude Code session it starts. Everything it needs to
know is observed from outside.

---

## 1. Why

Two user complaints, and they are different problems.

**"My terminal is full of Unmute's scaffolding."** A trust problem. Every task
began with a 244-line operating contract, and on project-bound spawns it arrived
as a **user turn** — so the transcript the user watches was mostly us.

**"Claude Code works worse under Unmute than on its own."** A product-integrity
problem, and the serious one: we sell a surface on top of an executor, and a
surface that degrades its executor has negative value.

The second complaint was fair. Unmute did not *add to* a session, it **modified**
one, in eight ways:

| # | What we changed |
|---|---|
| 1 | pinned `--model` to our default (`sonnet`), overriding the user's own |
| 2 | `--chrome` on unconditionally, in sessions that never open a browser |
| 3 | added our MCP server (fine — a capability, not a constraint) |
| 4 | injected the 244-line contract, as CLAUDE.md or inline as a user turn |
| 5 | copied skills into `.claude/skills/` and wrote a `PROFILE.md` |
| 6 | injected "memory leads" from a librarian parked since 2026-08-03 |
| 7 | a `Stop` hook that **blocked the end of every turn** to demand paperwork |
| 8 | tmux at a fixed size, plus unsolicited Enters |

(1) alone explains the complaint: a user whose own default is Opus silently ran
every Unmute task on a weaker model, with nothing telling them. (4) was not just
volume — it installed a *different personality* ("act, don't ask", "the browser is
your default tool", "scroll and paginate the full scope") onto careful
engineering work, stated with more force and more words than the actual request.

## 2. The principle

> **Unmute observes a Claude Code session. It never modifies one.**
> Diff a session Unmute started against one the user started themselves. **The
> only difference should be the task text.**

It is a test, not a memo — `session-policy.test.ts` asserts the launch argv
against `ALLOWED_FLAGS`. Every item in the deleted contract was added for a good
reason; that is exactly how it grew, and how it would grow back.

## 3. What replaced what

| Was, in the session | Is now, outside it |
|---|---|
| "write status.json with this shape" | `writeStatusFile()` — our code |
| "write it atomically, tmp then rename" | our code; the failure mode is gone |
| "update it on a cadence" | `PostToolUse` hook |
| "classify as info/navigate/watch/consume/act" | `deriveCategory()` from surface + evidence |
| "put the full answer in `result.detail`" | Claude's own final reply, from `Stop` |
| "say `ready` vs `done`" | task kind + a trailing question |
| "ask the user when blocked" | a trailing question, or `Notification` |
| "confirm irreversible actions" | the user's own permission mode |
| "read `./PROFILE.md`, jot recipes" | deleted — the librarian is parked |
| the whole browser/thoroughness/posture policy | deleted |

**~3,530 tokens → ~200**, and the 200 sit in the system prompt rather than
impersonating the user's request.

## 4. Mechanism

**Hooks ride on `--settings <our file>`.** Claude Code loads it as *additional*
settings and merges hooks across levels, so nothing is written into the user's
repo. This fixes the backwards part of the old design: hooks were installed only
for scratch spawns — because writing `.claude/settings.json` into a user's
project was unacceptable — which left **project-bound sessions, the longest-lived
ones, with no instrumentation at all** and `verifyDispatch` disabled there.

**Five events, all `async`, all reporting OUT:**

| Event | Replaces |
|---|---|
| `UserPromptSubmit` | the marker-file mtime `verifyDispatch` used to stat |
| `PostToolUse` | the heartbeat, and the poll-time `stat` it required |
| `Stop` | the entire self-report — it carries `last_assistant_message` |
| `Notification` | the ask channel |
| `SessionEnd` | inferring death from a dead PTY |

Transport is a `curl` one-liner: hooks get their JSON on stdin, so
`--data-binary @-` forwards it verbatim — no `jq`, no wrapper script, nothing to
keep in sync with the event schema, and it works on every Claude Code version.
`-m 2` means an unreachable Unmute costs 2 seconds once, never a hang.

**Nothing blocks.** The old `Stop` hook returned `{"decision":"block"}` up to
twice per turn, interrupting the model at the moment it was concluding. Hooks now
only report; a test asserts no hook can return a decision.

## 5. Reading the result

Claude Code already separates prose from noise, structurally, on disk. A session
transcript is a JSONL whose assistant entries carry typed content blocks:
`text | thinking | tool_use | tool_result`. Measured on a real 1.6 MB session,
**`text` was 1.9% of the file**. So `transcript.ts` filters for it — no model
call, no ANSI stripping, no summarization.

The consequence is the nicest part of the design: **the model's final reply IS
`result.detail`**, verbatim. It is better prose than anything we could have asked
it to cram into a JSON field, because it was written for a human to read.

## 6. The honest trade

Self-report was authoritative; observation is inferred. The rules are therefore
conservative, and one rule runs through all of them: **when the observer cannot
tell, it says so.** A card reading "finished — couldn't tell if it needs you" is
honest; a confidently wrong `done` silently drops work out of the user's queue.

Two examples of the conservatism:
- a trailing `?` counts as a question only if the line is short (≤200 chars) and
  genuinely last — mislabelling a finished task as blocked parks it forever
- a `Notification` becomes `needs-user` only for `permission_prompt`; an idle
  nudge must never park a working task

Where precision genuinely matters, `unmute_status` exists as an **optional** MCP
tool: an exact URL, or "I'm blocked" when the reply doesn't read like a question.
Its description says it is optional, deliberately — the moment it reads as
mandatory we have rebuilt the reporting contract one tool call at a time.

## 7. Follow-ups

`followUp()` used to re-send the whole payload — status path, recipe path, "Act
now, follow the contract" — wrapped around **every sentence the user spoke, for
the life of the session.** The stated reason was real: without it the model
answered conversationally, never wrote status, and the task went stuck.

That reason is gone. The `Stop` hook reports the turn ended and hands us the
reply, so there is nothing left to re-anchor the model to. **A follow-up is now
exactly what the user said.**

## 8. Launch changes

- **`--model` only when the user picked one.** Absent means absent, so the
  session runs on the user's own default. Downstream (D6) an absent model already
  meant "render the agent alone, never invent a value".
- **`--chrome` follows the task.** A project-bound session never gets it; a web
  surface always does; an unclassified one-off keeps it (spoken errands are
  usually web-shaped).
- **`--append-system-prompt`** carries the four-line preamble. Framing belongs in
  the system prompt, never in a user turn.
- **Nothing is written into the session's working directory.** Asserted by test.

## 9. What was deliberately NOT done

- **Codex and Claude-desktop backends are untouched.** They have their own state
  paths and never had a contract.
- **The status file stays.** Only its author changed, so the wall, notch, crank,
  queue, groups, shelf and router are all unmodified — the blast radius is one
  layer.
- **The librarian/curator stay parked.** `skills.ts` and `recipe-store.ts` remain
  on disk for when the curator returns; dispatch simply no longer calls them.
- **The router is unchanged.** It runs outside the task session and costs its
  quality nothing.

## 10. Still worth doing

- **Verify `--settings` MERGES rather than replaces** a project's own settings on
  a real machine. The flag says "load *additional* settings from" and the hooks
  docs say levels merge, but if it replaced them we would be silently disabling a
  user's own hooks — the exact class of harm this change exists to remove.
- **Measure the complaint at the source:** `/context` in a live task, and ask a
  complaining user what `/model` says. If it is Opus, item (1) was the whole thing.
- **Watch the observer's accuracy** across real sessions, especially
  question-detection. The `unmute_status` tool is the escape hatch if a case
  proves undecidable from outside.

---

# Part 2 — the latest exchange on the stage

Added the same day, on top of the above.

## 11. Why

The stage was an **either/or**. `StageView.swift` branched: a driven backend
(Codex, Claude desktop) rendered a `ConversationPanel` *because it has no PTY*,
and a Claude CLI task rendered a raw terminal and **nothing else**. So the one
question a returning user actually has — *what did I ask, and what came back* —
was answerable only by reading scrollback in a terminal, which is exactly the
work the wall exists to save them.

## 12. Both sides, from Claude's own record

`Task.conversation` stops meaning "what a driven backend has instead of a
terminal" and starts meaning "this task's conversation", for all three backends.
A Claude session's turns come from its transcript, not from scraping the screen.

The user side turned out cleaner than the assistant side. Claude Code records
user turns in two shapes, and they are trivially distinguishable:

| `message.content` | Count in a real session | What it is |
|---|---|---|
| a **string** | 17 | a human talking |
| an **array** | 194 | `tool_result` blocks being fed back |

So the filter is `typeof content === 'string'` — no heuristics, no keyword
matching. `toolUseResult` on the entry is an independent second tell.

Also excluded: `isSidechain === true` (subagent turns — without this one Task
call floods the panel with an exchange the user never had), and the metadata
line types (`system`, `attachment`, `file-history-snapshot`, `ai-title`, `mode`,
`last-prompt`).

## 13. A headline, not a transcript

`ExchangeStrip` is deliberately **not** `ConversationPanel`:

| | `ConversationPanel` | `ExchangeStrip` |
|---|---|---|
| for | a backend with no terminal | a backend that has one |
| shows | the whole thread, scrolling | the latest exchange only |
| owns | the full pane | a bounded height above the terminal |

Keeping it to one exchange is what stops it becoming a re-rendered conversation —
the bright line in `ORCHESTRATE-VISION.md` §3. Everything before this exchange is
history, and history is what the terminal below is for.

It renders **nothing at all** when a task has no turns, so a fresh task looks
exactly as it did before.

## 14. Optimistic, then true

`dispatch()` and `followUp()` set the conversation to the user's message
immediately; `turn-ended` replaces it from the transcript. A card that is blank
for the first thirty seconds of every task reads as broken — and the user already
knows what they said.

## 15. The composer

`CodexComposer` became `StageComposer` with a `placeholder`, and `CodexComposer`
is now a thin wrapper keeping Codex's own wording. Claude tasks get one too.

**This touches a stated bright line** — *"no text input on the stage"* — so it is
a deliberate decision, not drift. The line was already crossed once for driven
backends, where a composer was the only way in. The argument for extending it:
when the stage is already open in front of you, being sent into a PTY to type one
line is the friction this surface exists to remove. Voice stays primary, and the
placeholder says so before it names the field: *"Reply — or hold right ⌥ and
speak"*.

## 16. Still to verify

- **Images.** There were zero `image` blocks in the transcript I measured. The
  block type exists in the content schema (`source.type: "base64"`), but the
  render path should be checked against a real pasted screenshot before being
  built on.
- **Live smoke.** Same as Part 1: no real session has driven this UI yet.
