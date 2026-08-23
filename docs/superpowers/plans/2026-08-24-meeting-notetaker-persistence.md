# Meeting Notetaker Persistence + UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn captured meeting audio into a stored, browsable transcript — the missing half of the notetaker feature. Right now `notetakerInit.ts` hands every captured audio chunk to a no-op (`() => {}`); this plan buffers those chunks, transcribes them through the existing Groq pipeline on stop, writes a permanent transcript + a 24h-retained audio file, and surfaces it in a new "Notetaker" sidebar tab.

**Architecture:** A pure-logic chunk buffer accumulates `TimestampedChunk`s per channel during capture. On stop, buffered samples are WAV-encoded, sent through the existing `tryManagedSTT()` pipeline (the same call dictation already makes — no new Groq integration), merged by timestamp into a transcript, and persisted: transcript + a new `meetings` DB row live forever, audio files get swept 24h after the meeting ends. The renderer gets a new sidebar tab mirroring the existing four-tab pattern in `App.tsx`, with a segmented-control sub-page split (Meetings list / Settings) mirroring Orchestrator's existing pattern.

**Tech Stack:** TypeScript throughout, `node:test` for pure-logic tests, `better-sqlite3` (already a dependency, via `db.ts`), React (renderer, matching `App.tsx`'s existing conventions).

**Spec:** `docs/superpowers/specs/2026-08-24-meeting-notetaker-persistence-ui.md` (builds on `docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md`)

## Global Constraints

- Transcript + `meetings` DB row: **never** auto-deleted. No TTL, no row cap — unlike `sessions`, which `cleanupSessions()` sweeps unconditionally at 24h + caps at 100 rows.
- Audio files (`audio-mic.wav`, `audio-system.wav`): deleted exactly 24h after `ended_at`, via a new, narrower sweep — never touches `transcript.json` or the DB row, only nulls the two path columns.
- Batch transcription only — no live/streaming transcription during the call.
- No diarization beyond the existing mic/system channel split. Mic segments render as "You," system segments as "Them."
- No cloud sync, no export beyond raw filesystem access to `<userData>/meetings/`.
- Test runner is Node's built-in `node:test` via `tsx`, house style `import test, { describe } from 'node:test'` + `import assert from 'node:assert/strict'`. `db.ts` itself has no existing test file anywhere in this repo (verified) — do not invent DB-layer `node:test` coverage that fights the module-level singleton connection; keep business logic (encoding, merging, title generation) in separately-testable pure modules instead, matching how `meetingWatcher.ts`/`notetakerSession.ts` were already built pure and testable while `notetakerInit.ts` (the electron-coupled composition root) has no tests.
- Reuse `tryManagedSTT()` (`desktop/electron/paywall-route.ts`) for transcription — do not add a second Groq integration. Use `flowType: 'dictation'` for both channel calls (no new backend flowType category is in scope here).

---

## Task 1: WAV encoder (pure function, PCM Float32 → WAV Buffer)

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/wavEncoder.ts`
- Test: `desktop/engine-overrides/electron/notetaker/wavEncoder.test.ts`

**Interfaces:**
- Produces: `encodeWav(samples: Float32Array, sampleRate: number, channels: number): Buffer`

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/wavEncoder.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav } from './wavEncoder'

describe('encodeWav', () => {
  test('produces a valid RIFF/WAVE header', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000, 1)
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE')
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ')
  })

  test('fmt chunk encodes sample rate, channel count, and 16-bit PCM format', () => {
    const buf = encodeWav(new Float32Array([0]), 44100, 2)
    assert.equal(buf.readUInt16LE(20), 1) // PCM format code
    assert.equal(buf.readUInt16LE(22), 2) // channels
    assert.equal(buf.readUInt32LE(24), 44100) // sample rate
    assert.equal(buf.readUInt16LE(34), 16) // bits per sample
  })

  test('data chunk length matches sample count * 2 bytes (16-bit)', () => {
    const samples = new Float32Array(100)
    const buf = encodeWav(samples, 16000, 1)
    const dataChunkSize = buf.readUInt32LE(40)
    assert.equal(dataChunkSize, 100 * 2)
  })

  test('clamps out-of-range samples instead of wrapping', () => {
    const buf = encodeWav(new Float32Array([2.0, -2.0]), 16000, 1)
    const s1 = buf.readInt16LE(44)
    const s2 = buf.readInt16LE(46)
    assert.equal(s1, 32767)
    assert.equal(s2, -32768)
  })

  test('round-trips a mid-range sample within 16-bit quantization error', () => {
    const buf = encodeWav(new Float32Array([0.5]), 16000, 1)
    const s = buf.readInt16LE(44)
    assert.ok(Math.abs(s - 16383) <= 1)
  })

  test('empty input produces a valid header with zero-length data chunk', () => {
    const buf = encodeWav(new Float32Array([]), 16000, 1)
    assert.equal(buf.readUInt32LE(40), 0)
    assert.equal(buf.length, 44)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/wavEncoder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/wavEncoder.ts

/**
 * Encodes raw PCM Float32 samples into a standard 16-bit PCM WAV file.
 * 16-bit rather than 32-bit float output because it's the most broadly
 * compatible format for both browser <audio> playback and the STT upload.
 */
export function encodeWav(samples: Float32Array, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')

  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM format code
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  const blockAlign = channels * bytesPerSample
  buffer.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34) // bits per sample

  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    buffer.writeInt16LE(Math.round(pcm), 44 + i * bytesPerSample)
  }

  return buffer
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/wavEncoder.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/wavEncoder.ts desktop/engine-overrides/electron/notetaker/wavEncoder.test.ts
git commit -m "notetaker: add PCM Float32 -> WAV encoder"
```

---

## Task 2: Chunk buffer (accumulates TimestampedChunks per channel, finalizes to two sample arrays)

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/chunkBuffer.ts`
- Test: `desktop/engine-overrides/electron/notetaker/chunkBuffer.test.ts`

**Interfaces:**
- Consumes: `TimestampedChunk` type from `../notetakerSession` (`{ source: 'mic' | 'system'; samples: Float32Array; sampleRate: number; channels: number; timestampMs: number }`)
- Produces:
  ```ts
  export type FinalizedChannel = { samples: Float32Array; sampleRate: number; channels: number; firstTimestampMs: number } | null
  export class ChunkBuffer {
    feed(chunk: TimestampedChunk): void
    finalize(source: 'mic' | 'system'): FinalizedChannel
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/chunkBuffer.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { ChunkBuffer } from './chunkBuffer'
import type { TimestampedChunk } from '../notetakerSession'

function chunk(source: 'mic' | 'system', samples: number[], timestampMs: number): TimestampedChunk {
  return { source, samples: new Float32Array(samples), sampleRate: 16000, channels: 1, timestampMs }
}

describe('ChunkBuffer', () => {
  test('finalize() on an untouched channel returns null', () => {
    const buf = new ChunkBuffer()
    assert.equal(buf.finalize('mic'), null)
  })

  test('concatenates same-channel chunks in feed order', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1, 0.2], 1000))
    buf.feed(chunk('mic', [0.3, 0.4], 1010))
    const result = buf.finalize('mic')
    assert.ok(result)
    assert.deepEqual(Array.from(result!.samples), [0.1, 0.2, 0.3, 0.4])
  })

  test('mic and system channels are kept independent', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1], 1000))
    buf.feed(chunk('system', [0.9], 1005))
    assert.deepEqual(Array.from(buf.finalize('mic')!.samples), [0.1])
    assert.deepEqual(Array.from(buf.finalize('system')!.samples), [0.9])
  })

  test('records sampleRate/channels from the first chunk fed for that channel', () => {
    const buf = new ChunkBuffer()
    buf.feed({ source: 'system', samples: new Float32Array([0.1, 0.2]), sampleRate: 48000, channels: 2, timestampMs: 1000 })
    const result = buf.finalize('system')
    assert.equal(result!.sampleRate, 48000)
    assert.equal(result!.channels, 2)
  })

  test('records the timestamp of the first chunk fed for that channel', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1], 5000))
    buf.feed(chunk('mic', [0.2], 5010))
    assert.equal(buf.finalize('mic')!.firstTimestampMs, 5000)
  })

  test('finalize() can be called more than once and returns a consistent snapshot', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1], 1000))
    const first = buf.finalize('mic')
    buf.feed(chunk('mic', [0.2], 1010))
    const second = buf.finalize('mic')
    assert.deepEqual(Array.from(first!.samples), [0.1])
    assert.deepEqual(Array.from(second!.samples), [0.1, 0.2])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/chunkBuffer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/chunkBuffer.ts
