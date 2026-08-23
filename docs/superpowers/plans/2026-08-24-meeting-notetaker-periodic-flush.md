# Meeting Notetaker Periodic Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the notetaker's "buffer the whole meeting in RAM, transcribe once at the end" pipeline with periodic per-channel flushing — reusing dictation's proven VAD-cut logic (`vadPolicy.ts`, unchanged, imported as-is) so audio is encoded and sent to STT in small pieces throughout the call, bounding memory to one chunk's worth per channel regardless of meeting length, and removing the ~27-minute hard ceiling the single-shot-at-the-end approach hit.

**Architecture:** Two independent `PeriodicChunkEmitter` instances (mic, system — unsynchronized streams, independent chunk-index sequences) wrap `vadPolicy.decideCut()` with a time-windowed rolling noise floor. Each finalized chunk is downsampled/WAV-encoded/transcribed immediately via the existing `tryManagedSTT()` call, tracked in a per-channel ordered map, and stitched (plain ordered join + hallucination-sentinel stripping, mirroring dictation's `stitchChunks`) once the session stops. `mergeTranscripts` is extended to interleave many small timestamped segments from both channels, not one block per channel.

**Tech Stack:** TypeScript, `node:test` for the new pure logic.

**Spec:** `docs/superpowers/specs/2026-08-24-meeting-notetaker-periodic-flush.md` (builds on `docs/superpowers/specs/2026-08-24-meeting-notetaker-persistence-ui.md`)

## Global Constraints

- Reuse `desktop/engine-overrides/renderer/widget/vadPolicy.ts`'s `decideCut()` and `effectiveSilenceThreshold()` **by importing them directly** — do not reimplement or fork this logic. It is a pure, DOM-free module already usable from anywhere.
- Mic and system channels are independent chunk sequences — no shared index space, no cross-channel synchronization.
- No backend/Cloudflare-worker changes — it is already stateless per-request and needs nothing new.
- Do not reuse `SttArbiter`'s cloud/local-fallback racing — out of scope, this plan only changes chunk timing/count, not which STT path is used (still a single `tryManagedSTT()` call per chunk).
- Plain static `import` statements only, everywhere — no `require()` of sibling source files. This branch has already had one Critical bug from exactly that mistake (empirically proven to crash the app at runtime), fixed once already.
- Test runner: Node's built-in `node:test` via `tsx`, house style `import test, { describe } from 'node:test'` + `import assert from 'node:assert/strict'`.
- Reuse dictation's real tuned defaults, not new numbers: `minChunkMs` 30000, `hardCapMs` 45000, `silenceDurationMs` 400, `softCapWindowMs` 5000, noise-floor window 6000ms (dictation's 60 ticks × ~100ms), floor percentile 0.2, floor margin 1.6x, threshold cap 0.045.

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
  test('all-zero samples produce rms 0', () => {
    assert.equal(computeRms(new Float32Array([0, 0, 0, 0])), 0)
  })

  test('constant-amplitude samples produce that amplitude as rms', () => {
    assert.equal(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5)
  })

  test('known mixed values match the hand-computed rms', () => {
    // rms([1,0,0,0]) = sqrt((1+0+0+0)/4) = 0.5
    assert.equal(computeRms(new Float32Array([1, 0, 0, 0])), 0.5)
  })

  test('empty array returns 0, not NaN', () => {
    assert.equal(computeRms(new Float32Array([])), 0)
  })

  test('single-sample array returns the absolute value of that sample', () => {
    assert.equal(computeRms(new Float32Array([-0.75])), 0.75)
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
 * Standard RMS (root-mean-square) amplitude, for raw Float32 PCM samples
 * already in [-1, 1] range (as delivered by both the native Core Audio tap
 * and the renderer's getUserMedia mic tap) — no byte-to-float normalization
 * needed here, unlike dictation's AnalyserNode-byte-data version.
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
git commit -m "notetaker: add pure RMS calculation for chunk-cut decisions"
```

---

## Task 2: `NoiseFloorTracker` — time-windowed rolling p20 floor

Dictation's noise floor is a 60-*tick* rolling window (ticks fire every ~100ms, so ~6s of history) evaluated every 5th tick. The notetaker's audio arrives as irregular chunks (native buffer callbacks, not a fixed timer), so this port uses a **time-windowed** buffer (evict entries older than 6000ms) instead of a fixed tick count — same ~6s of history, robust to whatever cadence chunks actually arrive at.

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/noiseFloorTracker.ts`
- Test: `desktop/engine-overrides/electron/notetaker/noiseFloorTracker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class NoiseFloorTracker {
    constructor(windowMs?: number, now?: () => number)
    feed(rms: number, timestampMs: number): void
    get floor(): number | null
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/noiseFloorTracker.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { NoiseFloorTracker } from './noiseFloorTracker'

describe('NoiseFloorTracker', () => {
  test('floor is null before any samples are fed', () => {
    const tracker = new NoiseFloorTracker()
    assert.equal(tracker.floor, null)
  })

  test('floor is the p20 value of fed samples', () => {
    const tracker = new NoiseFloorTracker(6000)
    // 10 values 0.01..0.10 at t=0 — p20 index = floor(10*0.2) = 2 -> sorted[2] = 0.03
    for (let i = 1; i <= 10; i++) tracker.feed(i / 100, 0)
    assert.equal(tracker.floor, 0.03)
  })

  test('samples older than the window are evicted', () => {
    const tracker = new NoiseFloorTracker(1000)
    tracker.feed(0.01, 0)
    tracker.feed(0.02, 0)
    tracker.feed(0.03, 0)
    // advance past the window — old samples should no longer count
    tracker.feed(0.5, 2000)
    tracker.feed(0.6, 2000)
    tracker.feed(0.7, 2000)
    // p20 of [0.5,0.6,0.7] -> index floor(3*0.2)=0 -> 0.5
    assert.equal(tracker.floor, 0.5)
  })

  test('a single sample is its own p20 (and floor) value', () => {
    const tracker = new NoiseFloorTracker()
    tracker.feed(0.042, 0)
    assert.equal(tracker.floor, 0.042)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/noiseFloorTracker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/noiseFloorTracker.ts

const DEFAULT_WINDOW_MS = 6000
const FLOOR_PERCENTILE = 0.2

/**
 * Time-windowed rolling p20 RMS — the noise-floor input to vadPolicy.ts's
 * effectiveSilenceThreshold(). Ports dictation's 60-tick/~100ms rolling
 * window (useAudioRecorder.ts) to a time-based window, since notetaker
 * chunks don't arrive on a fixed timer.
 */
export class NoiseFloorTracker {
  private readonly windowMs: number
  private readonly samples: { rms: number; timestampMs: number }[] = []

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs
  }

  feed(rms: number, timestampMs: number): void {
    this.samples.push({ rms, timestampMs })
    const cutoff = timestampMs - this.windowMs
    while (this.samples.length > 0 && this.samples[0].timestampMs < cutoff) {
      this.samples.shift()
    }
  }

  get floor(): number | null {
    if (this.samples.length === 0) return null
    const sorted = this.samples.map((s) => s.rms).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * FLOOR_PERCENTILE)]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/noiseFloorTracker.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/noiseFloorTracker.ts desktop/engine-overrides/electron/notetaker/noiseFloorTracker.test.ts
git commit -m "notetaker: add time-windowed noise-floor tracker"
```

---

## Task 3: `PeriodicChunkEmitter` — per-channel VAD-driven chunk cutting

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/periodicChunkEmitter.ts`
- Test: `desktop/engine-overrides/electron/notetaker/periodicChunkEmitter.test.ts`

**Interfaces:**
- Consumes: `computeRms` (Task 1), `NoiseFloorTracker` (Task 2), `decideCut`/`effectiveSilenceThreshold` from `../../renderer/widget/vadPolicy` (the real, existing, already-tested dictation module — import it directly, do not copy its code)
- Produces:
  ```ts
  export type FinalizedSegment = {
    chunkIndex: number
    samples: Float32Array
    sampleRate: number
    channels: number
    startTimestampMs: number
  }
  export type PeriodicChunkEmitterConfig = {
    minChunkMs?: number
    hardCapMs?: number
    silenceDurationMs?: number
    softCapWindowMs?: number
    silenceThreshold?: number
    noiseFloorWindowMs?: number
  }
  export class PeriodicChunkEmitter {
    constructor(onSegment: (segment: FinalizedSegment) => void, config?: PeriodicChunkEmitterConfig, now?: () => number)
    feed(samples: Float32Array, sampleRate: number, channels: number, timestampMs: number): void
    flush(): void
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/periodicChunkEmitter.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { PeriodicChunkEmitter, type FinalizedSegment } from './periodicChunkEmitter'

function silentSamples(n: number): Float32Array {
  return new Float32Array(n) // all zeros — well below any threshold
}

function loudSamples(n: number): Float32Array {
  const arr = new Float32Array(n)
  arr.fill(0.5)
  return arr
}

describe('PeriodicChunkEmitter', () => {
  test('does not cut before minChunkMs, even on silence', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 1000, silenceDurationMs: 100 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 200
    emitter.feed(silentSamples(10), 16000, 1, clock) // silence, but elapsed < minChunkMs
    assert.equal(segments.length, 0)
  })

  test('cuts on silence once past minChunkMs', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 1000, silenceDurationMs: 100 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 1100 // past minChunkMs
    emitter.feed(silentSamples(10), 16000, 1, clock) // silence starts
    clock = 1250 // 150ms of continuous silence, past silenceDurationMs
    emitter.feed(silentSamples(10), 16000, 1, clock)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].chunkIndex, 0)
  })

  test('force-cuts at hardCapMs regardless of loudness', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 500, hardCapMs: 2000 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 2100
    emitter.feed(loudSamples(10), 16000, 1, clock) // still loud, but past hardCapMs
    assert.equal(segments.length, 1)
  })

  test('chunk index increments across multiple cuts', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 200
    emitter.feed(silentSamples(10), 16000, 1, clock)
    clock = 300
    emitter.feed(silentSamples(10), 16000, 1, clock) // cut 1
    clock = 400
    emitter.feed(loudSamples(10), 16000, 1, clock)
    clock = 600
    emitter.feed(silentSamples(10), 16000, 1, clock)
    clock = 700
    emitter.feed(silentSamples(10), 16000, 1, clock) // cut 2
    assert.equal(segments.length, 2)
    assert.equal(segments[0].chunkIndex, 0)
    assert.equal(segments[1].chunkIndex, 1)
  })

  test('samples accumulate correctly within one segment before a cut', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 }, () => clock)
    emitter.feed(new Float32Array([0.1, 0.2]), 16000, 1, 0)
    clock = 150
    emitter.feed(new Float32Array([0.3, 0.4]), 16000, 1, clock)
    clock = 250
    emitter.feed(silentSamples(2), 16000, 1, clock)
    clock = 350
    emitter.feed(silentSamples(2), 16000, 1, clock) // cut
    assert.deepEqual(Array.from(segments[0].samples), [0.1, 0.2, 0.3, 0.4, 0, 0])
  })

  test('flush() finalizes whatever is accumulated, even if under minChunkMs', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 10000 }, () => clock)
    emitter.feed(new Float32Array([0.1, 0.2]), 16000, 1, 0)
    clock = 500
    emitter.flush()
    assert.equal(segments.length, 1)
    assert.deepEqual(Array.from(segments[0].samples), [0.1, 0.2])
  })

  test('flush() on an empty/no-feed emitter emits nothing', () => {
    const segments: FinalizedSegment[] = []
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s))
    emitter.flush()
    assert.equal(segments.length, 0)
  })

  test('startTimestampMs on a segment is the timestamp of its first fed sample', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 }, () => clock)
    emitter.feed(loudSamples(2), 16000, 1, 12345)
    clock = 12345 + 200
    emitter.feed(silentSamples(2), 16000, 1, clock)
    clock = 12345 + 300
    emitter.feed(silentSamples(2), 16000, 1, clock)
    assert.equal(segments[0].startTimestampMs, 12345)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/periodicChunkEmitter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Before writing, confirm the exact real export names/signatures from `desktop/engine-overrides/renderer/widget/vadPolicy.ts` (`decideCut`, `effectiveSilenceThreshold`, the `CutInput`/`CutDecision` types) by reading that file directly — it should match what's used below, but verify rather than assume, since this is a cross-directory import (`engine-overrides/electron/notetaker/` → `engine-overrides/renderer/widget/`) that hasn't been exercised before on this branch. Confirm the import path resolves (both directories are plain sibling source under `engine-overrides/`, not an OSS-overlay-only file, so a plain relative import should be fine — but verify, don't assume, given this branch's established lesson about cross-tree import surprises).

