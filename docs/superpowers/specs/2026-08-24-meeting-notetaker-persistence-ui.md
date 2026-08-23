# Meeting notetaker — persistence + UI

**Status:** design-complete, not yet built.
**Date:** 2026-08-24
**Branch:** `arpit/notetaker`
**Builds on:** `docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md` (detection + capture, already implemented and reviewed)

The detection+capture spec deliberately stopped at "audio is captured, timestamped, and handed to a callback" — nothing consumed that callback. This spec covers the other half: turning captured audio into a transcript the user can actually read, storing it, and surfacing it in the app. Without this, the feature requests an intrusive system-audio permission and produces nothing.

## 1. Scope

**In scope:**
- Batch (post-call) transcription of both captured channels through the existing Groq Whisper pipeline dictation already uses.
- Local, permanent storage of the transcript + meeting metadata; local, 24h-retained storage of the raw audio.
- A new "Notetaker" sidebar section: a chronological meeting list and a settings sub-view.
- Auto-generated meeting titles from transcript content.

**Explicitly out of scope:**
- Live/streaming transcription during the call. Batch-after-stop only for v1 — the capture pipeline already buffers chunks in memory for the session's duration, and batch avoids partial/flickering UI during a live meeting.
- Speaker diarization beyond the existing mic/system channel split (unchanged from the base spec — Groq Whisper has no diarization).
- Attendee names/identification. Not knowable from audio alone; a future field, not built now.
- Cloud sync of any kind. Everything here is local-only, matching the base spec's local-first posture and explicitly diverging from both Granola (discards audio after transcribing) and Wispr Flow (deletes audio after a limited period, syncs notes to a private cloud by default) — Unmute keeps the transcript forever and the audio for a bounded window, entirely on-device.

## 2. Storage

**New table `meetings` in the existing `unmute.db`** (same SQLite connection `db.ts` already opens at `<userData>/unmute.db`, WAL mode) — a sibling to the existing `sessions` table, not a replacement or a separate database file:

| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid) | primary key |
| `title` | text | auto-generated from transcript, user-editable |
| `started_at` | integer (epoch ms) | |
| `ended_at` | integer (epoch ms) | |
| `duration_ms` | integer | |
| `status` | text | `recording` \| `transcribing` \| `ready` \| `failed` |
| `transcript_path` | text | relative path under the meeting's own directory |
| `audio_mic_path` | text, nullable | null once the 24h audio sweep has run |
| `audio_system_path` | text, nullable | null once the 24h audio sweep has run |

**On-disk layout**, mirroring the existing `<userData>/audio/` convention but under its own subdirectory so the retention sweep can target it independently of dictation's audio files:

```
<userData>/meetings/<meeting-id>/
  audio-mic.wav       (deleted after 24h)
  audio-system.wav    (deleted after 24h)
  transcript.json     (kept forever)
```

Directory name doubles as the DB row's `id`. `transcript.json` is an ordered array of `{ channel: 'mic' | 'system', text: string, startMs: number, endMs: number }` segments — timestamp-ordered merge of both channels' Whisper output, which is what the UI renders as "You" / "Them" turns.

## 3. Retention

Two independent policies, both modeled on patterns already in this codebase rather than invented fresh:

- **Transcript + DB row: never auto-deleted.** No TTL, no row-cap eviction — unlike the existing `sessions` table's unconditional 24h+100-row sweep (`db.ts`'s `cleanupSessions()`), the `meetings` table is never touched by that function or any equivalent. Manual delete only, from the Notetaker UI.
- **Audio files: deleted 24h after `ended_at`.** A sweep job, structurally the same shape as `db.ts`'s existing hourly `setInterval` backstop (unref'd, so it doesn't keep the process alive) — but scoped to only the two audio files per expired meeting, never touching `transcript.json` or the DB row. On sweep, `audio_mic_path`/`audio_system_path` are set to `null` in the row (so the UI knows to hide the playback control) but `status`/`transcript_path`/everything else is untouched.

This is deliberately a new, narrower job — not a reuse of `cleanupSessions()` or `CaptureHistoryStore`'s `saved`-flag sweep, since neither existing mechanism has a "delete files but keep the row" shape; both existing sweeps either delete the whole entry or keep it entirely.

## 4. Transcription pipeline

Triggered when `NotetakerSession.stop()` is called (via the confirm flow already built in `notetakerInit.ts`) and the session has captured at least one chunk of audio on either channel:

1. Buffer the session's chunks in memory during capture (already happens implicitly via the timestamped `onChunk` callback — this spec's job is to give that callback a real body instead of the current no-op).
2. On stop: assemble each channel's buffered Float32Array chunks into one continuous audio file per channel (mic, system), write both to `<userData>/meetings/<id>/`.
3. Send both files through the same Groq Whisper STT call dictation's pipeline already makes (reuse the existing STT client/endpoint in `sessionManager.ts`, not a new integration).
4. Merge both channels' returned segments by timestamp into `transcript.json`, tagging each segment's channel.
5. Generate a short title from the merged transcript's first substantive content (reuse whatever summarization/cleanup LLM call this app already has available for dictation cleanup, if one exists and is a natural fit — otherwise a simple heuristic first-N-words fallback is acceptable for v1).
6. Insert the `meetings` row, update `status` to `ready`.

If transcription fails at any step, `status` becomes `failed`, the row is still created (title falls back to date/time), and whatever audio was written is left in place (not swept early) so the user isn't silently left with nothing.

## 5. Notetaker sidebar section

New `Tab` value added to `App.tsx`'s existing `'history' | 'orchestrator' | 'account' | 'settings'` union (→ adds `'notetaker'`), with its own `SidebarButton` + icon, following the file's established four-tabs pattern exactly (and its own doc-comment note about "four destinations" needs updating to five).

Within the tab, a `SegmentedControl` — the same pattern `Orchestrator`'s own sub-pages already use, not a new mechanism — with two sub-views:

- **Meetings** (default): chronological list (newest first), each row showing title, exact date, exact time, duration. Clicking a row opens a detail view: full transcript (mic/system turns visually distinguished), audio playback controls when the audio files still exist (hidden once the 24h sweep has run), a rename-title control, and a delete-meeting control (removes the DB row and any remaining files).
- **Settings**: notetaker-specific settings — currently just a reference display of the trigger hotkey (left-Control+left-Option double-tap) mirroring however other hotkeys are documented elsewhere in Settings; a toggle for whether meeting-detection prompts are shown at all (independent of manual-trigger capture, which always works per the base spec's design).

## 6. Explicit non-goals for this pass

Same posture as the base spec — narrow, real, not padded:

- No cross-device sync, no cloud storage, no export (markdown/PDF/etc.) — file-system access to `<userData>/meetings/` is the only "export" for v1, the same way a user could already reach into `<userData>/audio/` for dictation if they wanted to.
- No search across meetings, no full-text index — the list is purely chronological.
- No editing the transcript text itself, only the title.