import type { TimestampedChunk } from '../notetakerSession'

export type FinalizedChannel = {
  samples: Float32Array
  sampleRate: number
  channels: number
  firstTimestampMs: number
} | null

type ChannelState = {
  parts: Float32Array[]
  sampleRate: number
  channels: number
  firstTimestampMs: number
}

/**
 * Accumulates timestamped audio chunks per channel (mic/system) during a
 * notetaker capture session, for later WAV-encoding + transcription on
 * stop. Format (sampleRate/channels) is taken from the first chunk fed for
 * that channel — every chunk from a given native/mic source is expected to
 * share the same format for the duration of one session.
 */
export class ChunkBuffer {
  private readonly mic: ChannelState = { parts: [], sampleRate: 0, channels: 0, firstTimestampMs: 0 }
  private readonly system: ChannelState = { parts: [], sampleRate: 0, channels: 0, firstTimestampMs: 0 }

  feed(chunk: TimestampedChunk): void {
    const state = chunk.source === 'mic' ? this.mic : this.system
    if (state.parts.length === 0) {
      state.sampleRate = chunk.sampleRate
      state.channels = chunk.channels
      state.firstTimestampMs = chunk.timestampMs
    }
    state.parts.push(chunk.samples)
  }

  finalize(source: 'mic' | 'system'): FinalizedChannel {
    const state = source === 'mic' ? this.mic : this.system
    if (state.parts.length === 0) return null

    const totalLength = state.parts.reduce((sum, part) => sum + part.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const part of state.parts) {
      merged.set(part, offset)
      offset += part.length
    }

    return {
      samples: merged,
      sampleRate: state.sampleRate,
      channels: state.channels,
      firstTimestampMs: state.firstTimestampMs,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/chunkBuffer.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/chunkBuffer.ts desktop/engine-overrides/electron/notetaker/chunkBuffer.test.ts
git commit -m "notetaker: add per-channel chunk buffer"
```

---

## Task 3: Transcript merge + title generation (pure logic)

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/transcriptMerge.ts`
- Test: `desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TranscriptSegment = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }
  export function mergeTranscripts(
    micText: string, micStartMs: number, micDurationMs: number,
    systemText: string, systemStartMs: number, systemDurationMs: number
  ): TranscriptSegment[]
  export function generateTitle(segments: TranscriptSegment[]): string
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mergeTranscripts, generateTitle } from './transcriptMerge'

describe('mergeTranscripts', () => {
  test('mic-only transcript produces one mic segment', () => {
    const segments = mergeTranscripts('hello there', 1000, 2000, '', 0, 0)
    assert.deepEqual(segments, [{ channel: 'mic', text: 'hello there', startMs: 1000, endMs: 3000 }])
  })

  test('system-only transcript produces one system segment', () => {
    const segments = mergeTranscripts('', 0, 0, 'how are you', 500, 1500)
    assert.deepEqual(segments, [{ channel: 'system', text: 'how are you', startMs: 500, endMs: 2000 }])
  })

  test('both channels present, mic starts first, ordered by startMs', () => {
    const segments = mergeTranscripts('hello', 1000, 1000, 'hi back', 3000, 1000)
    assert.equal(segments.length, 2)
    assert.equal(segments[0].channel, 'mic')
    assert.equal(segments[0].startMs, 1000)
    assert.equal(segments[1].channel, 'system')
    assert.equal(segments[1].startMs, 3000)
  })

  test('system starts before mic, ordered accordingly', () => {
    const segments = mergeTranscripts('hello', 5000, 1000, 'hi', 1000, 1000)
    assert.equal(segments[0].channel, 'system')
    assert.equal(segments[1].channel, 'mic')
  })

  test('empty text on both channels produces no segments', () => {
    assert.deepEqual(mergeTranscripts('', 0, 0, '', 0, 0), [])
  })

  test('whitespace-only text is treated as empty', () => {
    assert.deepEqual(mergeTranscripts('   ', 0, 0, '', 0, 0), [])
  })
})

describe('generateTitle', () => {
  test('uses the first substantive segment, truncated to a short phrase', () => {
    const title = generateTitle([{ channel: 'mic', text: 'so I wanted to talk about the roadmap for next quarter', startMs: 0, endMs: 5000 }])
    assert.ok(title.length <= 60)
    assert.ok(title.startsWith('so I wanted to talk'))
  })

  test('no segments falls back to a date-based title', () => {
    const title = generateTitle([])
    assert.match(title, /Meeting/)
  })

  test('very short first segment is used as-is without truncation artifacts', () => {
    const title = generateTitle([{ channel: 'mic', text: 'hi', startMs: 0, endMs: 500 }])
    assert.equal(title, 'hi')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/transcriptMerge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/transcriptMerge.ts

export type TranscriptSegment = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }

/**
 * Merges the two channels' whole-recording transcripts into ordered
 * segments. v1 has no per-utterance timestamps from Groq (response_format
 * is 'json', not 'verbose_json' — see backend/cloudflare/pipeline), so each
 * channel yields at most one segment spanning its whole recorded duration;
 * ordering by startMs is still meaningful and correct for the common case
 * where one side starts talking, then the other responds.
 */
export function mergeTranscripts(
  micText: string, micStartMs: number, micDurationMs: number,
  systemText: string, systemStartMs: number, systemDurationMs: number
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  const trimmedMic = micText.trim()
  const trimmedSystem = systemText.trim()

  if (trimmedMic) {
    segments.push({ channel: 'mic', text: trimmedMic, startMs: micStartMs, endMs: micStartMs + micDurationMs })
  }
  if (trimmedSystem) {
    segments.push({ channel: 'system', text: trimmedSystem, startMs: systemStartMs, endMs: systemStartMs + systemDurationMs })
  }

  return segments.sort((a, b) => a.startMs - b.startMs)
}

const MAX_TITLE_LENGTH = 60

export function generateTitle(segments: TranscriptSegment[]): string {
  const first = segments[0]
  if (!first) {
    return `Meeting on ${new Date().toLocaleDateString()}`
  }
  if (first.text.length <= MAX_TITLE_LENGTH) {
    return first.text
  }
  return first.text.slice(0, MAX_TITLE_LENGTH).trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/transcriptMerge.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/transcriptMerge.ts desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts
git commit -m "notetaker: add transcript merge + title generation"
```

---

## Task 4: `meetings` table schema + CRUD in `db.ts`

**Files:**
- Modify: `desktop/engine-overrides/electron/db.ts`

No test file for this task — mirrors this file's own existing convention (no `db.ts` test exists anywhere in this repo; the module-level singleton connection doesn't lend itself to `node:test` without new test infrastructure this plan doesn't introduce).

**Interfaces:**
- Produces:
  ```ts
  export interface DBMeeting {
    id: string
    title: string
    started_at: number
    ended_at: number
    duration_ms: number
    status: 'recording' | 'transcribing' | 'ready' | 'failed'
    transcript_path: string
    audio_mic_path: string | null
    audio_system_path: string | null
  }
  export function insertMeeting(meeting: Omit<DBMeeting, never>): void
  export function getMeetings(limit?: number): DBMeeting[]
  export function getMeeting(id: string): DBMeeting | null
  export function updateMeetingTitle(id: string, title: string): void
  export function deleteMeeting(id: string): void
  export function sweepExpiredMeetingAudio(): void
  ```

- [ ] **Step 1: Add the `CREATE TABLE` statement**

In `initDB()`, immediately after the existing `usage_daily` table's `db.exec(...)` block (after the closing backtick+`)` around line 68 per current file layout — the exact insertion point is "right before `cleanupSessions()` is called"), add:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      transcript_path TEXT,
      audio_mic_path TEXT,
      audio_system_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);
  `)
```

Then, after `cleanupSessions()` is called in `initDB()` (currently the line right before the `cleanupTimer` setup), add a call to the new sweep function and fold it into the existing hourly timer rather than creating a second `setInterval` — modify the existing block:

```ts
  cleanupSessions()
  sweepExpiredMeetingAudio()
  // A write-triggered cleanup is not a hard retention guarantee for someone
  // who leaves the app open overnight. Reap on a short, unref'd cadence too.
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = setInterval(() => { cleanupSessions(); sweepExpiredMeetingAudio() }, 60 * 60 * 1000)
  cleanupTimer.unref?.()
```

- [ ] **Step 2: Add the `DBMeeting` interface**

Near the existing `DBSession` interface, add:

```ts
export interface DBMeeting {
  id: string
  title: string
  started_at: number
  ended_at: number
  duration_ms: number
  status: 'recording' | 'transcribing' | 'ready' | 'failed'
  transcript_path: string | null
  audio_mic_path: string | null
  audio_system_path: string | null
}
```

- [ ] **Step 3: Add `insertMeeting()`**

```ts
export function insertMeeting(meeting: DBMeeting): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO meetings (
      id, title, started_at, ended_at, duration_ms, status, transcript_path, audio_mic_path, audio_system_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    meeting.id,
    meeting.title,
    meeting.started_at,
    meeting.ended_at,
    meeting.duration_ms,
    meeting.status,
    meeting.transcript_path,
    meeting.audio_mic_path,
    meeting.audio_system_path,
  )
}
```

- [ ] **Step 4: Add `getMeetings()` and `getMeeting()`**

```ts
export function getMeetings(limit = 200): DBMeeting[] {
  return db.prepare('SELECT * FROM meetings ORDER BY started_at DESC LIMIT ?').all(limit) as DBMeeting[]
}

export function getMeeting(id: string): DBMeeting | null {
  return (db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as DBMeeting | undefined) ?? null
}
```

Note: unlike `getSessions()`, these deliberately do NOT call any cleanup function first — the whole point of the `meetings` table is that it is never unconditionally swept, so no read path should trigger a sweep of transcript/DB rows (audio sweeping is separate and time-driven, not read-driven — see Step 6).

- [ ] **Step 5: Add `updateMeetingTitle()` and `deleteMeeting()`**

```ts
export function updateMeetingTitle(id: string, title: string): void {
  db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
}

export function deleteMeeting(id: string): void {
  const meeting = getMeeting(id)
  if (!meeting) return
  const meetingsDir = path.join(app.getPath('userData'), 'meetings', id)
  try {
    fs.rmSync(meetingsDir, { recursive: true, force: true })
  } catch { /* already gone */ }
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
}
```

- [ ] **Step 6: Add `sweepExpiredMeetingAudio()`**

```ts
function sweepExpiredMeetingAudio(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const expired = db.prepare(
    'SELECT id, audio_mic_path, audio_system_path FROM meetings WHERE ended_at < ? AND (audio_mic_path IS NOT NULL OR audio_system_path IS NOT NULL)'
  ).all(cutoff) as { id: string; audio_mic_path: string | null; audio_system_path: string | null }[]

  for (const row of expired) {
    const meetingDir = path.join(app.getPath('userData'), 'meetings', row.id)
    for (const relPath of [row.audio_mic_path, row.audio_system_path]) {
      if (!relPath) continue
      try {
        fs.unlinkSync(path.join(meetingDir, relPath))
      } catch { /* already gone */ }
    }
    db.prepare('UPDATE meetings SET audio_mic_path = NULL, audio_system_path = NULL WHERE id = ?').run(row.id)
  }
}
```

Note this function is NOT exported (matches `cleanupSessions()`'s own non-exported convention) — it's called only from `initDB()`'s startup + hourly-timer wiring in Step 1. If a later task needs to trigger it on demand (e.g. a manual "sweep now" test hook), export it then; don't export speculatively now.

- [ ] **Step 7: Verify the file still compiles**

Run: `cd desktop && npx tsc --noEmit engine-overrides/electron/db.ts 2>&1 | head -30` (or whatever this repo's actual scoped-file typecheck invocation is — check `package.json` for a `typecheck` script first and prefer that if it exists and is fast enough to run on one file's worth of changes)

- [ ] **Step 8: Commit**

```bash
git add desktop/engine-overrides/electron/db.ts
git commit -m "notetaker: add meetings table, CRUD, and 24h audio-only sweep"
```

---

## Task 5: Batch transcription orchestrator

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/transcribeSession.ts`

No test file for this task — it's the composition point that calls the real `tryManagedSTT()` network function and does real filesystem writes; covered by the pure units it calls (Tasks 1-3, already tested) plus manual/on-device verification, matching how `notetakerInit.ts` itself has no test coverage for the same reason.

**Interfaces:**
- Consumes: `encodeWav` (Task 1), `ChunkBuffer`/`FinalizedChannel` (Task 2), `mergeTranscripts`/`generateTitle` (Task 3), `insertMeeting`/`DBMeeting` (Task 4), `tryManagedSTT` (`desktop/electron/paywall-route.ts` — **read this file's actual exported signature before writing the call**, the research pulled `tryManagedSTT(audio: Buffer, durationSeconds: number, flowType, signal?, prompt?): Promise<ManagedSTTResult | null>` but did not confirm `ManagedSTTResult`'s exact shape — confirm it has a `.text` field, or whatever the actual field name is, before assuming)
- Produces:
  ```ts
  export async function transcribeAndPersistSession(
    buffer: ChunkBuffer,
    meetingId: string,
    startedAt: number,
    endedAt: number,
  ): Promise<void>
  ```

- [ ] **Step 1: Read `desktop/electron/paywall-route.ts`'s `tryManagedSTT()` in full**, confirming the exact return type shape (what field the transcript text is actually on — the research's partial excerpt showed `body.data.text` on the *raw HTTP envelope*, but `tryManagedSTT()`'s own TypeScript return type `ManagedSTTResult` may re-shape this; read the function's `return` statement(s) to confirm exactly what field name to read in this task's code).

- [ ] **Step 2: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/transcribeSession.ts
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { tryManagedSTT } from '../paywall-route' // adjust import path to match the real file's actual location relative to this new file
import { encodeWav } from './wavEncoder'
import type { ChunkBuffer } from './chunkBuffer'
import { mergeTranscripts, generateTitle, type TranscriptSegment } from './transcriptMerge'
import { insertMeeting, type DBMeeting } from '../db'

/**
 * Called once, from HookedNotetakerSession's stop() flow (notetakerInit.ts),
 * after a capture session ends. Encodes whatever was buffered on each
 * channel to WAV, transcribes both through the same managed-STT pipeline
 * dictation already uses, merges the results, and persists everything —
 * transcript.json forever, the two audio files for 24h (see db.ts's
 * sweepExpiredMeetingAudio).
 */
export async function transcribeAndPersistSession(
  buffer: ChunkBuffer,
  meetingId: string,
  startedAt: number,
  endedAt: number,
): Promise<void> {
  const meetingDir = path.join(app.getPath('userData'), 'meetings', meetingId)
  fs.mkdirSync(meetingDir, { recursive: true })

  const mic = buffer.finalize('mic')
  const system = buffer.finalize('system')

  let micText = ''
  let systemText = ''
  let micAudioPath: string | null = null
  let systemAudioPath: string | null = null
  let status: DBMeeting['status'] = 'ready'

  try {
    if (mic) {
      const wav = encodeWav(mic.samples, mic.sampleRate, mic.channels)
      fs.writeFileSync(path.join(meetingDir, 'audio-mic.wav'), wav)
      micAudioPath = 'audio-mic.wav'
      const durationMs = (mic.samples.length / mic.channels / mic.sampleRate) * 1000
      const result = await tryManagedSTT(wav, durationMs / 1000, 'dictation')
      micText = result?.text ?? '' // confirm this field name against Step 1's finding before finalizing
    }

    if (system) {
      const wav = encodeWav(system.samples, system.sampleRate, system.channels)
      fs.writeFileSync(path.join(meetingDir, 'audio-system.wav'), wav)
      systemAudioPath = 'audio-system.wav'
      const durationMs = (system.samples.length / system.channels / system.sampleRate) * 1000
      const result = await tryManagedSTT(wav, durationMs / 1000, 'dictation')
      systemText = result?.text ?? ''
    }
  } catch (err) {
    console.error('[notetaker] transcription failed:', err)
    status = 'failed'
  }

  const micDurationMs = mic ? (mic.samples.length / mic.channels / mic.sampleRate) * 1000 : 0
  const systemDurationMs = system ? (system.samples.length / system.channels / system.sampleRate) * 1000 : 0
  const segments: TranscriptSegment[] = mergeTranscripts(
    micText, mic?.firstTimestampMs ?? 0, micDurationMs,
    systemText, system?.firstTimestampMs ?? 0, systemDurationMs,
  )
  const title = generateTitle(segments)

  const transcriptPath = 'transcript.json'
  const target = path.join(meetingDir, transcriptPath)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(segments), 'utf8')
  fs.renameSync(temp, target)

  insertMeeting({
    id: meetingId,
    title,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: endedAt - startedAt,
    status,
    transcript_path: transcriptPath,
    audio_mic_path: micAudioPath,
    audio_system_path: systemAudioPath,
  })
}

export function newMeetingId(): string {
  return randomUUID()
}
```

- [ ] **Step 3: Verify it compiles**

Run whatever this repo's scoped/whole typecheck invocation is (check `package.json`); at minimum confirm no obvious import-path errors by reading the resolved paths against the real file locations.

- [ ] **Step 4: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/transcribeSession.ts
git commit -m "notetaker: add batch transcription + persistence orchestrator"
```

---

## Task 6: Wire the chunk buffer + transcription into `notetakerInit.ts`

**Files:**
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts`

**Interfaces:**
- Consumes: `ChunkBuffer` (Task 2), `transcribeAndPersistSession`/`newMeetingId` (Task 5)

- [ ] **Step 1: Read the current full `notetakerInit.ts`** to confirm the exact current line numbers and surrounding code for the `HookedNotetakerSession` class and the `const session = new HookedNotetakerSession(nativeAudioTap, () => {})` line (already reproduced in this plan's research, but re-read the live file since it may have shifted since this plan was written).

- [ ] **Step 2: Add the chunk buffer and wire a real `onChunk`**

Replace:
```ts
  const session = new HookedNotetakerSession(nativeAudioTap, () => {})
```
with:
```ts
  let chunkBuffer = new ChunkBuffer()
  let sessionStartedAt = 0
  const meetingId = newMeetingId // reference the imported function, called fresh per session below

  const session = new HookedNotetakerSession(nativeAudioTap, (chunk) => {
    chunkBuffer.feed(chunk)
  })
```

Add the import at the top of the file:
```ts
import { ChunkBuffer } from './notetaker/chunkBuffer'
import { transcribeAndPersistSession, newMeetingId } from './notetaker/transcribeSession'
```

- [ ] **Step 3: Record session start time and trigger transcription on stop**

`HookedNotetakerSession`'s `start()` override needs to record `sessionStartedAt = Date.now()` and reset `chunkBuffer = new ChunkBuffer()` (a fresh buffer per session, so a second meeting doesn't append to the first's leftover buffer) BEFORE calling `super.start(pid)` — reset before start, not after, so any chunks that arrive during the (synchronous) `super.start()` call are captured into the fresh buffer, not a stale one. Its `stop()` override needs to capture `const endedAt = Date.now()` and, only in the `wasActive` branch (mirroring the existing `onSessionStop` hook's own guard), kick off `transcribeAndPersistSession(chunkBuffer, meetingId(), sessionStartedAt, endedAt)` — fire-and-forget from `stop()`'s perspective (don't make `stop()` itself async / don't block the caller on transcription finishing; log any rejection so a failure isn't silently swallowed):

```ts
  class HookedNotetakerSession extends NotetakerSession {
    start(pid: number): void {
      chunkBuffer = new ChunkBuffer()
      sessionStartedAt = Date.now()
      super.start(pid)
      hooks.onSessionStart?.()
    }
    stop(): void {
      const wasActive = this.isActive
      super.stop()
      if (wasActive) {
        hooks.onSessionStop?.()
        const endedAt = Date.now()
        transcribeAndPersistSession(chunkBuffer, newMeetingId(), sessionStartedAt, endedAt).catch((err) => {
          console.error('[notetaker] failed to transcribe/persist session:', err)
        })
      }
    }
  }
```

(Drop the unused `const meetingId = newMeetingId` line from Step 2 — the ID should be generated fresh at stop time, once per completed session, not reused across sessions or generated redundantly at construction time. Adjust Step 2's snippet accordingly when actually editing the file — this step supersedes it.)

- [ ] **Step 4: Rebuild verification**

There is no native rebuild needed for this task (pure TS changes). Run: `bash -n desktop/build/wire-into-engine.sh` is not relevant here either — this task doesn't touch build scripts. Just confirm the file's imports resolve (typecheck or a quick `node --import tsx -e "require('./engine-overrides/electron/notetakerInit.ts')"`-style smoke check is not practical for an electron-coupled file — rely on typecheck).

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerInit.ts
git commit -m "notetaker: wire chunk buffering and batch transcription into the stop flow"
```

---

## Task 7: IPC + preload surface for listing/reading/renaming/deleting meetings

**Files:**
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts` (add `ipcMain.handle` registrations)
- Modify: `desktop/electron/remote-preload.ts` (expose renderer-facing methods, following the exact pattern the existing `notetaker:cancel-requested` entry already established in this file)

**Interfaces:**
- Produces (renderer-facing, via preload): `listMeetings(): Promise<DBMeeting[]>`, `getMeetingTranscript(id: string): Promise<TranscriptSegment[]>`, `renameMeeting(id: string, title: string): Promise<void>`, `deleteMeeting(id: string): Promise<void>`, `getMeetingAudioUrl(id: string, channel: 'mic' | 'system'): Promise<string | null>` (returns a `file://` URL for an `<audio>` element, or null if the audio's been swept)

- [ ] **Step 1: Read the real `remote-preload.ts`'s existing `notetaker:cancel-requested` entry in full** (already partially described in the branch's own prior work this session — re-read the live file) to find the exact pattern for adding new `ipcRenderer.invoke`-based methods to the exposed API surface, and the exact `electronAPI` object shape it's spread into.

- [ ] **Step 2: Add `ipcMain.handle` registrations in `notetakerInit.ts`**, alongside the existing `ipcMain.on('notetaker:cancel-requested', ...)` registration:

```ts
  ipcMain.handle('notetaker:list-meetings', () => {
    return getMeetings()
  })

  ipcMain.handle('notetaker:get-transcript', (_event, id: string) => {
    const meeting = getMeeting(id)
    if (!meeting || !meeting.transcript_path) return []
    const meetingDir = path.join(app.getPath('userData'), 'meetings', id)
    try {
      const raw = fs.readFileSync(path.join(meetingDir, meeting.transcript_path), 'utf8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  })

  ipcMain.handle('notetaker:rename-meeting', (_event, id: string, title: string) => {
    updateMeetingTitle(id, title)
  })

  ipcMain.handle('notetaker:delete-meeting', (_event, id: string) => {
    deleteMeeting(id)
  })

  ipcMain.handle('notetaker:get-audio-url', (_event, id: string, channel: 'mic' | 'system') => {
    const meeting = getMeeting(id)
    if (!meeting) return null
    const relPath = channel === 'mic' ? meeting.audio_mic_path : meeting.audio_system_path
    if (!relPath) return null
    const fullPath = path.join(app.getPath('userData'), 'meetings', id, relPath)
    if (!fs.existsSync(fullPath)) return null
    return `file://${fullPath}`
  })
```

Add the needed imports (`getMeetings`, `getMeeting`, `updateMeetingTitle`, `deleteMeeting` from `../db`; `path`, `fs` if not already imported in this file — check first, `path`/`app` are very likely already imported given the file's existing `notetaker:get-audio-url`-adjacent needs).

- [ ] **Step 3: Add the preload bridge methods**, following the exact real pattern found in Step 1 (do not guess at the shape — match whatever `notetaker:cancel-requested`'s own preload entry actually looks like, including whether this codebase's convention uses `ipcRenderer.invoke` return-promise wrapping directly or some helper).

- [ ] **Step 4: Wire the same additions into `wire-into-engine.sh`'s injection if `remote-preload.ts` requires it** — check whether `remote-preload.ts` is copied/injected by the build script the same way `notetakerWidget.ts` was (per this session's earlier work); if the file is already fully copied wholesale (not sed-patched line-by-line), no build-script change is needed for this task; only touch `wire-into-engine.sh` if the real file's copy mechanism requires it.

- [ ] **Step 5: Verify**

`bash -n desktop/build/wire-into-engine.sh` if touched. Typecheck the two modified TS files.

- [ ] **Step 6: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerInit.ts desktop/electron/remote-preload.ts
git commit -m "notetaker: add IPC surface for listing, reading, renaming, and deleting meetings"
```

---

## Task 8: "Notetaker" sidebar tab

**Files:**
- Modify: `desktop/engine-overrides/renderer/app/App.tsx`

**Interfaces:**
- Produces: new `Tab` union member `'notetaker'`, a `NotetakerTab` component (created in Task 9/10, referenced here)

- [ ] **Step 1: Extend the `Tab` union and its doc comment**

```ts
/**
 * Five destinations:
 *   history       what you said
 *   notetaker     the meetings you've recorded
 *   orchestrator  what your agents are doing
 *   account       who you are and what you pay
 *   settings      everything else
 * ...
 */
type Tab = 'history' | 'notetaker' | 'orchestrator' | 'account' | 'settings'
```

- [ ] **Step 2: Add the `SidebarButton` + icon**, in the `<nav>` block, placed right after the History button (before Orchestrator):

```tsx
    <SidebarButton
      icon={<NotetakerIcon />}
      label="Notetaker"
      active={activeTab === 'notetaker'}
      onClick={() => setActiveTab('notetaker')}
    />
```

Add a matching icon function near `HistoryIcon()`, using the exact same size/stroke conventions (`width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"`) but a distinct glyph — a simple microphone-with-waveform or document glyph, e.g.:

```tsx
function NotetakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <line x1="5.5" y1="6" x2="10.5" y2="6" />
      <line x1="5.5" y1="9" x2="10.5" y2="9" />
    </svg>
  )
}
```

- [ ] **Step 3: Add the content-area conditional**

```tsx
    {activeTab === 'notetaker' && <NotetakerTab />}
```

Add the import at the top of `App.tsx`: `import { NotetakerTab } from '../notetaker/NotetakerTab'` (path per wherever Task 9/10's component actually lands — adjust to match this repo's real relative-import conventions between `app/App.tsx` and sibling feature directories, checking how `History` or `OrchestratorTab` are themselves imported as the template).

- [ ] **Step 4: This task will not compile in isolation** (it references `NotetakerTab`, built in Task 9). That's expected — Tasks 8-10 are sequenced but tightly coupled; do NOT attempt to make Task 8 compile standalone by stubbing `NotetakerTab` — Task 9 supplies the real component immediately after. Commit this task's change alongside Task 9's in one combined commit if that's cleaner for the implementer, or note in the commit message that Task 9 completes the wiring.

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/renderer/app/App.tsx
git commit -m "notetaker: add Notetaker sidebar tab (NotetakerTab wired in next commit)"
```

---

## Task 9: Meetings list view + Notetaker settings sub-view

**Files:**
- Create: `desktop/engine-overrides/renderer/notetaker/NotetakerTab.tsx`
- Create: `desktop/engine-overrides/renderer/notetaker/MeetingsList.tsx`
- Create: `desktop/engine-overrides/renderer/notetaker/NotetakerSettings.tsx`

No test file — this is Electron/DOM-dependent renderer UI, consistent with every other tab component in this codebase (`History`, `Orchestrator`'s sub-pages) having no `node:test` coverage.

**Interfaces:**
- Consumes: the preload-exposed `listMeetings()`/`renameMeeting()`/`deleteMeeting()` methods (Task 7) — read `desktop/engine-overrides/renderer/app/App.tsx`'s existing `History` or `Account` component to find the real convention for how a renderer component calls into the exposed `electronAPI` (e.g. `window.electronAPI.someMethod()` vs. a wrapped hook) before writing these, rather than guessing at the access pattern.
- Produces: `NotetakerTab` (top-level, exported for Task 8), rendering a `SegmentedControl` (reuse `_shared.tsx`'s existing component, imported the same way `OrchestratorTab` does) with two pages: Meetings / Settings.

- [ ] **Step 1: Read the real access pattern**

Read `desktop/engine-overrides/renderer/app/History.tsx` (or whichever existing tab component makes an IPC call) in full to find: how it imports/accesses the exposed preload API, how it handles loading/empty states, and its general styling conventions (Tailwind classes, spacing) so the new components feel native to this app rather than introducing a new visual language.

- [ ] **Step 2: Write `NotetakerTab.tsx`**

```tsx
// desktop/engine-overrides/renderer/notetaker/NotetakerTab.tsx
import { useState } from 'react'
import { SegmentedControl } from '../app/_shared' // adjust path to match the real relative location
import { MeetingsList } from './MeetingsList'
import { NotetakerSettings } from './NotetakerSettings'

type NotetakerPage = 'meetings' | 'settings'

export function NotetakerTab() {
  const [page, setPage] = useState<NotetakerPage>('meetings')

  return (
    <>
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight">Notetaker</h2>
        <SegmentedControl
          options={[
            { value: 'meetings', label: 'Meetings' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={page}
          onChange={(value) => setPage(value as NotetakerPage)}
        />
      </div>

      {page === 'meetings' && <MeetingsList />}
      {page === 'settings' && <NotetakerSettings />}
    </>
  )
}
```

Adjust the exact className conventions to match Step 1's findings (this is a template following `OrchestratorTab`'s established shape, verified in this plan's research — confirm the classNames are still accurate against the real, current file before finalizing).

- [ ] **Step 3: Write `MeetingsList.tsx`**

A chronological list (newest first — matches `getMeetings()`'s own `ORDER BY started_at DESC`), each row showing title, exact date, exact time, duration; clicking a row navigates to a detail view (Task 10). Use whatever loading-state/empty-state pattern Step 1's research found in `History.tsx`. Structure:

```tsx
// desktop/engine-overrides/renderer/notetaker/MeetingsList.tsx
import { useEffect, useState } from 'react'
import { MeetingDetail } from './MeetingDetail'

type Meeting = {
  id: string
  title: string
  started_at: number
  ended_at: number
  duration_ms: number
  status: string
}

export function MeetingsList() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    // adjust to the real exposed-API access pattern found in Step 1
    window.electronAPI.listMeetings().then(setMeetings)
  }, [])

  if (selectedId) {
    return <MeetingDetail id={selectedId} onBack={() => setSelectedId(null)} />
  }

  if (meetings === null) {
    return <p className="text-ink-60 text-sm">Loading…</p>
  }

  if (meetings.length === 0) {
    return <p className="text-ink-60 text-sm">No meetings recorded yet. Double-tap Control+Option in a call to start.</p>
  }

  return (
    <div className="flex flex-col gap-1">
      {meetings.map((meeting) => {
        const date = new Date(meeting.started_at)
        const durationMin = Math.round(meeting.duration_ms / 60000)
        return (
          <button
            key={meeting.id}
            onClick={() => setSelectedId(meeting.id)}
            className="text-left px-3 py-2.5 rounded-[10px] hover:bg-ink-07 transition-colors"
          >
            <div className="text-[13px] font-medium text-ink truncate">{meeting.title}</div>
            <div className="text-[11px] text-ink-60">
              {date.toLocaleDateString()} · {date.toLocaleTimeString()} · {durationMin}m
            </div>
          </button>
        )
      })}
    </div>
  )
}
```

(`MeetingDetail` is built in Task 10 — this task's list view references it; sequence Task 9 and Task 10's commits together if that's cleaner, same note as Task 8/9's coupling.)

- [ ] **Step 4: Write `NotetakerSettings.tsx`**

A simple settings view: reference display of the trigger hotkey, and a toggle for whether meeting-detection prompts are shown (independent of manual capture, which always works). This task does NOT need to actually wire a real settings-persistence backend if none conveniently exists yet for this specific toggle — check whether this app already has a generic settings-storage mechanism (likely, given the existing `Settings.tsx`/`SETTINGS_SECTIONS` pattern) and reuse it; if wiring a new persisted setting is nontrivial, it's acceptable for this first pass to render the toggle as inert/display-only with a code comment noting persistence is a follow-up, rather than inventing a new settings-storage mechanism under time pressure — report this explicitly if you take that path.

```tsx
// desktop/engine-overrides/renderer/notetaker/NotetakerSettings.tsx
export function NotetakerSettings() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-ink mb-1">Trigger</h3>
        <p className="text-[12px] text-ink-60">Double-tap Control + Option (left side) to start or stop recording a meeting.</p>
      </div>
    </div>
  )
}
```

(Keep this minimal for v1 — the detection-prompt toggle mentioned in the spec is a nice-to-have; if Step 1's research surfaces no quick way to wire real persistence for it, ship the Trigger reference only and note the toggle as a follow-up rather than half-wiring it.)

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/renderer/notetaker/NotetakerTab.tsx desktop/engine-overrides/renderer/notetaker/MeetingsList.tsx desktop/engine-overrides/renderer/notetaker/NotetakerSettings.tsx
git commit -m "notetaker: add Meetings list + Notetaker settings views"
```