```ts
// desktop/engine-overrides/electron/notetaker/periodicChunkEmitter.ts
import { decideCut, effectiveSilenceThreshold } from '../../renderer/widget/vadPolicy'
import { computeRms } from './computeRms'
import { NoiseFloorTracker } from './noiseFloorTracker'

export type FinalizedSegment = {
  chunkIndex: number
  samples: Float32Array
  sampleRate: number
  channels: number
  startTimestampMs: number
}

export type PeriodicChunkEmitterConfig = {
  minChunkMs?: number
  hardCapMs?: number
  silenceDurationMs?: number
  softCapWindowMs?: number
  silenceThreshold?: number
  noiseFloorWindowMs?: number
}

const DEFAULTS: Required<PeriodicChunkEmitterConfig> = {
  minChunkMs: 30_000,
  hardCapMs: 45_000,
  silenceDurationMs: 400,
  softCapWindowMs: 5_000,
  silenceThreshold: 0.015,
  noiseFloorWindowMs: 6_000,
}

/**
 * Per-channel periodic chunk cutter — reuses dictation's real, tuned
 * vadPolicy.decideCut() rather than reimplementing chunk-boundary logic.
 * One instance per channel (mic, system); channels are independent chunk
 * sequences, never synchronized.
 */
export class PeriodicChunkEmitter {
  private readonly onSegment: (segment: FinalizedSegment) => void
  private readonly config: Required<PeriodicChunkEmitterConfig>
  private readonly now: () => number
  private readonly noiseFloor: NoiseFloorTracker

  private parts: Float32Array[] = []
  private sampleRate = 0
  private channels = 0
  private segmentStartMs = 0
  private silenceStartMs: number | null = null
  private chunkIndex = 0

  constructor(
    onSegment: (segment: FinalizedSegment) => void,
    config: PeriodicChunkEmitterConfig = {},
    now: () => number = Date.now
  ) {
    this.onSegment = onSegment
    this.config = { ...DEFAULTS, ...config }
    this.now = now
    this.noiseFloor = new NoiseFloorTracker(this.config.noiseFloorWindowMs)
  }

  feed(samples: Float32Array, sampleRate: number, channels: number, timestampMs: number): void {
    if (this.parts.length === 0) {
      this.segmentStartMs = timestampMs
      this.sampleRate = sampleRate
      this.channels = channels
    }
    this.parts.push(samples)

    const rms = computeRms(samples)
    this.noiseFloor.feed(rms, timestampMs)
    const threshold = effectiveSilenceThreshold(this.config.silenceThreshold, this.noiseFloor.floor)

    if (rms < threshold) {
      if (this.silenceStartMs === null) this.silenceStartMs = timestampMs
    } else {
      this.silenceStartMs = null
    }

    const chunkElapsedMs = timestampMs - this.segmentStartMs
    const decision = decideCut({
      rms,
      chunkElapsedMs,
      silenceSinceMs: this.silenceStartMs === null ? null : timestampMs - this.silenceStartMs,
      minChunkMs: this.config.minChunkMs,
      silenceDurationMs: this.config.silenceDurationMs,
      hardCapMs: this.config.hardCapMs,
      softCapWindowMs: this.config.softCapWindowMs,
      threshold,
    })

    if (decision !== 'none') {
      this.finalizeSegment()
    }
  }

  /** Force-finalizes whatever's accumulated — called at session stop for the trailing partial segment. */
  flush(): void {
    if (this.parts.length > 0) {
      this.finalizeSegment()
    }
  }

  private finalizeSegment(): void {
    const totalLength = this.parts.reduce((sum, p) => sum + p.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const part of this.parts) {
      merged.set(part, offset)
      offset += part.length
    }

    this.onSegment({
      chunkIndex: this.chunkIndex,
      samples: merged,
      sampleRate: this.sampleRate,
      channels: this.channels,
      startTimestampMs: this.segmentStartMs,
    })

    this.chunkIndex++
    this.parts = []
    this.silenceStartMs = null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/periodicChunkEmitter.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/periodicChunkEmitter.ts desktop/engine-overrides/electron/notetaker/periodicChunkEmitter.test.ts
git commit -m "notetaker: add PeriodicChunkEmitter reusing dictation's real VAD-cut logic"
```

