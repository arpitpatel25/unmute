# Un-nerfing session retrieval — requirements

Status: implementing. Branch `arpit/unmute-astra-remove-terminal`.

This is the exhaustive list of what must be true when the work is done. It is
not an implementation plan and not an ordering; it is the set of statements the
implementation is checked against.

## 0. Why

On 2026-09-06 the Agent was asked to reopen a session. It called
`sessions_search` 22 times over 144s and $2.15 and never found it. The session
was on disk, indexed, and its distinguishing sentence sat at byte 30,433,728 of
a 33.9 MB transcript. Three caps in `agent/sessions/catalog.ts` made the miss
arithmetically certain:

- `WINDOW_BYTES = 128 * 1024` — head 64 KB + tail 64 KB, middle discarded.
  0.369% coverage of that file. The sentence was never read.
- `if (matches.some(count => count === 0)) continue` — every query token must
  appear. All seven real queries died on ordinary words (`opened`, `wrong`,
  `child`, `parent`).
- `MAX_FILES = 2_000` per root against 3,087 Claude transcripts on disk — ~1,087
  never enumerated, in `readdir` order, not recency.

A vanilla Claude Code session found it with one grep. That is the regression:
Unmute made its host harness *less* capable. Nothing in this repo may do that.

## 1. Governing rules

- **R1. Never wrap readable data in a tool.** A tool over data the model can
  already `Read`/`Glob`/`Grep` caps it at the queries the schema author
  imagined. Ship data as files instead.
- **R2. Never write procedure into the constitution.** Describing a resource
  ("the index is at X and contains Y") adds an option. Prescribing a method
  ("start with X, then Y") removes one. Only the first is allowed.
- **R3. Nothing derived from a transcript may be model-written.** Only
  losslessly extractable facts are recorded. No summary, no title, no topic,
  no `about`/`done`/`standing`.
- **R4. Constrain the irreversible act, not the reasoning.** Guards live inside
  `resume`/`fork`/`close`, never in prose.
- **R5. A tool earns its place only if the harness structurally cannot do it.**
  Spawning a `--resume` process, making a card, closing a card, knowing what is
  live in the app. Nothing else.
- **R6. Fail loudly.** No retrieval path may return a confident empty result
  after reading a fraction of its input. That silence was the actual defect.

## 2. Removals

- **2.1** Delete `agent/sessions/catalog.ts` and `agent/sessions/catalog.test.ts`.
- **2.2** Delete the `sessions_search` tool from `agent/capabilities/sessions.ts`
  — its `ToolDefinition`, its dispatch branch, and `search` from
  `SessionAdapters`.
- **2.3** Delete `searchAgentSessions()` and the `searchSessionCatalog` import
  from `remote/init.ts`; drop `search:` from the `SessionsCapability` wiring.
- **2.4** Drop `search:` from the `SessionsCapability` wiring in
  `remote/runtime/agent-service.ts`, and the `sessions.search` host method it
  bridges to.
- **2.5** Remove every `sessions_search` mention from `agent/constitution.ts`.
- **2.6** No replacement query tool is added. Retrieval is `Grep`/`Read` over
  files, full stop.

## 3. The user-turn index (new)

### Shape

- **3.1** Two files under `~/.unmute/remote/session-index/`:
  - `sessions.jsonl` — one line per session, stable metadata only.
  - `turns.jsonl` — append-only, one line per user turn.
- **3.2** `sessions.jsonl` line:
  `{ id, provider, cwd, provenance, parentSessionId?, path, firstAt, lastAt, turns }`
  where `provenance` is `"main" | "subagent" | "unknown"` and `turns` is a count.
- **3.3** `turns.jsonl` line: `{ s, t, o, text }` — session id, epoch ms, byte
  offset of the source line in the transcript, verbatim text.
- **3.4** Rationale for per-turn lines rather than one grouped record per
  session: turns must be *appended* as they arrive, and a grouped record would
  require rewriting a session's line on every new turn. Per-session metadata
  still lives once, in `sessions.jsonl`. The only duplication is `s`, which is
  also what makes a `grep` hit on `turns.jsonl` self-describing.
- **3.5** `text` is byte-for-byte what the user said. Never trimmed to a
  summary, never re-cased, never truncated below 8 KB per turn. Turns longer
  than 8 KB are truncated with an explicit `"trunc": true` field so a reader
  knows to go to `o` in the transcript.
