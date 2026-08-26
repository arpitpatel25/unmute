# The Unmute Agent — rework plan

> Implements `../specs/2026-08-26-agent-architecture-decisions.md` (D1–D12).
> Every task cites the decision it serves. Nothing here is a new decision; if a
> question arises that the decisions do not answer, it goes back to discussion
> rather than being resolved in code.
>
> Written against the branch as it stands at `282581e` — five modules shipped,
> Act and Answer unchanged by this plan.
>
> **This is one delivery.** The numbered sections are build order — what depends
> on what — not stages to ship separately or stop between.

---

## What exists today, and what happens to it

| File | Today | Fate |
|---|---|---|
| `agent/sessions/scan.ts` | Discovery + bounded transcript read | **Rework** — reuse `transcript.ts`, add cursor |
| `agent/sessions/transcript-facts.ts` | Own parser, duplicates `transcript.ts` worse | **Delete** — D5 |
| `agent/sessions/store.ts` | JSON cache keyed `(path, mtime)` | **Rework** — cursor + summaries, D3/D6 |
| `agent/sessions/digest.ts` | Per-turn injected digest | **Delete** — D8 |
| `agent/sessions/search.ts` | Ranking over facts | **Delete** — D1, becomes a file the Agent greps |
| `agent/capabilities/sessions.ts` | 5 tools | **Reduce to 1** (`session_resume`) — D1/D10 |
| `agent/capabilities/notetaker.ts` | 4 tools | **Unchanged** — metadata is in SQLite, see 5.2 |
| `agent/capabilities/handoff.ts` | `task_create`, `task_status` | **Amend** — add `context`, drop `sourceSessionIds` — D11 |
| `agent/controller.ts` | Injects the digest | **Amend** — remove injection — D8 |
| `agent/constitution.ts` | No `Glob`/`Grep`; no ladder | **Amend** — restore fallback, add ladder — D9 |
| `agent/capabilities/memory.ts` | 9 tools | **Unchanged** — D1 worked example |
| `agent/capabilities/delivery.ts` | 4 tools | **Unchanged** |
| `agent/caption.ts`, notch Swift | Held caption | **Unchanged** |

Net: **26 tools → 21.** (The plan first estimated 17; the notetaker readers
turned out to be unreachable rather than duplicative — see 5.2.)

---

## 1 · Reuse the real transcript parser  · D5

**1.1** Extend `transcript.ts` with whatever the summariser needs that it does
not already expose, keeping its existing rules intact: string-content = human,
array = tool results, `toolUseResult` as second tell, `isSidechain` excluded.
Add Codex support alongside Claude, since `transcript.ts` is Claude-shaped today
and Codex carries the same conversation in `response_item` / `event_msg`.

**1.2** Rewrite `scan.ts` to call it. Delete `transcript-facts.ts` and its
tests; port any case it covers that `transcript.ts` does not — notably the
Unmute-framing filter, the fork-boilerplate filter, and identity recovery from
an oversized `session_meta` prefix.

**Check.** The existing 11 `scan.test.ts` cases still pass. Re-run the real-disk
probe: 1,061 discovered, 81 in window, and the count carrying a usable opening
must not fall.

---

## 2 · Cursor and the summary record  · D3, D4, D6, D7

**2.1 — Cursor store.** Per session: transcript path, harness, conversation id,
`lineOffset`, `lastSummarisedAt`, and a `partial` flag (D6). Keyed by
conversation identity, not path, so a resumed session advances the same cursor —
follow `curator.ts`'s `convKey` reasoning (`sessionId ?? taskId`).

**2.2 — Summary shape.** Structured, not prose:
`about` (revisable) · `done` (**append-only items**) · `standing` (replaced) ·
`touched` (accumulating). Plus `date`, `harness`, `project`, `sessionId`, `path`.

**2.3 — Summariser.** Given a cursor and new turns, produce an updated summary.
Reads **user turns and assistant prose only** (D5). Appends to `done`, replaces
`standing`, revises `about` from *(old about + new items)* — **never re-reading
the transcript** (D6).

**2.4 — First-pass cap.** Beyond a threshold, summarise from the most recent N
turns and set `partial: true` (D6).

**2.5 — Rollup.** When `done` grows past a bound, collapse oldest items into one
line. Targeted, never a re-read.

**2.6 — Idle trigger.** Summarise a session quiet for a couple of minutes (D7).
No clock sweep.

**2.7 — Eligibility.** Not `derived`, and at least a floor of real user turns
(D4). **Not** filtered on task kind.

**2.8 — Retention.** Generate within the window; **keep summaries forever** (D3).

**2.9 — Spend controls.** Bounded concurrency, first-pass cap, and an env kill
switch shaped like `UNMUTE_AGENT_RUNTIME` (D12).

**Check.** Unit tests for: append-only `done` never rewrites an existing item;
`about` revision never opens the transcript; cursor advances exactly once per
turn batch; a resumed session reuses its cursor; `partial` is set past the cap;
eligibility excludes derived and includes a non-Unmute terminal session.

---

## 3 · The record on disk, and pointing at it  · D1, D2, D8

**3.1 — Write the record.** A flat, dated, human-readable file (or one file per
day) under `unmute-agent/sessions/`, mode `0600`. Every eligible session in the
window, each stamped with its date. **No tier structure** (D2).

