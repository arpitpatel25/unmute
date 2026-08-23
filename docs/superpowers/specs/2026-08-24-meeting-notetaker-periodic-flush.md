# Meeting notetaker — periodic flush

**Status:** design-complete, not yet built.
**Date:** 2026-08-24
**Branch:** `arpit/notetaker`
**Builds on:** `docs/superpowers/specs/2026-08-24-meeting-notetaker-persistence-ui.md`

The persistence spec shipped a working pipeline with a real flaw the final review caught: `ChunkBuffer` holds an entire meeting's raw audio in RAM and only encodes+transcribes once, at stop. For a long meeting this means ~2GB/hour resident, a multi-GB transient peak right before upload, and — even after the mono/16kHz downsample fix — a hard ceiling around 27 minutes before the transcription backend's 50MB-per-request cap rejects the upload outright.

The user's direction: this codebase already solves exactly this problem for dictation, since Whisper has no streaming API — periodic flushing, not one big blob at the end. This spec reuses that existing, proven mechanism rather than inventing a new one.

## 1. What dictation already does (the pattern to reuse)

Confirmed by direct research against the real files:

- **Cut decision**: `desktop/engine-overrides/renderer/widget/vadPolicy.ts` — a pure, DOM-free function `decideCut(input: CutInput): 'none' | 'silence' | 'soft-cap' | 'hard-cap'`, driven by RMS + elapsed time. No cut before 30s (`minChunkMs`), forced cut at 45s (`hardCapMs`), silence-based cut once RMS drops under an adaptive threshold for 400ms, and a soft-cap in the last 5s before the hard cap that prefers a smaller dip over guillotining mid-word.
- **Emit-immediately**: each cut fires an STT call right away (`sessionManager.ts`'s `transcribeChunk`, fired the instant a chunk arrives, not batched or awaited serially against other chunks).
- **Ordering, not arrival**: results are tracked in a `Map` keyed by chunk index and assembled in strict index order at the end, not in the order responses happened to come back.
- **Stitching is a plain ordered join**: `stitchChunks()` does per-chunk cleanup (strip Whisper hallucination sentinels like `[BLANK_AUDIO]`) then `.join(' ')` — no LLM merge pass, no boundary dedup logic, because cutting on silence (never mid-word, except the rare hard-cap) makes naive concatenation safe.
- **Backend is stateless per-blob already**: `POST /v1/stt` has no session/chunk-index concept at all — every request is independently transcribed. No backend changes are needed for this spec; the existing endpoint already accepts however many small requests you send it.

## 2. What changes for the notetaker

**In scope:**
- Replace `ChunkBuffer`'s single end-of-session accumulation with a per-channel periodic emitter, reusing `vadPolicy.ts`'s `decideCut()` directly (imported as-is, not reimplemented).
- Mic and system channels get **independent** chunk-index sequences — they are not synchronized streams, so there's no reason to force them onto one shared index space the way dictation's single-stream model does.
- Each emitted chunk is downmixed/resampled/WAV-encoded (reusing the already-built `resample.ts`/`wavEncoder.ts`) and sent to `tryManagedSTT()` immediately, not queued until the meeting ends.
- Per-channel ordered tracking + a `stitchChunks`-style plain join, replacing today's single-call-per-channel transcription.
- `mergeTranscripts` (currently: exactly one segment per channel) needs to accept an ordered list of stitched segments per channel instead of a single string — this also means the merged transcript gets genuinely improved granularity (multiple time-anchored turns per channel instead of one giant block each).
- Memory: a chunk's raw samples are dropped from the per-channel buffer once that chunk has been finalized and handed off for encoding — RAM usage is bounded by one chunk's worth of audio (tens of seconds) per channel, not by meeting length.

**Explicitly out of scope:**
- Reusing `SttArbiter`'s cloud/local-fallback racing and speculative-draft logic. That solves a live-dictation UX problem (a user staring at a paste target, where a fast local draft matters) that doesn't apply to a background meeting recording with no one waiting on it live. Chunks are transcribed via a single `tryManagedSTT()` call each, same as the notetaker already does today — this spec only changes *when* that call happens (per-chunk, immediately) and *how many* happen (many small ones instead of one giant one), not which STT path is used.
- True live transcription / streaming captions shown during the call. Still explicitly out of scope, same as the base persistence spec — this is periodic *batch* flushing (small batches, sent early and often), not live streaming.
- Per-utterance timestamps within a single chunk. Groq's `response_format: 'json'` still gives no sub-chunk timing; each chunk's transcript is one block, same granularity dictation already lives with.

## 3. Chunk boundary parameters

Reuse dictation's real defaults rather than inventing new numbers, since they're already tuned against real recordings (per `vadPolicy.ts`'s own header comment describing a field investigation that arrived at them):

- `minChunkMs`: 30,000 — no cut considered before this.
- `hardCapMs`: 45,000 — forced cut regardless of silence.
- `silenceDurationMs`: 400 — continuous sub-threshold RMS required to cut on silence.
- `softCapWindowMs`: 5,000 — window before the hard cap where a smaller dip is accepted.
- Threshold: reuse `effectiveSilenceThreshold()` (adaptive to the channel's own measured noise floor), not a fixed constant.

These apply independently per channel — mic and system audio have different noise characteristics (mic picks up room noise, system audio is whatever the remote participant's app outputs) and will cut at different points in time, which is expected and fine given they're tracked as independent sequences.

## 4. RMS computation (the one genuinely new piece)

Dictation computes RMS from an `AnalyserNode` in the renderer (DOM API). The notetaker's system-audio channel arrives in the **Electron main process** as raw `Float32Array` samples from the native Core Audio tap — there is no `AnalyserNode` available there. Needed: a small, pure `computeRms(samples: Float32Array): number` function (`sqrt(mean(x^2))`, standard RMS), usable identically for both channels regardless of where the samples originated (main process for system audio, main process again for mic audio once it arrives via the existing `notetaker:mic-chunk` IPC channel — both channels end up as plain `Float32Array` chunks in the main process by the time this logic runs, so one shared implementation covers both).

## 5. Non-goals check against the base persistence spec

This spec doesn't change: the `meetings` DB schema, the 24h audio-only / forever-transcript retention split, the Notetaker sidebar UI, the IPC surface for browsing saved meetings, or the mic-capture wiring (Finding 1 from the prior final review) — it only changes how audio gets from "captured" to "encoded and sent," replacing one giant operation at the end with many small ones spread across the recording.