---

## Task 4: Chunk stitching — ordered join with hallucination-sentinel stripping

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/chunkStitcher.ts`
- Test: `desktop/engine-overrides/electron/notetaker/chunkStitcher.test.ts`

Mirrors dictation's `stitchChunks()` (`sessionManager.ts`) — plain per-chunk cleanup + ordered join, no LLM merge pass, since VAD cuts on silence make naive concatenation safe (same reasoning dictation already relies on).

**Interfaces:**
- Produces:
  ```ts
  export type StitchableChunk = { chunkIndex: number; text: string; startTimestampMs: number }
  export function stitchChannelChunks(chunks: StitchableChunk[]): string
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetaker/chunkStitcher.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { stitchChannelChunks } from './chunkStitcher'

describe('stitchChannelChunks', () => {
  test('joins chunks in chunkIndex order, not array/arrival order', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 1, text: 'world', startTimestampMs: 2000 },
      { chunkIndex: 0, text: 'hello', startTimestampMs: 1000 },
    ])
    assert.equal(result, 'hello world')
  })

  test('strips known Whisper hallucination sentinels', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: '[BLANK_AUDIO]', startTimestampMs: 0 },
      { chunkIndex: 1, text: 'actual speech', startTimestampMs: 1000 },
    ])
    assert.equal(result, 'actual speech')
  })

  test('empty-text chunks contribute nothing (no extra whitespace)', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: 'hello', startTimestampMs: 0 },
      { chunkIndex: 1, text: '', startTimestampMs: 1000 },
      { chunkIndex: 2, text: 'world', startTimestampMs: 2000 },
    ])
    assert.equal(result, 'hello world')
  })

  test('empty input list produces an empty string', () => {
    assert.equal(stitchChannelChunks([]), '')
  })

  test('all-empty/all-hallucination input produces an empty string', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: '[BLANK_AUDIO]', startTimestampMs: 0 },
      { chunkIndex: 1, text: '', startTimestampMs: 1000 },
    ])
    assert.equal(result, '')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/chunkStitcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetaker/chunkStitcher.ts

