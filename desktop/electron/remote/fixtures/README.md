# Transcript fixture — verified Claude Code JSONL shape

`sample-transcript.jsonl` is a **shape-faithful** fixture for the trace reducer
(Task 8). It is hand-built from the real on-disk record schema (verified against
live Unmute executor transcripts under
`~/.claude/projects/-Users-zodpatel--unmute-remote-local-<taskId>/<session>.jsonl`)
rather than a copy of a real session — so it carries the exact structure without
committing the user's private task content/outputs.

## Verified record schema (as of 2026-06-27, Claude Code on this machine)

Each line is one JSON event. Relevant fields:

- `type`: one of `user`, `assistant`, `system`, `mode`, `permission-mode`,
  `attachment`, `file-history-snapshot`, `last-prompt`, `ai-title`, … Only
  `assistant` and `user` carry tool/turn content; the rest are noise to DROP.
- `message.role`: `assistant` | `user`.
- `message.content`:
  - a **string** for a plain user prompt, OR
  - an **array of blocks** for assistant turns and tool results.
- Block types inside `message.content[]`:
  - `thinking` — `{ type, thinking }` (assistant's private reasoning).
  - `text` — `{ type, text }` (assistant's visible text).
  - `tool_use` — `{ type, id, name, input, caller }`. `name` is the tool
    (e.g. `Bash`, `Read`); `input` is the tool's args object.
  - `tool_result` — `{ type, tool_use_id, content, is_error }`. `content` is
    a **string** (sometimes an array of `{type:'text',text}`); `is_error` is a
    boolean.
- `usage` / `cache_creation_input_tokens` / token metadata — DROP.

## Path encoding (verified)

The executor cwd `/Users/<u>/.unmute/remote/local/<taskId>` is encoded by Claude
as the project-dir name `-Users-<u>--unmute-remote-local-<taskId>` — every `/`
and `.` becomes `-` (so `/.unmute` → `--unmute`), and the taskId UUID is the
suffix. The locator (`locateTranscript`) globs by taskId, so it is robust to the
exact rule; this note records what was observed.

The fixture also includes one deliberately malformed line to assert the reducer
tolerates non-JSON lines.