Organise so **one read is usually enough** — this is what answers the round-trip
objection to files-over-tools (D1).

**3.2 — Delete the digest.** Remove `digest.ts`, its tests, `sessionDigest()`
from the controller options, and the injection in `providerTranscript()` (D8).

**3.3 — Replace with a pointer.** One short constitution passage: the record
exists, it is at this path, it covers the last few days of every session on the
machine, read it when they refer to past work.

**Check.** A controller test asserting the turn text no longer carries a
session list. Measure the per-turn token delta and record it.

---

## 4 · The ladder, and the regression it repairs  · D9

**4.1 — Restore the fallback.** The constitution must again name `Glob`, `Grep`
and `Read` as the final rung. It currently mentions them **zero times** while
they remain in the allowlist (D9).

**4.2 — Write the ladder.** Record → summaries → raw disk. An explicit older
reference skips ahead. "I could not find it" is only true after the last rung.

**4.3 — Scope it, and seam it against memory retrieval.** The ladder applies to
questions about **past work only**. Add the explicit seam: a question about what
is *saved* stays memory-only, and an empty memory is an honest answer, not
permission to search (D9).

**Check.** A constitution test asserting `Glob`/`Grep` are named and the ladder
appears in order — the same shape as `controller-transcript.test.ts`, which
exists because two instructions disagreed. Add eval cases: a vague past-work
reference reaches the record; an explicitly old reference skips to search; a
memory question does **not** trigger a disk crawl.

---

## 5 · Collapse the tool surface  · D1

**5.1 — Sessions: 5 → 1.** Keep `session_resume` (spawns a process — the app
must act). Delete `sessions_list`, `sessions_search`, `session_read`,
`session_continue_in`.

**5.2 — Notetaker: NO CHANGE.** *Corrected during implementation.* The plan
assumed meetings were files the Agent could read. Half of that is true — each
meeting's transcript is plaintext at
`~/Library/Application Support/unmute/meetings/<id>/transcript.json` — but the
**metadata lives in the `meetings` table of `unmute.db`**, and the Agent has no
shell and no SQLite. It cannot list meetings, cannot search their titles, and
cannot map "the meeting about pricing" to a directory uuid.

By D1's own test the data is unreachable, so all four stay tools. The principle
held; the assumption about where the data lived did not.

(If these should collapse later, the move is to have Unmute write a meetings
record file the way it writes the session record — then the same reasoning
applies. That is a separate piece of work, not a deletion.)

**5.3 — History.** Keep `unmute_history_copy` (clipboard + image restoration).
Determine whether the capture store is plaintext and reachable; if it is,
`unmute_history_search` becomes an instruction. **If that is not clear from the
code, it comes back to discussion — it is not settled here.**

**5.4 — Instructions to replace each deletion.** Every removed tool needs a
constitution sentence naming the file, its shape, and when to read it. A
deletion without its replacement instruction is a capability regression.

**Check.** Registry tests updated. An eval per removed tool proving the Agent
still performs the task by reading the file.

---

## 6 · Seeding replaces cross-harness plumbing  · D10, D11

**6.1 — `task_create` gains `context`.** Separate from `intent`; `intent` keeps
its wording and cap unchanged; `context` is framed as background to get familiar
with, never instructions, with its own generous cap (D11).

**6.2 — Drop `sourceSessionIds`.** It pastes bare UUIDs into the prompt
(`Start from these earlier sessions: <uuid>, <uuid>`) with no content. Superseded
by the Agent composing `context` itself (D10, D1).

**6.3 — Delete `session_continue_in`.** Its formatter — `It began: …` /
`It last said: …` — is a fixed template doing work the Agent does better. The
operation becomes: read the summaries, compose `context`, call `task_create`
with the chosen provider (D10).

**6.4 — Instruct the general operation.** Seeding from N sources is ordinary;
native resume is the narrow same-harness single-source case. Include the honesty
wording: *"started a Codex session from those three"*, never *"moved them"*
(D10).

**Check.** Eval cases: three sessions consolidated into one new session on a
named harness, with real content in `context`, not identifiers; same-harness
single-source prefers `session_resume`; the reply never claims a thread moved.

---

## 7 · Full verification

- `npm test` — the whole suite, not only `agent/`.
- `npm run typecheck` — no new errors over the recorded baseline.
- The real-disk probe re-run and its numbers recorded.
- **`npm run eval:agent` actually executed.** It never has been; the four cases
  written for the 25 August failure remain unverified, and this plan adds more.
- A signed, notarised test build, and the vague-reference case tried by voice.

---

## Build order

This is ONE delivery, not a release schedule. The numbering is build order and
nothing else — it records what cannot be written before what:

- 2 needs 1: the summariser has no parser until the parser is shared.
- 3 needs 2: there is nothing to write into the record until summaries exist.
- 5 needs 3 and 4: a tool may only be deleted once the instruction replacing it
  is in the constitution. Deleting first is a capability regression.
- 4 and 6 have no dependants and can be written at any point.

Nothing here is a checkpoint to stop at, and none of it ships alone.

## Open — returns to discussion, not decided here

- Whether `unmute_history_search` can become an instruction (5.3).
- Exact window length, idle threshold, first-pass cap, rollup bound, and spend
  ceiling. D2/D6/D7/D12 fix the *shape*; the numbers are to be chosen together.
- Storage ingestion (Keep) remains open from the 26 August design's §9.
