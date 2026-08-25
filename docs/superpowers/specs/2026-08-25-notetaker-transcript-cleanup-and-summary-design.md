# Meeting notetaker — transcript cleanup + auto-summarization

**Status:** design-complete, not yet built.
**Date:** 2026-08-25
**Branch:** `arpit/notetaker`
**Builds on:**
- `docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md` (capture)
- `docs/superpowers/specs/2026-08-24-meeting-notetaker-persistence-ui.md` (raw transcript, storage, Meetings UI — this spec extends both the storage layer and the UI it defined)
- `electron/remote/agent/capabilities/notetaker.ts` + `constitution.ts` (the Unmute Agent's existing on-demand `notetaker_read`/`notetaker_search`/`notetaker_list`/`notetaker_open` tools — this spec changes what data those tools read, not their shape)

Today a meeting produces exactly one artifact: the raw Whisper transcript, verbatim STT errors and all, with a title that's just the first thing said truncated to length. The Agent can be asked about a meeting on demand, but nothing runs automatically, and everything — the Agent included — reads the same unedited raw text. This spec adds two automatic passes over every new meeting (transcript cleanup, then note generation), run through the user's own local Claude Code or Codex CLI rather than a managed LLM call, plus the settings and UI to control and view them.

## 1. Scope

**In scope:**
- A local, headless (non-interactive) invocation of Claude Code CLI or Codex CLI — a new capability, distinct from the existing interactive Task/PTY system, which explicitly forbids headless flags (`pty-session.ts`: "NEVER include a headless flag (-p / --print)").
- Two sequential passes per meeting, both gated by one settings toggle:
  1. **Cleanup** — corrects STT errors in the raw transcript, segment-by-segment, preserving every timestamp/channel/speaker exactly.
  2. **Summarization** — reads the *cleaned* transcript only, produces a real title, summary, key points, decisions, and action items.
- Settings: one enable/disable toggle (default off), a provider picker gated on actual local availability, and two independently editable prompts (cleanup, summary) each with a reset-to-default.
- Failure handling that never blocks the rest of the app, plus a single smart retry action.
- Updating the Agent's existing notetaker tools to prefer cleaned transcript + notes, falling back to raw only when cleanup hasn't succeeded.
- Meeting Detail UI: a new **Notes** tab; the existing transcript view becomes a **Transcript** tab with its own **Cleaned / Raw** sub-tabs (cleaned selected by default).

**Explicitly out of scope:**
- Any UI or pipeline for re-running STT itself with a different language (a separate, earlier-discussed feature — not part of this spec).
- Cross-segment restructuring during cleanup (merging fragmented segments, re-chunking). Cleanup corrects wording only, 1 segment in → 1 segment out — see §4.
- A job queue across multiple concurrently-finishing meetings. One meeting's pipeline runs to completion (or failure) before the next starts; this is a real constraint worth revisiting only if it proves to matter in practice, not solved speculatively here.
- Manual re-editing of notes/cleaned text by the user. Retry re-runs the pipeline; it does not open an editor.
- Any change to STT/Whisper, or to how the raw transcript itself is produced.

## 2. Storage

Extends the `meetings` table from the persistence spec with four new columns:

| Column | Type | Notes |
|---|---|---|
| `cleanup_status` | text | `disabled` \| `pending` \| `success` \| `failed` |
| `summary_status` | text | `disabled` \| `pending` \| `success` \| `failed` |
| `cleaned_transcript_path` | text, nullable | relative path, set only on `cleanup_status = 'success'` |
| `notes_path` | text, nullable | relative path, set only on `summary_status = 'success'` |

`disabled` is stamped at meeting-end time if the settings toggle was off then — distinct from `failed`, so a meeting recorded before the feature was turned on never shows a false failure banner.

**On-disk layout**, extending the existing per-meeting directory:

```
<userData>/meetings/<meeting-id>/
  audio-mic.wav              (unchanged)
  audio-system.wav           (unchanged)
  transcript.json            (unchanged — raw, kept forever, never edited)
  cleaned-transcript.json    (new — same segment shape as transcript.json: { channel, text, startMs, endMs, speakerName? }, only `text` ever differs from the raw version)
  notes.json                 (new — { title: string, summary: string, keyPoints: string[], decisions: string[], actionItems: string[] })
```

**New settings storage:** a single-row `notetaker_settings` table in the same `unmute.db` (mirroring `meetings`' own OSS-side, engine-overrides-owned storage — see §3 for why this stays out of the closed-source paywall store):

| Column | Type | Notes |
|---|---|---|
| `auto_pipeline_enabled` | integer (bool) | default `0` (off) |
| `provider` | text | `claude-code` \| `codex`, default `claude-code` |
| `cleanup_prompt` | text, nullable | `null` = use the built-in default (§4) |
| `summary_prompt` | text, nullable | `null` = use the built-in default (§5) |

## 3. The headless-agent subsystem

**Why this can't reuse the existing Task system:** every existing path to Claude Code/Codex in this app (`task-manager.ts`, `pty-session.ts`) spawns an *interactive*, tmux-wrapped, notch-integrated session meant to run indefinitely and be watched. `pty-session.ts` explicitly documents headless flags as forbidden. Forcing a one-shot "clean this transcript" call through that machinery would mean fighting a system built for the opposite job. This is new, and simpler: spawn the CLI non-interactively, feed it input, capture stdout, exit — the same shape `execFile('claude', ['mcp', 'list'], ...)` in `electron/remote/init.ts` already uses for other one-shot CLI calls, just with a longer-lived process and a prompt on stdin instead of fixed argv.

**Two pieces, split by which tree they belong in** (per this codebase's established cross-tree rule — see `notetakerInit.ts`'s own header comment on why `engine-overrides/electron/` and `electron/remote/` can only communicate via opaquely-injected hooks, not direct imports):

- **Execution — lives OSS-side** (`engine-overrides/electron/notetaker/headlessAgent.ts`, new). Spawning `claude -p <prompt>` or `codex exec <prompt>` and capturing stdout is plain `child_process` work with no paywall/billing/licensing involvement (this pipeline spends the *user's own* CLI usage, never Unmute's managed billing — confirmed explicitly by the user driving this spec). Nothing about it needs the closed-source tree, so it doesn't get the hook-injection treatment; it's a normal same-tree module `notetakerInit.ts` can import directly. Interface:
  ```
  runHeadlessAgent(provider: 'claude-code' | 'codex', input: string, opts: { timeoutMs: number }):
    Promise<{ ok: true; output: string } | { ok: false; error: string }>
  ```
  A 5-minute (`300_000`ms) timeout per call — generous for a full-meeting transcript through a CLI's own startup overhead, but bounded; a hung call must not hang the pipeline forever. Never throws; every failure (spawn error, non-zero exit, timeout) resolves to `{ ok: false, error }`.

- **Availability — needs the hook, because it's closed-source logic.** Whether Claude Code CLI / Codex CLI is actually usable (installed, on PATH, signed in) is exactly what `electron/remote/setup-status.ts` already computes for the Orchestrator's Agents checklist — this spec reuses that detection rather than re-implementing it. Exposed via a new `NotetakerInitHooks` entry, the same opaque-injection shape already used for `onOpenMeeting`/`onStopPendingChanged`:
  ```
  getAgentAvailability?: () => Promise<{ claudeCode: boolean; codex: boolean }>
  ```
  Wired through `wire-into-engine.sh`'s existing sed-patch mechanism into `main.ts`, backed by `setup-status.ts`'s real checks. `notetakerInit.ts` exposes this over IPC for the Settings UI to render the picker; the pipeline itself doesn't need to call it — a provider that's actually unavailable just fails its `runHeadlessAgent` call cleanly, which is already a handled outcome (§6).

## 4. Cleanup pass

**Input:** the raw `transcript.json` segments, reduced to only what the model needs — an array of `{ id: number, text: string }`, `id` being the segment's index. Channel/speaker/timestamps are never sent, because they're never meant to come back: the model's only job is correcting `text`.

**Prompt (default, editable):**
> "You are cleaning up a raw speech-to-text transcript of a recorded meeting. You will receive a JSON array of `{id, text}` pairs, each one segment of speech, in order. Fix only clear transcription errors — misheard words, garbled phrases, obviously wrong homophones — using the surrounding segments as context. Do not summarize, shorten, rephrase for style, or change meaning. Do not merge, split, reorder, or drop any segment. Return a JSON array of `{id, text}` pairs, one per input id, in the same order, with only the text corrected."

**Output contract:** a JSON array of `{id, text}`. Parsed and validated per-entry, not as a monolithic pass/fail:
- Valid JSON array, entry has both `id` (matching an input id, each id appearing at most once) and `text` (non-empty string) → that segment's cleaned text is used.
- Any other outcome for a given id (missing from the response, malformed entry, duplicate id, non-JSON response entirely) → that segment falls back to its own **original raw text**, not an error for the whole meeting.

`cleaned-transcript.json` is then built by taking every original segment object unchanged (channel, speaker, startMs, endMs) and swapping in the resolved `text` per id. **No timestamp, channel, or speaker value is ever read from the model's output** — this is what makes the "preserve timing" requirement (§ the earlier design discussion) hold with zero hallucination surface: the model never has the opportunity to get a number wrong, because it's never asked to produce one.

`cleanup_status = 'success'` if the call itself succeeded (`runHeadlessAgent` returned `ok: true`) and produced at least a parseable response — even one with some per-id fallbacks. `cleanup_status = 'failed'` only if the call itself failed (spawn error, timeout, non-zero exit) or the response wasn't parseable as JSON at all.

## 5. Summarization pass

Only runs if `cleanup_status === 'success'`. **Input:** the full cleaned transcript as plain text (channel-labeled turns, no raw JSON segment structure needed here — this pass produces prose, not a 1:1 mapping, so there's nothing to preserve by keeping it structured).

**Prompt (default, editable):**
> "You are producing meeting notes from a cleaned meeting transcript. Produce: a short, specific title (a few descriptive words — not one word, not a full sentence); a plain-language summary of what the meeting was about and what happened; a list of key points discussed; a list of any decisions that were made; a list of any action items, naming who owns each one if that's clear from the transcript. Only include items in a list if the transcript actually contains that kind of content — never invent items to fill a section. Return this as JSON: `{title, summary, keyPoints: string[], decisions: string[], actionItems: string[]}`."

**Output contract:** parsed as JSON; requires at least `title` (non-empty string) and `summary` (non-empty string) to count as success — `keyPoints`/`decisions`/`actionItems` default to `[]` if absent, since the prompt explicitly allows omitting empty sections. Anything short of that (unparseable JSON, missing title/summary, or the call itself failing) → `summary_status = 'failed'`, no `notes.json` written.

`notes.json`'s `title` supersedes `generateTitle()`'s first-line heuristic for this meeting's row once summarization succeeds; `generateTitle()` remains the fallback for `disabled`/`pending`/`failed` meetings, unchanged from the persistence spec.

## 6. Failure & retry

Both passes are best-effort and independently visible; nothing about them can break capture, playback, or the raw transcript — those paths are entirely unchanged.

Meeting Detail shows a banner whenever `cleanup_status = 'failed'` and/or `summary_status = 'failed'` ("Cleanup failed" / "Summary failed" / both, worded plainly), with a single **Retry** action that inspects current status and does the minimum needed to move forward:
- `cleanup_status = 'failed'` → retry re-runs cleanup, then (if that succeeds) summarization.
- `cleanup_status = 'success'`, `summary_status = 'failed'` → retry re-runs summarization only.

Both statuses flip to `pending` for the duration of a retry (or the initial run), giving the UI a clear "in progress" state distinct from both `disabled` and `failed`.

## 7. Agent + fallback rule

`electron/remote/agent/capabilities/notetaker.ts`'s adapters (`read`, `search`) and `NotetakerWidget`'s meeting-open flow all switch to this rule: **prefer `cleaned-transcript.json` + `notes.json`; fall back to `transcript.json` only when cleanup hasn't succeeded** (`disabled`, `pending`, or `failed`). Never a mix — a given read is either fully off the cleaned artifacts or fully off the raw ones, never patched together, so downstream consumers (the Agent, the Notes tab) never have to reason about partial cleanliness.

`constitution.ts`'s existing "MEETINGS THEY RECORDED ARE YOURS TO READ" paragraph gets one addition: `notetaker_read` returns the cleaned transcript when available (silently — the Agent doesn't need to announce which version it's reading), and notes.json's summary is a *ready-made* answer to "what was this meeting about," not a rule the Agent has to be told to prefer — but the constitution's existing "always give the same shape" instruction for ad-hoc summaries stays true either way, since this is a stored artifact, not a per-request synthesis.

## 8. Settings UI (`NotetakerSettings.tsx`)

One toggle, off by default, labeled to make the cost explicit — this pipeline runs on the user's own Claude Code/Codex usage, not Unmute's managed billing, every single meeting, so the copy says exactly that rather than leaving it implicit.

Below it, shown only when the toggle is on:
- **Provider picker** — Claude Code CLI / Codex CLI, backed by `getAgentAvailability()` (§3): both options always listed, only the actually-available one(s) selectable, exactly matching the Orchestrator Agents checklist's own established pattern (green check / disabled state) rather than inventing a new visual language for the same concept. **The toggle itself is disabled (can't be switched on) if neither provider is currently available**, with copy pointing at the same setup flow the Orchestrator's Agents checklist already sends people through — so "on" always implies a real, currently-usable provider is selected, never a stored-but-unusable default silently failing every meeting.
- **Two prompt editors** — Cleanup prompt, Summary prompt. Each is a plain textarea seeded with its default (§4/§5) when the stored value is `null`, plus a "Reset to default" button that clears the stored override back to `null` (not that re-copies the default text in — so a later change to the built-in default text is inherited automatically instead of getting stuck at whatever text was in the box at reset time).

## 9. Meeting Detail UI

`MeetingDetail.tsx` gains a top-level **Notes / Transcript** tab pair (replacing today's single flat view).

**Transcript tab:** its own **Cleaned / Raw** sub-tabs, Cleaned selected by default. Raw is always available regardless of cleanup status (it's just `transcript.json`, unchanged); Cleaned shows the cleaned transcript when `cleanup_status = 'success'`, or a plain "cleanup hasn't run for this meeting" state (with the retry action from §6 if it failed) otherwise.

**Notes tab:** title and date/time at the top (date/time already exist on the meeting row per the persistence spec), then the summary, key points, decisions, and action items as separate, collapsible/expandable sections — real interactive disclosure, not a single scrolling block of markdown. A section is simply omitted (not shown collapsed-empty) if `notes.json` returned it empty. When `summary_status` isn't `success`, the tab shows the appropriate `disabled` / `pending` / `failed`-with-retry state instead of empty sections.