export type StitchableChunk = { chunkIndex: number; text: string; startTimestampMs: number }

/**
 * Known Whisper hallucination/sentinel outputs on silent or near-silent
 * audio — mirrors dictation's cleanChunk() list (sessionManager.ts).
 */
const HALLUCINATION_SENTINELS = [/^\[BLANK_AUDIO\]$/i, /^\[MUSIC\]$/i]

function cleanChunkText(text: string): string {
  const trimmed = text.trim()
  if (HALLUCINATION_SENTINELS.some((re) => re.test(trimmed))) return ''
  return trimmed
}

/**
 * Ordered, code-only join of a channel's per-chunk transcripts — no LLM
 * merge pass. Safe because chunks are cut on silence (never mid-word,
 * except the rare hard-cap), the same assumption dictation's stitchChunks
 * already relies on.
 */
export function stitchChannelChunks(chunks: StitchableChunk[]): string {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  return ordered
    .map((c) => cleanChunkText(c.text))
    .filter((t) => t.length > 0)
    .join(' ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/chunkStitcher.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/chunkStitcher.ts desktop/engine-overrides/electron/notetaker/chunkStitcher.test.ts
git commit -m "notetaker: add per-channel chunk stitching"
```

---

## Task 5: Extend `mergeTranscripts` to interleave many timestamped segments per channel

**Files:**
- Modify: `desktop/engine-overrides/electron/notetaker/transcriptMerge.ts`
- Modify: `desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts`

Currently `mergeTranscripts` takes one whole-recording string per channel. With periodic flushing there are now many chunks per channel, each with its own real timestamp — this is a genuine quality improvement (real interleaved turns instead of two giant blocks), not just a refactor to keep the old behavior working.

**Interfaces:**
- Consumes: `StitchableChunk` shape is close to but not identical to what's needed here — this task takes already-**transcribed** chunks (with real per-chunk start/end times), not raw audio.
- Produces (new signature, replacing the old one):
  ```ts
  export type TimedChunkText = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }
  export function mergeChannelChunks(micChunks: TimedChunkText[], systemChunks: TimedChunkText[]): TranscriptSegment[]
  ```
  (`TranscriptSegment` type and `generateTitle` are unchanged from the existing file — only add the new function and its supporting type; do not remove the old `mergeTranscripts` if anything else on the branch still calls it — check via grep first, and only remove it if nothing else references it, replacing all real call sites with `mergeChannelChunks` as part of Task 6.)

- [ ] **Step 1: Read the current real file** (`desktop/engine-overrides/electron/notetaker/transcriptMerge.ts`) in full to confirm the exact current exports before adding to it.

- [ ] **Step 2: Write the failing test** (add to the existing `transcriptMerge.test.ts`, do not replace its existing `mergeTranscripts`/`generateTitle` tests — those stay valid for whichever call sites, if any, still use the old function after Task 6 rewires things)

```ts
// add to desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts
import { mergeChannelChunks } from './transcriptMerge' // add to the existing import line

describe('mergeChannelChunks', () => {
  test('interleaves mic and system chunks by startMs, not by channel', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'hi there', startMs: 0, endMs: 3000 }],
      [{ channel: 'system', text: 'hey', startMs: 4000, endMs: 6000 }]
    )
    assert.equal(segments.length, 2)
    assert.equal(segments[0].channel, 'mic')
    assert.equal(segments[1].channel, 'system')
  })

  test('multiple chunks per channel all appear as separate ordered segments', () => {
    const segments = mergeChannelChunks(
      [
        { channel: 'mic', text: 'first', startMs: 0, endMs: 1000 },
        { channel: 'mic', text: 'second', startMs: 5000, endMs: 6000 },
      ],
      [{ channel: 'system', text: 'reply', startMs: 2000, endMs: 3000 }]
    )
    assert.equal(segments.length, 3)
    assert.deepEqual(segments.map((s) => s.text), ['first', 'reply', 'second'])
  })

  test('empty-text chunks are dropped', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: '', startMs: 0, endMs: 1000 }],
      [{ channel: 'system', text: 'real text', startMs: 2000, endMs: 3000 }]
    )
    assert.equal(segments.length, 1)
    assert.equal(segments[0].channel, 'system')
  })

  test('both channels empty produces no segments', () => {
    assert.deepEqual(mergeChannelChunks([], []), [])
  })

  test('preserves the channel label on each segment (does not merge adjacent-time segments across channels)', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'a', startMs: 0, endMs: 1000 }],
      [{ channel: 'system', text: 'b', startMs: 1000, endMs: 2000 }]
    )
    assert.equal(segments.length, 2)
    assert.notEqual(segments[0].channel, segments[1].channel)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/transcriptMerge.test.ts`
Expected: FAIL on the new `mergeChannelChunks` tests (existing tests still pass)

- [ ] **Step 4: Write the implementation** — add to the existing file, do not remove existing exports without confirming (per Step 1's grep check) that nothing else on the branch still calls them:

```ts
// add to desktop/engine-overrides/electron/notetaker/transcriptMerge.ts

