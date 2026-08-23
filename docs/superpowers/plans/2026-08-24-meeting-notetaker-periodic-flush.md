# Meeting Notetaker Periodic Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the notetaker's whole-meeting-buffered-then-transcribed-once pipeline with per-channel periodic flushing — reusing dictation's existing, proven VAD-cut chunking (`vadPolicy.ts`) instead of inventing a new mechanism. Fixes the unbounded in-memory buffering (~2GB/hour) and the ~27-minute hard ceiling the last final review flagged as unresolved.

**Architecture:** Two independent `ChunkEmitter` instances (mic, system) each run incoming `TimestampedChunk`s through `vadPolicy.decideCut()` — the exact pure function dictation already uses — and fire a callback the instant a cut lands, instead of only at meeting end. Each fired chunk is immediately downmixed/resampled/WAV-encoded/transcribed via a `ChannelTranscriptionTracker`, which fires the STT call right away and tracks results by index so they can be joined in order once all are settled — mirroring dictation's `chunkTracker`/`stitchChunks` pattern exactly. Each channel still ends up as one final string (built from many small pieces instead of one giant one), so `mergeTranscripts` (already built, already tested) needs **no changes at all** — this is the key simplification that keeps this plan small.

**Tech Stack:** TypeScript, `node:test` for pure-logic tests (Tasks 1-3 are fully pure and testable; Task 4 wires them into the real Electron composition root, no test coverage expected there, same as every other file in `notetakerInit.ts`'s neighborhood).

**Spec:** `docs/superpowers/specs/2026-08-24-meeting-notetaker-periodic-flush.md` (builds on `docs/superpowers/specs/2026-08-24-meeting-notetaker-persistence-ui.md`)

## Global Constraints

- Reuse `desktop/engine-overrides/renderer/widget/vadPolicy.ts`'s `decideCut()` **directly, by import** — do not reimplement or fork its logic. It is already pure/DOM-free and importable from the Electron main process as-is.
- Chunk boundary parameters match dictation's real defaults: `minChunkMs: 30000`, `hardCapMs: 45000`, `silenceDurationMs: 400`, `softCapWindowMs: 5000`. Threshold uses `effectiveSilenceThreshold()` (also from `vadPolicy.ts`), adaptive per-channel, not a fixed constant.
- Mic and system channels get **independent** chunk-index sequences — do not force them onto one shared index space.
- Elapsed-time tracking for the VAD cut decision uses the `timestampMs` field already carried on each `TimestampedChunk`, not wall-clock `Date.now()` — this keeps `ChunkEmitter` fully deterministic and testable with synthetic chunk sequences.
- `mergeTranscripts` (`desktop/engine-overrides/electron/notetaker/transcriptMerge.ts`, already built and tested) is NOT modified by this plan — each channel still produces exactly one final string, just assembled from many small transcriptions instead of one.
- Reuse `tryManagedSTT()` (`desktop/electron/paywall-route.ts`) for each chunk's transcription — same function the notetaker already calls once per channel today, now called once per chunk.
- Test runner is Node's built-in `node:test` via `tsx`, house style `import test, { describe } from 'node:test'` + `import assert from 'node:assert/strict'`.
- Plain static `import` statements only, everywhere — no `require()` of sibling source files (a Critical bug already found and fixed once on this branch from exactly this mistake).

---

## Task 1: `computeRms` — pure RMS calculation

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/computeRms.ts`
- Test: `desktop/engine-overrides/electron/notetaker/computeRms.test.ts`

**Interfaces:**
- Produces: `computeRms(samples: Float32Array): number`

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/computeRms.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeRms } from './computeRms'

describe('computeRms', () => {
  test('silence (all zeros) has rms 0', () => {
    assert.equal(computeRms(new Float32Array([0, 0, 0, 0])), 0)
  })

  test('constant amplitude signal has rms equal to that amplitude', () => {
    // rms of a constant-magnitude alternating signal equals the magnitude
    assert.ok(Math.abs(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9)
  })

  test('known values produce the correct rms', () => {
    // rms([3,4]) = sqrt((9+16)/2) = sqrt(12.5) ≈ 3.5355339
    const rms = computeRms(new Float32Array([3, 4]))
    assert.ok(Math.abs(rms - 3.5355339059327378) < 1e-9)
  })

  test('empty input returns 0, not NaN', () => {
    assert.equal(computeRms(new Float32Array([])), 0)
  })

  test('single sample returns its absolute value', () => {
    assert.equal(computeRms(new Float32Array([-0.7])), 0.7)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/computeRms.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/computeRms.ts

/**
 * Root-mean-square of a PCM sample buffer — the same RMS calculation
 * dictation's renderer-side VAD computes from an AnalyserNode, but usable
 * here on plain Float32Array chunks (both channels arrive as raw samples in
 * the Electron main process, not through a Web Audio graph).
 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i]
  }
  return Math.sqrt(sumSquares / samples.length)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/computeRms.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/computeRms.ts desktop/engine-overrides/electron/notetaker/computeRms.test.ts
git commit -m "notetaker: add pure RMS calculation for main-process VAD"
```

---

## Task 2: `ChunkEmitter` — per-channel VAD-cut chunk boundary tracker

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/chunkEmitter.ts`
- Test: `desktop/engine-overrides/electron/notetaker/chunkEmitter.test.ts`

**Interfaces:**
- Consumes: `computeRms` (Task 1); `decideCut`, `effectiveSilenceThreshold`, `CutDecision` from `desktop/engine-overrides/renderer/widget/vadPolicy.ts` (existing, already-tested pure module — import directly, do not copy); `TimestampedChunk`-shaped input `{ samples: Float32Array; sampleRate: number; channels: number; timestampMs: number }`
- Produces:
  ```ts
  export type EmittedChunk = { index: number; samples: Float32Array; sampleRate: number; channels: number; startTimestampMs: number }
  export class ChunkEmitter {
    constructor(onChunkReady: (chunk: EmittedChunk) => void, config?: Partial<ChunkEmitterConfig>)
    feed(chunk: { samples: Float32Array; sampleRate: number; channels: number; timestampMs: number }): void
    /** Force-finalize whatever is currently accumulated (called at meeting stop). No-op if nothing buffered. */
    flush(): void
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/chunkEmitter.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { ChunkEmitter, type EmittedChunk } from './chunkEmitter'

function silentChunk(timestampMs: number, sampleCount = 100): { samples: Float32Array; sampleRate: number; channels: number; timestampMs: number } {
  return { samples: new Float32Array(sampleCount), sampleRate: 16000, channels: 1, timestampMs }
}

function loudChunk(timestampMs: number, sampleCount = 100): { samples: Float32Array; sampleRate: number; channels: number; timestampMs: number } {
  const samples = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) samples[i] = i % 2 === 0 ? 0.5 : -0.5
  return { samples, sampleRate: 16000, channels: 1, timestampMs }
}

describe('ChunkEmitter', () => {
  test('does not emit before minChunkMs has elapsed, even with silence', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 30000, hardCapMs: 45000, silenceDurationMs: 400 })
    emitter.feed(loudChunk(0))
    emitter.feed(silentChunk(1000))
    emitter.feed(silentChunk(2000))
    assert.equal(emitted.length, 0)
  })

  test('emits on silence once minChunkMs has elapsed and silence persists silenceDurationMs', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 1000, hardCapMs: 45000, silenceDurationMs: 400 })
    emitter.feed(loudChunk(0))
    emitter.feed(loudChunk(1100)) // past minChunkMs, still loud
    emitter.feed(silentChunk(1200))
    emitter.feed(silentChunk(1700)) // 500ms of silence >= silenceDurationMs
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].index, 0)
  })

  test('force-cuts at hardCapMs regardless of silence state', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 1000, hardCapMs: 5000, silenceDurationMs: 400 })
    emitter.feed(loudChunk(0))
    emitter.feed(loudChunk(5100))
    assert.equal(emitted.length, 1)
  })

  test('chunk indices increment across multiple emitted chunks', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 500, hardCapMs: 2000, silenceDurationMs: 200 })
    // first chunk: force cut at hard cap
    emitter.feed(loudChunk(0))
    emitter.feed(loudChunk(2100))
    // second chunk: force cut at hard cap again (elapsed resets after a cut)
    emitter.feed(loudChunk(2200))
    emitter.feed(loudChunk(4300))
    assert.equal(emitted.length, 2)
    assert.equal(emitted[0].index, 0)
    assert.equal(emitted[1].index, 1)
  })

  test('emitted chunk carries the concatenated samples since the last cut', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 500, hardCapMs: 2000, silenceDurationMs: 200 })
    emitter.feed(loudChunk(0, 50))
    emitter.feed(loudChunk(2100, 50))
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].samples.length, 100)
  })

  test('emitted chunk records the timestamp of its first sample, not the cut moment', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 500, hardCapMs: 2000, silenceDurationMs: 200 })
    emitter.feed(loudChunk(1000, 50))
    emitter.feed(loudChunk(3200, 50))
    assert.equal(emitted[0].startTimestampMs, 1000)
  })

  test('after a cut, accumulation restarts fresh for the next chunk', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 500, hardCapMs: 2000, silenceDurationMs: 200 })
    emitter.feed(loudChunk(0, 30))
    emitter.feed(loudChunk(2100, 30)) // cut #1, 60 samples
    emitter.feed(loudChunk(2200, 10))
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].samples.length, 60)
    // nothing emitted yet for chunk #2 — only 10 samples fed, well under hard cap
  })

  test('flush() emits whatever is currently buffered, even if no cut condition fired', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 30000, hardCapMs: 45000, silenceDurationMs: 400 })
    emitter.feed(loudChunk(0, 40))
    emitter.feed(loudChunk(500, 40))
    assert.equal(emitted.length, 0)
    emitter.flush()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].samples.length, 80)
  })

  test('flush() on an emitter with nothing buffered is a no-op', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 30000, hardCapMs: 45000, silenceDurationMs: 400 })
    emitter.flush()
    assert.equal(emitted.length, 0)
  })

  test('flush() after a cut does not re-emit the already-emitted chunk', () => {
    const emitted: EmittedChunk[] = []
    const emitter = new ChunkEmitter((c) => emitted.push(c), { minChunkMs: 500, hardCapMs: 2000, silenceDurationMs: 200 })
    emitter.feed(loudChunk(0, 30))
    emitter.feed(loudChunk(2100, 30))
    assert.equal(emitted.length, 1)
    emitter.flush()
    assert.equal(emitted.length, 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/chunkEmitter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/chunkEmitter.ts
import { computeRms } from './computeRms'
import { decideCut, effectiveSilenceThreshold } from '../../renderer/widget/vadPolicy'

export type EmittedChunk = {
  index: number
  samples: Float32Array
  sampleRate: number
  channels: number
  startTimestampMs: number
}

export type ChunkEmitterConfig = {
  minChunkMs: number
  hardCapMs: number
  silenceDurationMs: number
  softCapWindowMs: number
  silenceThreshold: number
}

const DEFAULT_CONFIG: ChunkEmitterConfig = {
  minChunkMs: 30000,
  hardCapMs: 45000,
  silenceDurationMs: 400,
  softCapWindowMs: 5000,
  silenceThreshold: 0.015,
}

const NOISE_FLOOR_WINDOW = 60

type FedChunk = { samples: Float32Array; sampleRate: number; channels: number; timestampMs: number }

/**
 * Per-channel VAD-cut periodic chunk boundary tracker — reuses
 * vadPolicy.decideCut() (the exact same pure function dictation's
 * useAudioRecorder.ts uses) so chunk boundaries land on silence, never
 * mid-word, with the same 30s-min/45s-hard-cap/soft-cap-near-the-cap
 * behavior already proven in production. Elapsed time is derived from the
 * fed chunks' own `timestampMs`, not wall-clock, so this class is fully
 * deterministic and testable with synthetic sequences.
 */
export class ChunkEmitter {
  private readonly onChunkReady: (chunk: EmittedChunk) => void
  private readonly config: ChunkEmitterConfig
  private parts: FedChunk[] = []
  private chunkStartTimestampMs: number | null = null
  private silenceSinceMs: number | null = null
  private nextIndex = 0
  private rmsHistory: number[] = []

  constructor(onChunkReady: (chunk: EmittedChunk) => void, config: Partial<ChunkEmitterConfig> = {}) {
    this.onChunkReady = onChunkReady
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  feed(chunk: FedChunk): void {
    if (this.chunkStartTimestampMs === null) {
      this.chunkStartTimestampMs = chunk.timestampMs
    }
    this.parts.push(chunk)

    const rms = computeRms(chunk.samples)
    this.rmsHistory.push(rms)
    if (this.rmsHistory.length > NOISE_FLOOR_WINDOW) this.rmsHistory.shift()

    const chunkElapsedMs = chunk.timestampMs - this.chunkStartTimestampMs
    const sorted = [...this.rmsHistory].sort((a, b) => a - b)
    const floorP20 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.2)] : null
    const threshold = effectiveSilenceThreshold(this.config.silenceThreshold, floorP20)

    if (rms < threshold) {
      if (this.silenceSinceMs === null) this.silenceSinceMs = chunk.timestampMs
    } else {
      this.silenceSinceMs = null
    }
    const silenceSinceMs = this.silenceSinceMs === null ? null : chunk.timestampMs - this.silenceSinceMs

    const decision = decideCut({
      rms,
      chunkElapsedMs,
      silenceSinceMs,
      minChunkMs: this.config.minChunkMs,
      silenceDurationMs: this.config.silenceDurationMs,
      hardCapMs: this.config.hardCapMs,
      softCapWindowMs: this.config.softCapWindowMs,
      threshold,
    })

    if (decision !== 'none') {
      this.emitCurrent()
    }
  }

  /** Force-finalize whatever is currently accumulated. Called at meeting stop
   * so the last partial chunk (which may never satisfy a cut condition on
   * its own) still gets transcribed rather than dropped. */
  flush(): void {
    if (this.parts.length > 0) {
      this.emitCurrent()
    }
  }

  private emitCurrent(): void {
    const totalLength = this.parts.reduce((sum, p) => sum + p.samples.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const part of this.parts) {
      merged.set(part.samples, offset)
      offset += part.samples.length
    }
    const first = this.parts[0]

    this.onChunkReady({
      index: this.nextIndex++,
      samples: merged,
      sampleRate: first.sampleRate,
      channels: first.channels,
      startTimestampMs: this.chunkStartTimestampMs!,
    })

    this.parts = []
    this.chunkStartTimestampMs = null
    this.silenceSinceMs = null
    this.rmsHistory = []
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/chunkEmitter.test.ts`
Expected: PASS, 10 tests

Note: the import path `'../../renderer/widget/vadPolicy'` assumes `desktop/engine-overrides/electron/notetaker/chunkEmitter.ts` → `desktop/engine-overrides/renderer/widget/vadPolicy.ts`. Verify this exact relative path resolves correctly given the real directory structure (count the `../` segments against the actual real paths) before finalizing — adjust if the directory layout differs from what's assumed here.

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/chunkEmitter.ts desktop/engine-overrides/electron/notetaker/chunkEmitter.test.ts
git commit -m "notetaker: add per-channel VAD-cut chunk emitter, reusing vadPolicy.decideCut"
```

---

## Task 3: `ChannelTranscriptionTracker` — ordered per-chunk transcription + stitch

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/channelTranscriptionTracker.ts`
- Test: `desktop/engine-overrides/electron/notetaker/channelTranscriptionTracker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ChannelTranscriptionTracker {
    constructor(transcribeFn: (samples: Float32Array, sampleRate: number, promptTail: string | undefined) => Promise<string>)
    /** Fires transcribeFn immediately; does not block the caller. */
    submitChunk(index: number, samples: Float32Array, sampleRate: number): void
    /** Awaits every submitted chunk's transcription and joins them in index order. */
    stitch(): Promise<string>
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/channelTranscriptionTracker.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelTranscriptionTracker } from './channelTranscriptionTracker'

function fakeTranscriber(responses: Record<number, string>, delays: Record<number, number> = {}) {
  let callIndex = 0
  const calls: { index: number; sampleCount: number; promptTail: string | undefined }[] = []
  const tracker = new ChannelTranscriptionTracker(async (samples, _sampleRate, promptTail) => {
    const idx = callIndex++
    calls.push({ index: idx, sampleCount: samples.length, promptTail })
    const delay = delays[idx] ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return responses[idx] ?? ''
  })
  return { tracker, calls }
}

describe('ChannelTranscriptionTracker', () => {
  test('submitChunk fires the transcribe call immediately, not deferred', () => {
    const { tracker, calls } = fakeTranscriber({ 0: 'hello' })
    tracker.submitChunk(0, new Float32Array([1, 2, 3]), 16000)
    assert.equal(calls.length, 1)
  })

  test('stitch() joins chunks in index order regardless of submission order', async () => {
    const { tracker } = fakeTranscriber({ 0: 'first', 1: 'second', 2: 'third' }, { 0: 30, 1: 0, 2: 10 })
    tracker.submitChunk(0, new Float32Array([1]), 16000)
    tracker.submitChunk(1, new Float32Array([1]), 16000)
    tracker.submitChunk(2, new Float32Array([1]), 16000)
    const result = await tracker.stitch()
    assert.equal(result, 'first second third')
  })

  test('stitch() waits for all chunks to settle even if called before they resolve', async () => {
    const { tracker } = fakeTranscriber({ 0: 'slow' }, { 0: 20 })
    tracker.submitChunk(0, new Float32Array([1]), 16000)
    const result = await tracker.stitch()
    assert.equal(result, 'slow')
  })

  test('empty transcript results are dropped from the join, not left as blank entries', async () => {
    const { tracker } = fakeTranscriber({ 0: 'hello', 1: '', 2: 'world' })
    tracker.submitChunk(0, new Float32Array([1]), 16000)
    tracker.submitChunk(1, new Float32Array([1]), 16000)
    tracker.submitChunk(2, new Float32Array([1]), 16000)
    const result = await tracker.stitch()
    assert.equal(result, 'hello world')
  })

  test('no chunks submitted produces an empty string, not a throw', async () => {
    const { tracker } = fakeTranscriber({})
    const result = await tracker.stitch()
    assert.equal(result, '')
  })

  test('a failed chunk (rejected promise) does not fail the whole stitch, contributes nothing', async () => {
    let callIndex = 0
    const tracker = new ChannelTranscriptionTracker(async () => {
      const idx = callIndex++
      if (idx === 1) throw new Error('STT failed for this chunk')
      return idx === 0 ? 'hello' : 'world'
    })
    tracker.submitChunk(0, new Float32Array([1]), 16000)
    tracker.submitChunk(1, new Float32Array([1]), 16000)
    tracker.submitChunk(2, new Float32Array([1]), 16000)
    const result = await tracker.stitch()
    assert.equal(result, 'hello world')
  })

  test('passes the previous successfully-transcribed chunk text as promptTail context', async () => {
    const { tracker, calls } = fakeTranscriber({ 0: 'the roadmap', 1: 'for next quarter' })
    tracker.submitChunk(0, new Float32Array([1]), 16000)
    await new Promise((resolve) => setTimeout(resolve, 5))
    tracker.submitChunk(1, new Float32Array([1]), 16000)
    await tracker.stitch()
    assert.equal(calls[0].promptTail, undefined)
    assert.equal(calls[1].promptTail, 'the roadmap')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/channelTranscriptionTracker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/channelTranscriptionTracker.ts

export type TranscribeFn = (samples: Float32Array, sampleRate: number, promptTail: string | undefined) => Promise<string>

/**
 * Per-channel ordered chunk transcription — mirrors dictation's
 * chunkTracker/stitchChunks pattern (sessionManager.ts): fire the STT call
 * the instant a chunk is submitted (never batched or awaited serially
 * against other chunks), track results by index, and join in strict index
 * order at stitch time regardless of which chunk's network call actually
 * resolved first. A chunk whose transcription fails contributes nothing to
 * the final text rather than failing the whole channel — matches dictation's
 * "a dropped chunk shows up as an empty string" behavior.
 */
export class ChannelTranscriptionTracker {
  private readonly transcribeFn: TranscribeFn
  private readonly results = new Map<number, Promise<string>>()
  private lastSubmittedIndex = -1

  constructor(transcribeFn: TranscribeFn) {
    this.transcribeFn = transcribeFn
  }

  submitChunk(index: number, samples: Float32Array, sampleRate: number): void {
    const promptTail = index === 0 ? undefined : this.results.get(index - 1)?.then(
      (text) => text || undefined,
      () => undefined
    )
    const promise = (async () => {
      const resolvedPromptTail = promptTail ? await promptTail : undefined
      try {
        return await this.transcribeFn(samples, sampleRate, resolvedPromptTail)
      } catch {
        return ''
      }
    })()
    this.results.set(index, promise)
    this.lastSubmittedIndex = Math.max(this.lastSubmittedIndex, index)
  }

  async stitch(): Promise<string> {
    const texts: string[] = []
    for (let i = 0; i <= this.lastSubmittedIndex; i++) {
      const promise = this.results.get(i)
      if (!promise) continue
      const text = await promise
      if (text) texts.push(text)
    }
    return texts.join(' ')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/channelTranscriptionTracker.test.ts`
Expected: PASS, 7 tests

Note on the `promptTail` test: verify the exact timing assertion (`calls[1].promptTail === 'the roadmap'`) actually holds given the implementation's async chain — the `await new Promise(setTimeout...)` in the test between submitting chunk 0 and chunk 1 is there to let chunk 0's promise settle before chunk 1 reads it via `promptTail`; if the real implementation's timing doesn't line up with this exactly, adjust either the test's delay or the implementation, whichever is actually wrong, and note which in your report.

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/channelTranscriptionTracker.ts desktop/engine-overrides/electron/notetaker/channelTranscriptionTracker.test.ts
git commit -m "notetaker: add ordered per-chunk transcription tracker with stitching"
```

---

## Task 4: Wire periodic flushing into the real capture/transcription flow

**Files:**
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts`
- Modify: `desktop/engine-overrides/electron/notetaker/transcribeSession.ts`
- Delete: `desktop/engine-overrides/electron/notetaker/chunkBuffer.ts`, `desktop/engine-overrides/electron/notetaker/chunkBuffer.test.ts` (superseded by `ChunkEmitter` — confirm via grep that nothing else references `ChunkBuffer` before deleting)

No new test file for the `notetakerInit.ts` wiring itself — electron composition root, no test coverage anywhere in this neighborhood, same established convention. `transcribeSession.ts`'s restructured logic should stay covered by Tasks 1-3's existing tests for the pieces it now composes; if you extract any new pure logic here that isn't already covered, add a test for it.

**Interfaces:**
- Consumes: `ChunkEmitter`/`EmittedChunk` (Task 2), `ChannelTranscriptionTracker` (Task 3), `computeRms` (Task 1, likely only used internally by `ChunkEmitter`, not directly here), `downmixAndResample` (already exists, from the earlier size-limit fix), `encodeWav` (already exists), `tryManagedSTT` (already exists), `mergeTranscripts`/`generateTitle` (already exist, **unchanged**), `insertMeeting`/`updateMeetingTitle` and the `'recording'`-status-at-start pattern (already exists, from the earlier before-quit fix)

- [ ] **Step 1: Read the real current files in full**

Read `desktop/engine-overrides/electron/notetakerInit.ts` and `desktop/engine-overrides/electron/notetaker/transcribeSession.ts` in their entirety, current state (post all prior fix waves on this branch — the `HookedNotetakerSession` class, the `'recording'`-status placeholder-row logic, the mic-chunk IPC handler, the `ChunkBuffer` usage, `transcribeAndPersistSession`'s current signature and body). Confirm exact current structure before editing — this file has been modified by several fix waves already this session and its exact current shape matters more than any prior description of it.

- [ ] **Step 2: Replace `ChunkBuffer` with two `ChunkEmitter` instances in `notetakerInit.ts`**

Where `chunkBuffer = new ChunkBuffer()` is currently created fresh per session (in `HookedNotetakerSession.start()`), replace with two `ChunkEmitter` instances (one for `'mic'`, one for `'system'`), each wired to call a shared per-session handler when a chunk is ready. The `onChunk` closure currently passed to `HookedNotetakerSession`'s constructor (`(chunk) => chunkBuffer.feed(chunk)`) should route each `TimestampedChunk` to the correct emitter based on `chunk.source`:

```ts
const micEmitter = new ChunkEmitter((emitted) => handleEmittedChunk('mic', emitted))
const systemEmitter = new ChunkEmitter((emitted) => handleEmittedChunk('system', emitted))
// ...
const session = new HookedNotetakerSession(nativeAudioTap, (chunk) => {
  const emitter = chunk.source === 'mic' ? micEmitter : systemEmitter
  emitter.feed(chunk)
})
```

(Adjust exact variable/closure structure to fit the real current file's patterns — this is illustrative, not a literal patch.)

- [ ] **Step 3: Wire `handleEmittedChunk` to downmix/resample/WAV-encode/transcribe immediately**

Create two `ChannelTranscriptionTracker` instances per session (mic, system), reset fresh alongside the emitters at session start. `handleEmittedChunk(channel, emitted: EmittedChunk)` should: downmix/resample the emitted chunk's samples (reusing the existing `downmixAndResample` from the size-limit fix), WAV-encode them (reusing `encodeWav`), and call `tracker.submitChunk(emitted.index, reducedSamples, reducedSampleRate)` where the tracker's injected `transcribeFn` wraps a `tryManagedSTT(wavBuffer, durationSeconds, 'dictation', undefined, promptTail)` call — **this fires the STT call immediately when the chunk is ready, not queued until the meeting ends.**

- [ ] **Step 4: Replace `transcribeAndPersistSession`'s monolithic finalize-and-transcribe with a flush-and-stitch**

At session stop (`HookedNotetakerSession.stop()`'s existing `wasActive` branch, where `transcribeAndPersistSession(...)` is currently called), instead:
1. Call `micEmitter.flush()` and `systemEmitter.flush()` to force-finalize whatever partial audio remains on each channel (this fires one last `handleEmittedChunk` call per channel if there's anything buffered).
2. `await Promise.all([micTracker.stitch(), systemTracker.stitch()])` to get the two final channel strings — this replaces the old single-call-per-channel `tryManagedSTT` invocation entirely.
3. Feed the two stitched strings into `mergeTranscripts(micText, micStartMs, micDurationMs, systemText, systemStartMs, systemDurationMs)` **exactly as today, unchanged** — you'll need to track each channel's overall start timestamp (from its first emitted chunk) and total duration (sum of all emitted chunks' sample counts / sample rate) across the whole session for this call, not just from a single chunk.
4. Write `transcript.json`, call `insertMeeting`/update the placeholder row to `'ready'`/`'failed'` — same as the current logic, just fed from the stitched strings instead of one-shot transcription results.
5. Preserve the existing per-channel failure semantics (a channel with no successfully-transcribed chunks vs. a channel that was never captured at all) — decide sensibly how `ChannelTranscriptionTracker`'s "some chunks failed" state should map to the existing `status: 'failed'` logic (e.g. if literally zero chunks succeeded for a channel that had real audio, that's closer to today's "STT unavailable" failure case; if some chunks succeeded and some didn't, that's a partial transcript, which today's simpler success/failure model doesn't have space for — use your judgment on the smallest sensible mapping onto the existing two-state `status` field, and document the choice in your report rather than silently picking one).

- [ ] **Step 5: Remove `ChunkBuffer`**

Confirm via `grep -rn "ChunkBuffer" desktop/engine-overrides` that nothing else references it once Step 2-4 are done, then delete `desktop/engine-overrides/electron/notetaker/chunkBuffer.ts` and its test file.

- [ ] **Step 6: Verify**

Run the full notetaker test suite: `cd desktop && node --import tsx --test 'engine-overrides/electron/notetaker/**/*.test.ts'` — confirm all pure-logic tests (Tasks 1-3 plus everything already existing) pass. Run the scoped electron-overlay typecheck and the renderer typecheck (both already established on this branch — check the ledger at `.superpowers/sdd/2026-08-24-meeting-notetaker-persistence/progress.md` for the exact commands and expected baseline error counts if you want to cross-check) and confirm no new errors beyond whatever baseline already exists.

- [ ] **Step 7: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerInit.ts desktop/engine-overrides/electron/notetaker/transcribeSession.ts
git rm desktop/engine-overrides/electron/notetaker/chunkBuffer.ts desktop/engine-overrides/electron/notetaker/chunkBuffer.test.ts
git commit -m "notetaker: wire periodic per-chunk flushing into the capture/transcription flow"
```

---

## What this plan does not (and cannot) verify

- **Real STT quality/behavior with many small chunks instead of one large upload** — needs a real recorded meeting on a signed build, same as the base persistence spec's already-flagged #1 on-device test item, now exercised many times per meeting instead of once.
- **Whether the `promptTail` cross-chunk context genuinely improves transcription continuity** for meeting audio the way it does for dictation — dictation's prompt-tail behavior is proven in production for a single speaker's voice; whether it helps as much for a channel that might contain multiple remote speakers (system audio in a group call) is unverified.
- **Real memory behavior under load** — the design bounds memory to roughly one chunk's worth of audio per channel (tens of seconds) rather than the whole meeting, but this needs an actual long-recording test to confirm, not just code review.