- **3.6** `o` exists so a hit is a **pointer into the raw transcript**. It is
  the byte offset of the start of the source JSONL line.

### Contents

- **3.7** Only genuine user turns. Excluded: assistant turns, tool calls, tool
  results, sidechain/subagent turns (`isSidechain === true`), and synthetic
  wrappers — anything whose text begins with `<task-notification`,
  `<system-reminder`, `<local-command-`, or `Caveat:`.
- **3.8** Both providers: Claude (`~/.claude/projects`) and Codex
  (`~/.codex/sessions`). Provider-agnostic by construction — it tails files,
  it does not integrate with a harness.
- **3.9** Subagent sessions ARE indexed, with `provenance: "subagent"` recorded.
  They are never omitted (that would hide evidence); they are labelled so a
  reader can filter. The refusal to act on them lives in `requireMainSession`.
- **3.10** Provenance is computed by the existing
  `readSessionProvenance`/`provenanceFromPrefix` in `agent/sessions/locate.ts`.
  No second implementation.

### Maintenance

- **3.11** Append-only tailing. Per-file byte cursor persisted in
  `cursors.json`. On change, read only `[cursor, size)` and append the new
  turns. A transcript is never re-read whole after its first pass.
- **3.12** Partial trailing lines are not consumed: the cursor advances only to
  the last complete `\n`. A half-written JSON line must never be parsed or lost.
- **3.13** Watch both roots at the **directory** level, recursively, debounced
  (250 ms). Never one watcher per file — there are ~4,000.
- **3.14** On startup, reconcile: for every transcript, compare stored cursor to
  current size and catch up on what moved while the app was closed.
- **3.15** If a file is **smaller** than its stored cursor, it was rewritten or
  compacted — discard its cursor and re-read it whole.
- **3.16** First-ever build walks both roots with **no file-count cap**. The
  2,000 cap is a bug, not a budget.
- **3.17** Zero model calls. No Claude/Codex session, no tokens consumed, ever.
  This subsystem must run identically whether or not the user ever speaks.
- **3.18** Writes are crash-safe: appends are `O_APPEND`; `sessions.jsonl` and
  `cursors.json` are rewritten via the existing `writeFileAtomic`.
- **3.19** Bounded work per tick so a burst cannot block the main process.
  Files are processed sequentially with an explicit byte budget per pass.
- **3.20** Index staleness must be sub-second for a live session, because the
  most likely referent of "that thing" is the most recent thing.
- **3.21** Corrupt or unparseable lines are skipped individually, never aborting
  a file or the pass.
- **3.22** The index is a cache and is safe to delete. Deleting it must cause a
  full, correct rebuild and nothing else.

### Exposure

- **3.23** The index is **not** exposed as a tool. It is a file the Agent reads
  with the `Read`/`Grep` it already holds.
- **3.24** Its location, contents, and **limits** are stated in the constitution
  as fact — "user turns only, no assistant text, kept current" — so the Agent
  knows on its own when to go past it to the raw transcripts.

## 4. Tools added

Both satisfy R5 — the harness cannot do either.

### `sessions_open`

- **4.1** Lists Unmute's live/open sessions, because there is no point resuming
  something already open, and the Agent cannot otherwise see the app.
- **4.2** Per entry: `taskId`, `sessionId`, `provider`, `cwd`, `title`,
  `workspace`, `state`, `live` (PTY/process alive), `updatedAt`.
- **4.3** `live: true` means the executor is alive; `state` is the UI state
  (`processing`/`needs-user`/`done`/`failed`/`stuck`). "Open" is defined as
  **present as a card in Unmute** — the union of live tasks and tasks still
  blocked on the user. Both are returned, with the flags to tell them apart.
- **4.4** `consequence: 'read'`. No arguments beyond an optional `limit`.
- **4.5** Returns `[]` when nothing is open — never an error.

### `session_close`

- **4.6** Removes a card/session from Unmute. This is the undo. Its absence is
  what forced the Agent to tell the user *"I don't have a tool that closes or
  stops a task"* and hand the cleanup back to them.
- **4.7** Takes `taskId` (the card), not a provider session id — closing is an
  Unmute-object operation.