export type TimedChunkText = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }

/**
 * Interleaves already-transcribed, already-stitched chunks from both
 * channels into one ordered transcript, by real per-chunk start time —
 * a genuine improvement over the old one-block-per-channel merge, now
 * that periodic flushing gives real per-chunk timestamps.
 */
export function mergeChannelChunks(micChunks: TimedChunkText[], systemChunks: TimedChunkText[]): TranscriptSegment[] {
  const all: TranscriptSegment[] = [...micChunks, ...systemChunks]
    .filter((c) => c.text.trim().length > 0)
    .map((c) => ({ channel: c.channel, text: c.text.trim(), startMs: c.startMs, endMs: c.endMs }))

  return all.sort((a, b) => a.startMs - b.startMs)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/transcriptMerge.test.ts`
Expected: PASS, all existing tests + 5 new ones

- [ ] **Step 6: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/transcriptMerge.ts desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts
git commit -m "notetaker: extend transcript merge to interleave many timestamped chunks per channel"
```

---

## Task 6: Wire periodic flushing into the real capture/transcribe/persist flow

**Files:**
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts`
- Modify: `desktop/engine-overrides/electron/notetaker/transcribeSession.ts` (likely superseded/heavily rewritten — read first, decide whether to modify in place or replace its role)

This is the integration task — replace `ChunkBuffer`'s buffer-everything-until-stop model with two `PeriodicChunkEmitter` instances that transcribe immediately per chunk.

- [ ] **Step 1: Read the real current state of both files in full.** They have been through several rounds of fixes this session (mic-capture wiring, downsample/resample, before-quit handling, a placeholder DB row at session start, ungated meeting-browsing IPC handlers, poll throttling) — do not assume the plan's earlier descriptions of these files are still accurate; read them fresh.

- [ ] **Step 2: Replace the single `ChunkBuffer` with two `PeriodicChunkEmitter` instances**, one per channel, constructed in `HookedNotetakerSession.start()` (reset fresh per session, same as the current `ChunkBuffer` reset pattern) — each with an `onSegment` callback that:
  1. Downsamples/resamples the segment via the existing `downmixAndResample` (from Task 2 of the persistence plan, already merged — confirm its real exported name/signature by reading `desktop/engine-overrides/electron/notetaker/resample.ts`).
  2. WAV-encodes via the existing `encodeWav`.
  3. Calls `tryManagedSTT()` immediately (do not await synchronously in a way that blocks feeding further chunks — fire it and track the promise).
  4. Stores the result (or the in-flight promise) in a per-channel ordered tracker — a plain `Map<number, { text: string | null; startTimestampMs: number; endTimestampMs: number; promise: Promise<void> }>` is sufficient, no need to port `SttArbiter`'s full machinery (out of scope per the spec).
  5. Once resolved, records `{ chunkIndex, text, startTimestampMs, endTimestampMs }` for later stitching. On a `null`/failure result (mirroring the existing Finding-3 fix's reasoning — a `null` on real captured audio should count as a failure, not silent empty text), still record it (empty text) but track that at least one chunk failed, so the final meeting `status` can still be set to `'failed'` if any chunk never got a real transcript, matching the existing all-or-nothing failure semantics already established for the channel-level `failed` flag — just now potentially set by any one chunk within a channel failing, not only a whole-channel STT call.

- [ ] **Step 3: Feed both emitters from their existing real sources** — the system-audio native-tap callback and the `notetaker:mic-chunk` IPC handler (both already exist and currently feed the old single `ChunkBuffer`; redirect them to `micEmitter.feed(...)` / `systemEmitter.feed(...)` respectively, using each raw chunk's real `samples`, `sampleRate`, `channels`, `timestampMs` exactly as already delivered — no change to the upstream capture code itself, only where its output is routed).

- [ ] **Step 4: On session stop**, in `HookedNotetakerSession.stop()`'s `wasActive` branch: call `micEmitter.flush()` and `systemEmitter.flush()` to finalize each channel's trailing partial segment (this fires one more `onSegment` call each, same as any other cut — the transcription/tracking path from Step 2 handles it identically, no special-casing needed), then await all in-flight per-channel chunk-transcription promises (`Promise.all` over both trackers' promises), then:
  1. Stitch each channel's ordered chunk texts into per-chunk `TimedChunkText[]` lists — actually, per the spec's design (§2, "genuine improvement... multiple time-anchored turns per channel instead of one giant block"), do NOT collapse a channel's chunks into one stitched string before merging — pass the per-chunk `TimedChunkText[]` array directly to `mergeChannelChunks` (Task 5) so each chunk remains its own segment in the final interleaved transcript. (`chunkStitcher.ts`'s `stitchChannelChunks`, Task 4, is still useful if you want a plain single-string-per-channel fallback for anything that needs one whole-channel string — e.g. title generation's `generateTitle` currently takes `TranscriptSegment[]` and just reads the first one, which still works fine against the new richer segment list; decide whether `stitchChannelChunks` ends up used anywhere in this real wiring or turns out to be unnecessary given `mergeChannelChunks` operates on already-fine-grained chunks — if it's genuinely unused after this task, that's fine, its tests still stand as valid coverage of a real, correct utility function, matching this codebase's general tolerance for a small amount of currently-unused-but-correct infrastructure.)
  2. Call `mergeChannelChunks(micTimedChunks, systemTimedChunks)` to produce the final `TranscriptSegment[]`.
  3. `generateTitle(segments)` as before.
  4. Write `transcript.json` (same atomic-write pattern already in place).
  5. `insertMeeting(...)` / update the existing placeholder row to its final `status`/`transcript_path` — same as the current flow, just fed by the new segment list instead of the old two-string merge.

- [ ] **Step 5: Memory-bound self-check** — after implementing, re-read `PeriodicChunkEmitter.finalizeSegment()` (Task 3, already correct by construction: `this.parts = []` resets after each emission) and confirm nothing in this task's new wiring code retains a reference to a finalized segment's `samples` after it's been WAV-encoded and handed to `tryManagedSTT()` — once the encoded `Buffer` is created, the original `Float32Array` should be eligible for garbage collection. This directly addresses the "long meetings risk large memory spikes" finding from the plan's own final review; note in your report whether you're confident this holds.

- [ ] **Step 6: No test file for this task** — same reasoning as the rest of `notetakerInit.ts`: electron-coupled composition root, consistent with its existing lack of `node:test` coverage.

- [ ] **Step 7: Verify typecheck** — same scoped approach established earlier on this branch (check `.superpowers/sdd/2026-08-24-meeting-notetaker-persistence/progress.md` for the exact command and current baseline error count if you want to cross-check); confirm no new errors beyond whatever baseline already exists.

- [ ] **Step 8: Run the full pure-logic test suite for everything this task depends on**, to confirm nothing upstream broke:

Run: `cd desktop && node --import tsx --test 'engine-overrides/electron/notetaker/**/*.test.ts'`
Expected: PASS, all tests (Tasks 1-5 plus the pre-existing `wavEncoder`/`chunkBuffer`/`resample` tests) — note `chunkBuffer.ts`/`chunkBuffer.test.ts` from the earlier persistence plan may now be unused if `PeriodicChunkEmitter` fully replaces it; if so, it's fine to leave the old file and its tests in place as long as nothing broken references it (do not delete it as part of this task unless you've confirmed via grep that literally nothing else uses `ChunkBuffer` anymore — deleting working, tested code that might still have a real caller is a bigger, separate decision than this task's scope).

- [ ] **Step 9: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerInit.ts desktop/engine-overrides/electron/notetaker/transcribeSession.ts
git commit -m "notetaker: wire periodic per-channel flushing into the capture/transcribe/persist flow"
```

---

## What this plan does not (and cannot) verify

- **Real on-device behavior of the VAD cut timing on live meeting audio** — the thresholds/windows are dictation's real tuned values, but meeting audio (especially the system-audio channel, which is someone else's voice through a call app, not a close-mic'd single speaker) may have different silence/noise characteristics than dictation's use case. This needs an on-device meeting recording to sanity-check, same as everything else on this branch's own on-device verification list.
- **Whether `ChunkBuffer` (from the earlier persistence plan) becomes fully dead code** — Task 6 explicitly does not force its removal; that's a separate, later cleanup decision once it's confirmed nothing else references it.
- **STT cost/rate implications of many small chunk uploads instead of one large one** — dictation already does this at scale, so the backend/billing path is proven, but the notetaker's usage pattern (potentially many more, longer-running sessions) hasn't been checked against any rate limits.
