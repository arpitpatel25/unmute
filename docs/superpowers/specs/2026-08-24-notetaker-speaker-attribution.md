# Meeting notetaker — per-segment speaker attribution (Zoom)

**Status:** design-complete, not yet built.
**Date:** 2026-08-24
**Branch:** `arpit/notetaker`
**Builds on:** `docs/superpowers/specs/2026-08-24-meeting-notetaker-periodic-flush.md` and the global-audio-tap fix (commit `b5929e1`).

## 1. What this is

Today, every system-channel transcript segment is labeled generically "Them" — no distinction between different people in a multi-person call. This spec adds **per-segment speaker names** for Zoom calls, read from Zoom's own UI (accessibility tree), matching the technique the market leader (Granola) uses — not acoustic diarization, which was already researched and rejected this session (requires an ML model Groq doesn't provide, and even a funded competitor's acoustic approach — Wispr Flow's notetaker — gets it wrong on a meaningful fraction of speakers in a real test).

**Explicitly out of scope, with reasons:**
- **Google Meet.** Verified empirically tonight (not assumed): `native-ax`'s `find`/`getTree` against a real, currently-open Chrome window returns only the browser's own toolbar/tab-strip chrome (`AXWindow`/`AXGroup`/`AXToolbar`/`AXButton`/`AXTabGroup`/`AXRadioButton` — 228 nodes, max depth 9) — **zero** web-content roles (no `AXWebArea`, no `AXStaticText` from the page, no page text at all), even when explicitly requesting depth 30 with `includeAll:true`. Chrome's web-content accessibility tree is not reachable through this mechanism as currently implemented. Building Meet support needs either a real Chrome extension (a separate, substantial deliverable — this codebase has no Chrome-tab-content bridge of any kind, confirmed by direct repo search, despite an earlier spec's now-known-false claim that one already existed) or deeper investigation into activating Chrome's renderer-level accessibility tree specifically. Neither is in scope here.
- **Everything else** (Teams, Slack huddles, any non-Zoom app, physical/offline meetings). Falls back to today's plain mic/system split — already the default behavior, not a regression.
- **True per-word/per-sentence attribution.** Transcript segments are cut on VAD silence (30-45s windows), not on speaker changes — a single segment can span more than one person talking back-to-back if nobody pauses long enough to trigger a cut. This spec attributes each **segment** to whichever speaker was active for the largest share of that segment's time window (majority-vote by time-overlap), not each individual sentence. Redesigning segment-cutting to also trigger on detected speaker changes is a real, separate design decision, deliberately deferred.
- **The manual-trigger-works-anywhere requirement** from this session's discussion needs no change — verified already true tonight: the manual chord trigger has never depended on the target app playing audio (`resolveTargetPid()` only checks "is some real app frontmost," nothing about `nowPlaying`/meeting-detection). The only place this constraint used to leak in was an unintended side effect of the old per-process audio tap (Core Audio would only resolve a process object for a pid actively producing sound) — already eliminated by the global-tap fix. No task needed for this.

## 2. The real, disclosed uncertainty: Zoom's in-call AX-tree shape is unverified

`native-ax`'s mechanism is confirmed to reach real UI content in Zoom (verified tonight: its sign-in screen's actual form fields — `AXTextField "Email"`, `AXCheckBox "Keep me signed in"`, etc. — were all visible via `ax.find('zoom.us', '', '')`, unlike Chrome's web content). This gives real confidence the mechanism *can* reach Zoom's in-call participant panel and active-speaker indicator too.

**But the exact roles/labels Zoom uses for "this participant is currently speaking" were NOT verified** — doing so would require joining a real, live, multi-person Zoom call, which no one was available to do tonight. Guessing a specific selector string and shipping it with false confidence is exactly the kind of "confident but unverified" mistake that caused real bugs earlier this same session (the per-process audio-tap approach, the stale-TCC-binding hypothesis, etc.) — not repeating that here.

**The approach this spec takes instead:** ship a best-effort heuristic (Task 1) based on common, well-documented accessibility conventions (a participant list row's label or description commonly includes speaking-state text for screen-reader users), but pair it with **extensive raw-AX-tree logging** of every candidate node examined — so that after the next real Zoom call, the notetaker log file (`notetaker-logs/`, the same structured logger built earlier tonight) shows exactly what Zoom's real AX tree looks like during a call. That log is what a follow-up round tunes the heuristic against — the same "ship instrumented, verify from real log data, fix" loop that successfully found and fixed the audio-tap bugs tonight, applied here because the same kind of unverifiable-without-a-live-session gap exists.

## 3. Design

### 3.1 Polling, only when it can possibly matter

A new poller runs **only** while a capture session is active **and** the resolved target app is Zoom (bundle id `us.zoom.xos`) — never during Meet/other-app sessions (nothing to read), never when idle (no reason to touch Zoom's AX tree when there's no active capture). Same cadence class as the existing meeting-signal poll (~2-3s), independent interval so it can be tuned/disabled without touching detection.

Each poll produces a timestamped sample: `{ speakerName: string | null, timestampMs: number }`. Samples accumulate in memory for the session's duration (bounded — a poll every 2-3s over even a 2-hour meeting is ~2400-3600 tiny objects, negligible), same lifecycle as the existing per-session `ChannelTracker` objects (freshly allocated in `start()`, read in `stop()`).

### 3.2 Per-segment attribution

At `persistSession()` time (after both channels' chunks have resolved, before writing `transcript.json`), for each **system**-channel segment `{startMs, endMs}`: filter the speaker-sample timeline to samples whose `timestampMs` falls within `[startMs, endMs]`, then pick the most-frequent non-null `speakerName` among them (majority vote). If no samples fall in range, or every sample in range is `null` (nobody detected as speaking), or Zoom polling never ran this session (any other app), the segment's `speakerName` is `null` — falls back to the existing generic "Them" label, exactly today's behavior.

Mic-channel segments never get a `speakerName` — they're always "You," no attribution needed, no ambiguity.

### 3.3 Data model

`TranscriptSegment` (`transcriptMerge.ts`) and `NotetakerTranscriptSegment` (`remote-preload.ts`, `MeetingDetail.tsx`, `MeetingsList.tsx`'s local mirror if present) gain one new optional field:

```ts
speakerName?: string | null
```

Purely additive — every existing consumer that doesn't know about this field keeps working unchanged (`undefined`/`null` both render as today's generic "Them").

### 3.4 UI

`MeetingDetail.tsx`'s segment rendering: for a `system`-channel segment with a non-null `speakerName`, render that name instead of "Them" (e.g. `Sarah:` instead of `Them:`). No other UI change — no new settings toggle, no indication of confidence/uncertainty in the label itself (a wrong name is a real risk given the unverified heuristic, but that's a tuning problem for the next round with real log data, not a UI problem to design around preemptively).

## 4. Non-goals check against prior specs

Doesn't change: the global-audio-tap architecture (commit `b5929e1`) — this is a metadata layer computed entirely from Zoom's AX tree and correlated by timestamp, completely independent of how the audio itself was captured. Doesn't change: the 24h-audio/forever-transcript retention split, the periodic-flush chunk-cutting logic, the mic-vs-system channel split. Doesn't change: detection (`MeetingWatcher`) or the manual chord trigger — this feature only activates during an already-started capture session.