---

## Task 10: Meeting detail view (transcript + audio playback + rename + delete)

**Files:**
- Create: `desktop/engine-overrides/renderer/notetaker/MeetingDetail.tsx`

No test file — same reasoning as Task 9.

**Interfaces:**
- Consumes: `getMeetingTranscript()`, `getMeetingAudioUrl()`, `renameMeeting()`, `deleteMeeting()` (Task 7)

- [ ] **Step 1: Write the implementation**

```tsx
// desktop/engine-overrides/renderer/notetaker/MeetingDetail.tsx
import { useEffect, useState } from 'react'

type TranscriptSegment = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }

export function MeetingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [micAudioUrl, setMicAudioUrl] = useState<string | null>(null)
  const [systemAudioUrl, setSystemAudioUrl] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)

  useEffect(() => {
    // adjust to the real exposed-API access pattern (Task 9 Step 1's finding)
    window.electronAPI.getMeetingTranscript(id).then(setSegments)
    window.electronAPI.getMeetingAudioUrl(id, 'mic').then(setMicAudioUrl)
    window.electronAPI.getMeetingAudioUrl(id, 'system').then(setSystemAudioUrl)
  }, [id])

  const saveTitle = () => {
    window.electronAPI.renameMeeting(id, title)
    setEditingTitle(false)
  }

  const handleDelete = () => {
    window.electronAPI.deleteMeeting(id).then(onBack)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-[12px] text-ink-60 hover:text-ink">&larr; Back</button>
      </div>

      {editingTitle ? (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
          className="text-[18px] font-bold text-ink bg-transparent border-b border-border outline-none"
          autoFocus
        />
      ) : (
        <h2
          className="text-[18px] font-bold text-ink cursor-text"
          onClick={() => setEditingTitle(true)}
        >
          {title}
        </h2>
      )}

      {(micAudioUrl || systemAudioUrl) && (
        <div className="flex flex-col gap-2">
          {micAudioUrl && (
            <div>
              <div className="text-[11px] text-ink-60 mb-1">You</div>
              <audio controls src={micAudioUrl} className="w-full" />
            </div>
          )}
          {systemAudioUrl && (
            <div>
              <div className="text-[11px] text-ink-60 mb-1">Them</div>
              <audio controls src={systemAudioUrl} className="w-full" />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {segments === null && <p className="text-ink-60 text-sm">Loading…</p>}
        {segments?.length === 0 && <p className="text-ink-60 text-sm">No transcript available.</p>}
        {segments?.map((seg, i) => (
          <div key={i} className="text-[13px]">
            <span className="font-semibold text-ink">{seg.channel === 'mic' ? 'You' : 'Them'}: </span>
            <span className="text-ink-80">{seg.text}</span>
          </div>
        ))}
      </div>

      <button
        onClick={handleDelete}
        className="text-[12px] text-red-600 hover:text-red-700 self-start mt-4"
      >
        Delete meeting
      </button>
    </div>
  )
}
```