- **4.8** Backed by `TaskManager.remove(id)`.
- **4.9** `consequence: 'reversible-write'` — it requires an active explicit
  interaction (the user is actually talking) but no intent flag. `destructive`
  would demand a matching `intent` on the interaction, which would break the
  whole point: the undo must fire on "no, the other one" and nothing more. The
  class is also honest — the card is removed, the transcript is untouched, and
  the session can be resumed again by id.
- **4.10** It removes the **card**. It does not and cannot delete the transcript
  on disk, and its description says so — a false claim of deletion is worse
  than the gap it fills.
- **4.11** Idempotent: closing an unknown or already-closed id succeeds quietly
  rather than erroring, so a correction never fails twice.
- **4.12** It is a *model* capability invoked by ordinary conversation ("no, the
  other one"), never a chore the user is asked to perform.

## 5. Guards (code, not prose)

- **5.1** `requireMainSession` remains the execution boundary on `resume` and
  `fork`. Unchanged; it already refuses subagents and names the parent
  candidate.
- **5.2** Discovery filtering is never treated as sufficient — a directly
  supplied id is still checked at the boundary.
- **5.3** `session_close` needs no provenance check: removing a card is safe
  regardless of what the card points at.

## 6. Constitution changes

- **6.1** Delete the sentence *"Start with `mcp__unmute__sessions_search` for a
  bounded on-demand projection…"* — this is the R2 violation that caused the
  incident.
- **6.2** Delete *"`mcp__unmute__sessions_search` exposes only confirmed main
  sessions"* from the ONLY MAIN CONVERSATIONS rule; keep the rest of that rule,
  which is about provenance and is correct.
- **6.3** Delete the `sessions_search` clause from EVERY HANDOFF HAS A TITLE AND
  WORKSPACE; the title/workspace requirement itself stays.
- **6.4** Resolve the existing internal contradiction: one rule says *"There is
  no pre-built summary file — one existed and was withdrawn, so do not look for
  it"* while another mandates `sessions_search`. After this change there is
  exactly one retrieval paragraph.
- **6.5** The replacement retrieval paragraph **describes and does not
  prescribe**: where transcripts live, where the index lives, what the index
  contains, what it omits. No ordering, no "start with", no fallback ladder.
- **6.6** Add one sentence naming `mcp__unmute__sessions_open` and
  `mcp__unmute__session_close` as facts about what the Agent can see and undo —
  not as a procedure for when to use them.
- **6.7** Every tool named in the constitution keeps its `mcp__unmute__` prefix
  (existing test enforces this).
- **6.8** No summary vocabulary is reintroduced anywhere.

## 7. Tests

- **7.1** `agent/constitution.test.ts`: drop `sessions_search` from `TOOL_NAMES`
  and from the raw-search-fallback assertion; add `sessions_open` and
  `session_close`; assert `AGENT_PRINCIPLES` does **not** match
  `/sessions_search/`; assert it does not match a "start with" ordering.
- **7.2** `agent/capabilities/sessions.test.ts`: update the tool-list assertion
  to `['workspaces_create', 'workspaces_list', 'session_resume', 'session_fork',
  'sessions_open', 'session_close']`; remove the `sessions_search` validation
  cases; add validation + dispatch cases for both new tools.
- **7.3** New `agent/sessions/turn-index.test.ts` covering:
  - a Claude transcript and a Codex rollout both index their user turns
  - assistant turns, tool results, sidechain turns and synthetic wrappers are
    excluded
  - **a turn 30 MB into a file is indexed** — the regression test for the
    128 KB window
  - appending to a transcript adds only the new turns (cursor honoured, no
    re-read, no duplicates)
  - a truncated trailing line is not consumed until complete
  - a shrunk file is re-read from zero
  - provenance is recorded, and subagent sessions are labelled not dropped
  - a corrupt line is skipped without aborting the file
- **7.4** The regression that started this is named in a test comment with its
  numbers, so nobody reintroduces a window.
- **7.5** Existing `locate`, `resume`, `service`, `sources` tests keep passing
  untouched.

## 8. Out of scope (explicitly not in this commit)

- Cron/scheduled jobs and event triggers, and their job records.
- Projects/workspace auto-assignment.
- The daily overview surface.
- Any ranking, scoring, or embedding over the index. It is a file; `grep` ranks
  nothing and that is the point.
- Removing the model-written summaries that other subsystems (curator) may
  still produce for their own purposes — this commit only guarantees none are
  on the retrieval path.