Fetch the meeting's current title on mount too — the sketch above leaves `title` state uninitialized from the meeting itself; add a `getMeeting`-equivalent read (either extend Task 7's IPC surface with a `getMeetingMeta(id)` handler if `getMeetingTranscript` doesn't already carry the title, or have `MeetingsList` pass the already-fetched title down as a prop instead of re-fetching it — prefer the prop-passing approach, it's simpler and avoids a redundant IPC round-trip; adjust `MeetingsList.tsx`'s `<MeetingDetail id={selectedId} onBack={...} />` call to also pass `initialTitle={meeting.title}` and use that as this component's initial state instead of the empty string shown above).

- [ ] **Step 2: Commit**

```bash
git add desktop/engine-overrides/renderer/notetaker/MeetingDetail.tsx desktop/engine-overrides/renderer/notetaker/MeetingsList.tsx
git commit -m "notetaker: add meeting detail view (transcript, audio playback, rename, delete)"
```

---

## What this plan does not (and cannot) verify

- **Real STT quality on real meeting audio.** The pipeline reuses `tryManagedSTT()` exactly as dictation does, but has never been run against a real captured system-audio WAV file — verify manually with a real call.
- **`ManagedSTTResult`'s exact field name.** Task 5 explicitly flags this as needing confirmation against the real file before finalizing, not assumed.
- **Whether the renderer's `electronAPI` access pattern matches this plan's `window.electronAPI.methodName()` sketches exactly.** Tasks 9/10 explicitly instruct reading the real pattern first — this plan's sketches are illustrative, not guaranteed byte-accurate, same caution as the base plan's Tasks 7/9/10 needed.
- **The Notetaker settings toggle's persistence**, if Task 9 determines it's not a quick wire-up — explicitly allowed to ship display-only with a follow-up note rather than block the task.
- **Real on-device playback of the generated WAV files** and the 24h audio sweep actually firing correctly in a long-running app session.
