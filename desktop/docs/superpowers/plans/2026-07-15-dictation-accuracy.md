# Dictation Accuracy Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the silent per-chunk cloud→local engine roulette (the #1 proven accuracy killer), and ship the six supporting accuracy fixes decided on 2026-07-14/15: draft-offer UX, chunk-context prompting, adaptive VAD, quiet-capture gating, Mac DSP off, persisted telemetry, and a post-STT cleanup pass.

**Architecture:** A new pure `SttArbiter` class replaces the per-chunk 4s race in `sessionManager.ts`. It enforces: no engine commits mid-recording; post key-up, cloud pastes if ready, a "quick draft" offer arms at 4s, a hard deadline auto-resolves at 12s; the cloud→local switch is one-way and index-ordered so every transcript is full-cloud, cloud-prefix+local-suffix, or full-local — never alternating. All new decision logic lives in small pure modules (`sttArbiter.ts`, `vadPolicy.ts`, `promptTail.ts`, `quietGuard.ts`, `cleanupPass.ts`, `dictationTelemetry.ts`) unit-tested with `node:test`, then wired into the existing files.

**Tech Stack:** TypeScript, Electron (main = `engine-overrides/electron/*` + paywall layer `desktop/electron/*`), React renderer (`engine-overrides/renderer/widget/*`), Cloudflare Worker (`backend/cloudflare/pipeline/`), `node --test` via tsx.

## Global Constraints

- Working dir: `/Users/zodpatel/tools/unmute/unmute-cloud/.claude/worktrees/dictation-accuracy/desktop` (run all commands here; worker tasks run in `../backend/cloudflare/pipeline`).
- Timeout constants (decided, do not change): `SPECULATE_AFTER_MS = 1500`, `OFFER_AFTER_MS = 4000` (post key-up), `HARD_DEADLINE_MS = 12000` (post key-up), `LATE_CLOUD_WINDOW_MS = 30000`. Mid-recording chunks have **no** commit deadline.
- Pure modules must not import `electron`, `./api`, or any paywall file — they run under `node --test`.
- `engine-overrides/` files do NOT hot-reload — full relaunch needed for manual verification (`npm run dev`), but this plan verifies via unit tests + typecheck.
- Never touch OSS-engine-owned surfaces not present in this repo (e.g. `renderer/shared/types` WidgetState union, `main.ts` IPC wiring). New renderer↔main channels go through `desktop/electron/preload-extensions.ts` + `desktop/electron/paywall-glue.ts` + `desktop/electron/main-extensions.ts` registration pattern.
- Existing behavior preserved for: instruction-audio race (keeps old `raceCloudVsLocalSTT`), Sarvam/dual-whisper/dev-override provider paths, hallucination strippers, `<10KB` final-chunk skip, `'en'` server default (explicitly decided to keep).
- Test command: `npm test`. Typecheck: `npm run typecheck`. Commit after every task with the message given in the task.
- History UI for "better take" is deliberately OUT of scope — storage only (`better_transcript` column). Deferred.

---

### Task 1: Test glob + persisted telemetry module

**Files:**
- Modify: `package.json` (test script)
- Create: `engine-overrides/electron/dictationTelemetry.ts`
- Test: `engine-overrides/electron/dictationTelemetry.test.ts`

**Interfaces:**
- Produces: `telemetryFileName(dayMs: number): string`, `telemetryLine(event: string, data: Record<string, unknown>, nowMs: number): string`, `filesToPrune(names: string[], nowMs: number, keepDays?: number): string[]` (pure), and `logTelemetry(event: string, data: Record<string, unknown>): void` + `initTelemetry(dir: string): void` (fs-backed). Later tasks call `logTelemetry(...)` from sessionManager/paywall-glue.

- [ ] **Step 1: Extend the test glob so `engine-overrides/electron/**/*.test.ts` runs**

In `package.json` replace the `test` script value with:

```json
"test": "node --import tsx --import ./electron/remote/test-setup.ts --test 'electron/remote/**/*.test.ts' 'engine-overrides/renderer/widget/**/*.test.ts' 'engine-overrides/electron/**/*.test.ts'"
```

- [ ] **Step 2: Write the failing test**

Create `engine-overrides/electron/dictationTelemetry.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { telemetryFileName, telemetryLine, filesToPrune } from './dictationTelemetry'

test('telemetryFileName formats by UTC day', () => {
  // 2026-07-15T10:00:00Z
  assert.equal(telemetryFileName(Date.UTC(2026, 6, 15, 10)), 'dictation-2026-07-15.jsonl')
})

test('telemetryLine is single-line JSON with ts and event', () => {
  const line = telemetryLine('chunk-resolved', { idx: 2, engine: 'cloud' }, 1234567890)
  const parsed = JSON.parse(line)
  assert.equal(parsed.event, 'chunk-resolved')
  assert.equal(parsed.ts, 1234567890)
  assert.equal(parsed.idx, 2)
  assert.ok(!line.includes('\n'))
})

test('telemetryLine never throws on unserializable data', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const line = telemetryLine('x', cyclic, 1)
  assert.ok(typeof line === 'string' && line.length > 0)
})

test('filesToPrune keeps the newest 7 days of dictation files', () => {
  const now = Date.UTC(2026, 6, 15)
  const names = [
    'dictation-2026-07-15.jsonl',
    'dictation-2026-07-10.jsonl',
    'dictation-2026-07-01.jsonl',
    'unrelated.txt',
  ]
  assert.deepEqual(filesToPrune(names, now), ['dictation-2026-07-01.jsonl'])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — cannot find module `./dictationTelemetry`.

- [ ] **Step 4: Write the implementation**

Create `engine-overrides/electron/dictationTelemetry.ts`:

```ts
// Persisted dictation telemetry — JSONL lines under <userData>/telemetry/.
//
// WHY: the 2026-07-14 accuracy investigation found the production build
// persists NOTHING about how a dictation was actually served (which engine,
// which cut reason, what latency). The console lines vanish with the window.
// One greppable line per event means a bad dictation in the field carries
// its own explanation. Pure helpers are unit-tested; fs writes are
// best-effort appends that must never break a dictation.

import fs from 'fs'
import path from 'path'

const KEEP_DAYS = 7
const FILE_RE = /^dictation-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export function telemetryFileName(dayMs: number): string {
  const d = new Date(dayMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `dictation-${y}-${m}-${day}.jsonl`
}

export function telemetryLine(event: string, data: Record<string, unknown>, nowMs: number): string {
  try {
    return JSON.stringify({ ts: nowMs, event, ...data })
  } catch {
    return JSON.stringify({ ts: nowMs, event, unserializable: true })
  }
}

export function filesToPrune(names: string[], nowMs: number, keepDays: number = KEEP_DAYS): string[] {
  const cutoff = nowMs - keepDays * 24 * 60 * 60 * 1000
  return names.filter((n) => {
    const m = FILE_RE.exec(n)
    if (!m) return false
    const fileMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return fileMs < cutoff
  })
}

let telemetryDir: string | null = null

/** Call once from main with app.getPath('userData')/telemetry. */
export function initTelemetry(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    telemetryDir = dir
    for (const stale of filesToPrune(fs.readdirSync(dir), Date.now())) {
      try { fs.unlinkSync(path.join(dir, stale)) } catch { /* best-effort */ }
    }
  } catch (e) {
    console.warn('[telemetry] init failed:', e instanceof Error ? e.message : e)
    telemetryDir = null
  }
}

export function logTelemetry(event: string, data: Record<string, unknown>): void {
  if (!telemetryDir) return
  const now = Date.now()
  const line = telemetryLine(event, data, now)
  fs.appendFile(path.join(telemetryDir, telemetryFileName(now)), line + '\n', () => { /* best-effort */ })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all pass (253 existing + 4 new).

- [ ] **Step 6: Initialize telemetry from an existing main-process entry point**

`sessionManager.ts` is constructed at import time in the engine main — initialize lazily there instead of touching OSS `main.ts`. In `engine-overrides/electron/sessionManager.ts` add to the imports block (after the `saveAudioFile` import at line 6):

```ts
import { initTelemetry, logTelemetry } from './dictationTelemetry'
import { app } from 'electron'
import path from 'path'
```

And inside `class SessionManager`, add a private field + call in `startSession` (immediately after the `console.log('[session] startSession called...` line):

```ts
  private telemetryReady = false
```

```ts
    if (!this.telemetryReady) {
      this.telemetryReady = true
      try { initTelemetry(path.join(app.getPath('userData'), 'telemetry')) } catch { /* best-effort */ }
    }
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` → clean. Then:

```bash
git add package.json engine-overrides/electron/dictationTelemetry.ts engine-overrides/electron/dictationTelemetry.test.ts engine-overrides/electron/sessionManager.ts
git commit -m "feat(telemetry): persisted per-dictation JSONL telemetry + test glob for electron overrides"
```

---

### Task 2: VAD policy module (adaptive threshold + least-bad cut)

**Files:**
- Create: `engine-overrides/renderer/widget/vadPolicy.ts`
- Test: `engine-overrides/renderer/widget/vadPolicy.test.ts`

**Interfaces:**
- Produces: `effectiveSilenceThreshold(configured: number, floorP20: number | null): number` and `decideCut(input: CutInput): CutDecision` where `type CutDecision = 'none' | 'silence' | 'soft-cap' | 'hard-cap'` and `interface CutInput { rms: number; chunkElapsedMs: number; silenceSinceMs: number | null; minChunkMs: number; silenceDurationMs: number; hardCapMs: number; softCapWindowMs: number; threshold: number }`. Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

Create `engine-overrides/renderer/widget/vadPolicy.test.ts`:

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { effectiveSilenceThreshold, decideCut, type CutInput } from './vadPolicy'

describe('effectiveSilenceThreshold', () => {
  test('quiet room: configured threshold wins', () => {
    assert.equal(effectiveSilenceThreshold(0.015, 0.003), 0.015)
  })
  test('noisy café: raises to floor*1.6 (measured floor 0.013 → 0.0208)', () => {
    assert.ok(Math.abs(effectiveSilenceThreshold(0.015, 0.013) - 0.0208) < 1e-9)
  })
  test('caps at 0.045 so speech can never read as silence', () => {
    assert.equal(effectiveSilenceThreshold(0.015, 0.2), 0.045)
  })
  test('no floor yet (recording just started): configured', () => {
    assert.equal(effectiveSilenceThreshold(0.015, null), 0.015)
  })
})

const base: CutInput = {
  rms: 0.1, chunkElapsedMs: 10_000, silenceSinceMs: null,
  minChunkMs: 30_000, silenceDurationMs: 400, hardCapMs: 45_000,
  softCapWindowMs: 5_000, threshold: 0.015,
}

describe('decideCut', () => {
  test('before minChunkMs: never cuts, even in silence', () => {
    assert.equal(decideCut({ ...base, rms: 0.001, silenceSinceMs: 1000 }), 'none')
  })
  test('sustained silence after minChunkMs cuts', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 31_000, rms: 0.001, silenceSinceMs: 400 }), 'silence')
  })
  test('silence not yet sustained: none', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 31_000, rms: 0.001, silenceSinceMs: 200 }), 'none')
  })
  test('hard cap always cuts', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 45_000, rms: 0.3 }), 'hard-cap')
  })
  test('soft-cap window: near the cap, a dip below 1.5x threshold cuts immediately', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 41_000, rms: 0.02 }), 'soft-cap')
  })
  test('soft-cap window: loud speech does NOT cut', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 41_000, rms: 0.1 }), 'none')
  })
  test('soft-cap window only opens inside hardCap - softCapWindow', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 39_000, rms: 0.02 }), 'none')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -6`
Expected: FAIL — cannot find module `./vadPolicy`.

- [ ] **Step 3: Write the implementation**

Create `engine-overrides/renderer/widget/vadPolicy.ts`:

```ts
// VAD cut policy — the pure decisions behind chunk boundaries.
//
// Field problem (2026-07-14 investigation): the silence threshold was an
// ABSOLUTE rms (0.015) while a real café floor measures 0.012-0.014 — so in
// noise the silence condition never held, every chunk ran to the 45s hard
// cap, and the cap cuts mid-word by design. Two fixes here:
//   * effectiveSilenceThreshold — "silence" is relative to THIS recording's
//     measured noise floor (p20 of the rolling rms window), so café pauses
//     become detectable again.
//   * a soft-cap window — approaching the hard cap, cut at the first
//     relative dip instead of the guillotine, so forced cuts land between
//     words when at all possible.
// Pure module: no DOM, no React — unit-tested by vadPolicy.test.ts.

export type CutDecision = 'none' | 'silence' | 'soft-cap' | 'hard-cap'

export interface CutInput {
  rms: number
  chunkElapsedMs: number
  /** ms of continuous sub-threshold rms so far, or null if currently loud. */
  silenceSinceMs: number | null
  minChunkMs: number
  silenceDurationMs: number
  hardCapMs: number
  softCapWindowMs: number
  threshold: number
}

/** Ceiling: above this, "silence" would overlap real speech rms. */
const THRESHOLD_CAP = 0.045
/** Noise floor multiplier: gaps in speech sit near the floor; speech doesn't. */
const FLOOR_MARGIN = 1.6
/** Soft-cap accepts a dip that isn't full silence — 1.5x the silence bar. */
const SOFT_CAP_DIP = 1.5

export function effectiveSilenceThreshold(configured: number, floorP20: number | null): number {
  if (floorP20 == null) return configured
  return Math.min(Math.max(configured, floorP20 * FLOOR_MARGIN), THRESHOLD_CAP)
}

export function decideCut(input: CutInput): CutDecision {
  if (input.chunkElapsedMs >= input.hardCapMs) return 'hard-cap'
  if (input.chunkElapsedMs < input.minChunkMs) return 'none'
  if (
    input.chunkElapsedMs >= input.hardCapMs - input.softCapWindowMs &&
    input.rms < input.threshold * SOFT_CAP_DIP
  ) {
    return 'soft-cap'
  }
  if (input.rms < input.threshold && input.silenceSinceMs != null && input.silenceSinceMs >= input.silenceDurationMs) {
    return 'silence'
  }
  return 'none'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -6`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine-overrides/renderer/widget/vadPolicy.ts engine-overrides/renderer/widget/vadPolicy.test.ts
git commit -m "feat(vad): pure cut policy — noise-floor-relative silence threshold + least-bad soft-cap"
```

---

### Task 3: Wire VAD policy into the recorder loop

**Files:**
- Modify: `engine-overrides/renderer/widget/useAudioRecorder.ts` (VAD interval ~lines 485-511, emitChunk signature ~line 256)

**Interfaces:**
- Consumes: `effectiveSilenceThreshold`, `decideCut`, `CutDecision` from Task 2.
- Produces: `emitChunk(reason: 'silence' | 'soft-cap' | 'hard-cap')` — log strings now include soft-cap.

- [ ] **Step 1: Import the policy + add a floor ref**

At the top of `useAudioRecorder.ts` (after the `micWarm` import):

```ts
import { effectiveSilenceThreshold, decideCut } from './vadPolicy'
```

Next to the noisy-environment refs (`rmsFramesRef` block, ~line 196), add:

```ts
  // Latest p20 of the rolling rms window — THIS recording's noise floor.
  // Feeds the adaptive silence threshold (vadPolicy) so café pauses cut.
  const noiseFloorRef = useRef<number | null>(null)
```

Reset it in `startRecording` where the other per-recording refs reset (after `rmsFramesRef.current = []`):

```ts
    noiseFloorRef.current = null
```

- [ ] **Step 2: Capture the floor where percentiles are already computed**

Inside the noisy-environment eval block (right after `const floor = sorted[Math.floor(sorted.length * 0.2)]`), add:

```ts
          noiseFloorRef.current = floor
```

- [ ] **Step 3: Replace the chunk-splitting tail of the VAD tick with the policy**

Replace this existing block at the end of the interval callback:

```ts
      const chunkElapsed = Date.now() - chunkStartTimeRef.current

      // Check hard cap first
      if (chunkElapsed >= hardChunkCapMsRef.current) {
        console.log(`[audio:vad] Hard cap at ${chunkElapsed}ms, force-cutting chunk ${chunkIndexRef.current}`)
        emitChunk('hard-cap')
        return
      }

      // Only look for silence after minimum chunk duration
      if (chunkElapsed < chunkMinMsRef.current) return

      if (rms < silenceThresholdRef.current) {
        if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now()
        } else if (Date.now() - silenceStartRef.current >= silenceDurationMsRef.current) {
          // Sustained silence — cut chunk
          emitChunk('silence')
        }
      } else {
        // Audio detected — reset silence timer
        silenceStartRef.current = null
      }
```

with:

```ts
      const chunkElapsed = Date.now() - chunkStartTimeRef.current

      // Adaptive threshold: "silence" is judged relative to THIS recording's
      // measured noise floor, so noisy rooms still get natural cuts instead
      // of running into the hard cap mid-word.
      const threshold = effectiveSilenceThreshold(silenceThresholdRef.current, noiseFloorRef.current)

      // Maintain the silence run-length the policy consumes.
      if (rms < threshold) {
        if (silenceStartRef.current === null) silenceStartRef.current = Date.now()
      } else {
        silenceStartRef.current = null
      }

      const decision = decideCut({
        rms,
        chunkElapsedMs: chunkElapsed,
        silenceSinceMs: silenceStartRef.current === null ? null : Date.now() - silenceStartRef.current,
        minChunkMs: chunkMinMsRef.current,
        silenceDurationMs: silenceDurationMsRef.current,
        hardCapMs: hardChunkCapMsRef.current,
        softCapWindowMs: 5_000,
        threshold,
      })
      if (decision !== 'none') {
        console.log(`[audio:vad] cut=${decision} at ${chunkElapsed}ms (rms=${rms.toFixed(4)}, threshold=${threshold.toFixed(4)}, floor=${(noiseFloorRef.current ?? 0).toFixed(4)})`)
        emitChunk(decision)
      }
```

- [ ] **Step 4: Widen emitChunk's reason type**

Change the `emitChunk` signature from `(reason: 'silence' | 'hard-cap')` to:

```ts
  const emitChunk = useCallback(async (reason: 'silence' | 'soft-cap' | 'hard-cap'): Promise<void> => {
```

and update its log line to print the reason generically:

```ts
    console.log(`[audio:vad] cut reason=${reason}, chunk ${chunkIdx} at ${elapsed}ms (${buffer.byteLength} bytes)`)
```

- [ ] **Step 5: Verify**

Run: `npm test 2>&1 | tail -4` (renderer tests still pass) and `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add engine-overrides/renderer/widget/useAudioRecorder.ts
git commit -m "feat(vad): adaptive silence threshold + soft-cap cuts wired into the recorder loop"
```

---

### Task 4: Mac path — Chromium DSP off

**Files:**
- Modify: `engine-overrides/renderer/widget/useAudioRecorder.ts` (three getUserMedia sites: constraints `else` branch ~line 746, missing-device fallback ~line 800, zombie failover ~line 927)

- [ ] **Step 1: Change the default-path constraints**

Replace the constraints construction:

```ts
    const constraints: MediaStreamConstraints = {
      audio: requestedDeviceId
        ? { deviceId: { exact: requestedDeviceId }, sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { sampleRate: 16000 }
    }
```

with (and update the comment above it):

```ts
    // BOTH paths: Chromium's processing chain OFF. Phone: iOS already applied
    // its own call-tuned DSP (double-cleaning smears speech). Mac (2026-07-15):
    // Whisper is trained on raw real-world audio; Chromium's suppressor was
    // observed scrubbing speech gaps "harder than expected" and its AGC slams
    // plosives. Decision: send the model what the mic heard. If loud-room
    // accuracy regresses in the field, THIS is the first flag to re-flip.
    const RAW_CAPTURE = { sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false } as const
    const constraints: MediaStreamConstraints = {
      audio: requestedDeviceId
        ? { deviceId: { exact: requestedDeviceId }, ...RAW_CAPTURE }
        : { ...RAW_CAPTURE }
    }
```

- [ ] **Step 2: Update the two bare fallback acquisitions**

Both `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })` call sites (missing-device fallback and zombie failover) become:

```ts
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...RAW_CAPTURE } })
```

(For the zombie-failover site inside the gate block, `RAW_CAPTURE` is in scope — it's declared in the same function.)

- [ ] **Step 3: Annotate the stale calibration comment**

The noisy-hint calibration comment (~line 51) says "post-noise-suppression". Append one line to that comment block:

```ts
// 2026-07-15: capture DSP is now OFF — raw floors run higher, so the noisy
// hint may fire more readily. Signal-only; re-calibrate constants if it nags.
```

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck` → clean; `npm test 2>&1 | tail -4` → pass.

```bash
git add engine-overrides/renderer/widget/useAudioRecorder.ts
git commit -m "feat(capture): disable Chromium NS/AGC/EC on the Mac path — raw audio to the model"
```

---

### Task 5: Capture-quality IPC (renderer → main) + telemetry forwarding

**Files:**
- Modify: `desktop/electron/preload-extensions.ts` (add method)
- Modify: `desktop/electron/paywall-glue.ts` (add ipcMain handler, near the `paywall:stream-*` handlers ~line 472)
- Modify: `desktop/electron/main-extensions.ts` (registration hook)
- Modify: `engine-overrides/electron/sessionManager.ts` (store per-session quality)
- Modify: `engine-overrides/renderer/widget/useAudioRecorder.ts` (send at capture end)

**Interfaces:**
- Produces: renderer method `paywallCaptureQuality(sessionId: string | undefined, q: { rmsMax: number; rmsAvg: number; peak: number; zeroFramePct: number; frames: number; source: string }): void`; main-side `sessionManager.setCaptureQuality(sessionId, q)` storing `{ rmsMax: number } & Record<string, unknown>`; Task 10 consumes `this.captureQuality`.

- [ ] **Step 1: Preload method**

In `preload-extensions.ts` inside `paywallPreloadExtensions`, add:

```ts
  // Capture quality report (rmsMax etc.) sent once per recording at stop.
  // Feeds the quiet-capture gate + persisted telemetry in the main process.
  paywallCaptureQuality: (sessionId: string | undefined, q: Record<string, unknown>): void =>
    ipcRenderer.send('paywall:capture-quality', sessionId, q),
```

- [ ] **Step 2: Registration hook in main-extensions.ts**

`main-extensions.ts` already exports `setLastEngine/popLastEngine`. Add alongside them:

```ts
// ── Capture-quality handoff (renderer → glue → sessionManager) ──────────
// paywall-glue owns the ipcMain.on; sessionManager registers a sink here to
// avoid a glue→sessionManager import cycle.
let captureQualitySink: ((sessionId: string | undefined, q: Record<string, unknown>) => void) | null = null
export function registerCaptureQualitySink(fn: (sessionId: string | undefined, q: Record<string, unknown>) => void): void {
  captureQualitySink = fn
}
export function deliverCaptureQuality(sessionId: string | undefined, q: Record<string, unknown>): void {
  try { captureQualitySink?.(sessionId, q) } catch { /* never break IPC */ }
}
```

- [ ] **Step 3: Glue handler**

In `paywall-glue.ts` next to the `paywall:stream-close` handler add (import `deliverCaptureQuality` from `./main-extensions` and `logTelemetry` — note glue is copied into `engine/electron/paywall/`, so the telemetry module resolves as `../dictationTelemetry`):

```ts
  ipcMain.on('paywall:capture-quality', (_e, sessionId: string | undefined, q: Record<string, unknown>) => {
    deliverCaptureQuality(sessionId, q)
    try {
      // Same fact, durable: the physical capture quality of this dictation.
      const { logTelemetry } = require('../dictationTelemetry') as typeof import('../dictationTelemetry')
      logTelemetry('capture-quality', { sessionId: sessionId ?? null, ...q })
    } catch { /* telemetry is best-effort */ }
  })
```

(Use `require` here deliberately: glue is bundled into the paywall dir and a static import path would break the standalone typecheck of this repo — mirror the existing lazy patterns in glue. If glue has no existing `require` pattern, use a static `import { logTelemetry } from '../dictationTelemetry'` and add a matching path mapping only if typecheck complains; whichever compiles cleanly wins.)

- [ ] **Step 4: sessionManager stores it**

In `sessionManager.ts` add to imports (line 21 area): `registerCaptureQualitySink` from `./paywall/main-extensions`. Add a field + registration in the constructor area (the class has no explicit constructor — add one right after the class fields, before `get processing()`):

```ts
  // Physical capture quality of the current recording (rmsMax etc.), reported
  // once by the renderer at stop. Drives the quiet-capture paste gate.
  private captureQuality: { sessionId: string | undefined; rmsMax: number } | null = null

  constructor() {
    registerCaptureQualitySink((sessionId, q) => {
      const rmsMax = typeof q.rmsMax === 'number' ? q.rmsMax : 0
      this.captureQuality = { sessionId, rmsMax }
    })
  }
```

Reset `this.captureQuality = null` in `startSession` (next to the telemetry init added in Task 1).

- [ ] **Step 5: Renderer sends it**

In `useAudioRecorder.ts`, at the end of `emitCaptureSummary` (after the `tlog('capture-summary', ...)` call) add:

```ts
    // Forward the same physical-quality facts to the main process: they gate
    // the quiet-capture paste decision and land in persisted telemetry.
    try {
      const api = window.electronAPI as unknown as {
        paywallCaptureQuality?: (sessionId: string | undefined, q: Record<string, unknown>) => void
      }
      api.paywallCaptureQuality?.(frozenSessionIdRef.current, {
        rmsMax: +tel.rmsMax.toFixed(4),
        rmsAvg: tel.frames ? +(tel.rmsSum / tel.frames).toFixed(4) : 0,
        peak: +tel.peak.toFixed(3),
        zeroFramePct: tel.frames ? Math.round((tel.zeroFrames / tel.frames) * 100) : 0,
        frames: tel.frames,
        source: tel.source,
        via,
        durationMs,
        bytes,
      })
    } catch { /* never break capture */ }
```

Also call `emitCaptureSummary('final-chunk', buffer.byteLength, duration)` in the chunked stop path (both branches of the `chunkedModeEnabledRef.current && chunkIndexRef.current > 0` block in `stopRecording`, just before `window.electronAPI.sendAudioFinalChunk(...)`) — chunked recordings currently never emit a capture summary at all.

- [ ] **Step 6: Verify + commit**

`npm run typecheck` → clean; `npm test` → pass.

```bash
git add desktop/electron/preload-extensions.ts desktop/electron/paywall-glue.ts desktop/electron/main-extensions.ts engine-overrides/electron/sessionManager.ts engine-overrides/renderer/widget/useAudioRecorder.ts
git commit -m "feat(telemetry): capture-quality IPC — renderer physical audio facts reach main + disk"
```

(Note: `desktop/electron/*` paths are relative to the `desktop/` working dir — i.e. `electron/preload-extensions.ts` etc.)

---

### Task 6: SttArbiter — the engine-routing core (pure)

**Files:**
- Create: `engine-overrides/electron/sttArbiter.ts`
- Test: `engine-overrides/electron/sttArbiter.test.ts`

**Interfaces:**
- Produces (consumed by Task 7):

```ts
export type EngineSource = 'cloud' | 'local'
export interface ChunkResolution { text: string; source: EngineSource }
export interface ArbiterEvents {
  onDraftOffer?: () => void
  onDraftResolved?: (how: 'cloud' | 'accepted' | 'deadline') => void
  onLateCloud?: (chunkIndex: number, text: string) => void
}
export interface ArbiterTimeouts { speculateAfterMs: number; offerAfterMs: number; hardDeadlineMs: number; lateCloudWindowMs: number }
export class SttArbiter {
  constructor(events?: ArbiterEvents, timeouts?: Partial<ArbiterTimeouts>)
  submitChunk(idx: number, cloud: Promise<string | null>, startLocal: (() => Promise<string | null>) | null): Promise<ChunkResolution | null>
  recordingEnded(): void
  acceptDraft(): void
  dispose(): void
  get engineSummary(): 'cloud' | 'local' | 'mixed' | 'none'
}
```

Semantics (the contract the tests pin):
1. **Mid-recording, no commits**: before `recordingEnded()`, a chunk resolves ONLY if its cloud resolves with text. Local speculation still starts `speculateAfterMs` after submission (draft warm), but never commits.
2. **Index-ordered one-way switch**: chunks commit in index order. If the switch to local happens at index k (offer accepted or hard deadline), every chunk with index ≥ k resolves local — even if its cloud result arrived — so transcripts are always full-cloud, cloud-prefix+local-suffix, or full-local.
3. **Offer**: fires once, `offerAfterMs` after `recordingEnded()`, only if ≥1 chunk is still cloud-pending. If all pending clouds resolve before the deadline → `onDraftResolved('cloud')` and no switch.
4. **Hard deadline**: `hardDeadlineMs` after `recordingEnded()` → switch to local (`onDraftResolved('deadline')`). `acceptDraft()` does the same earlier (`'accepted'`).
5. **Local unavailable** (startLocal null or local resolves null) for a switched chunk: fall back to awaiting that chunk's cloud anyway (it's the only text there is); resolve null only if both are null.
6. **Late cloud**: after a chunk committed local, if its cloud resolves within `lateCloudWindowMs` of commit, `onLateCloud(idx, text)` fires.
7. `dispose()` clears timers.

- [ ] **Step 1: Write the failing test**

Create `engine-overrides/electron/sttArbiter.test.ts`:

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { SttArbiter } from './sttArbiter'

// Manually-resolvable promise helper
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise((r) => setImmediate(r))
// Fast timeouts so tests run in ms
const FAST = { speculateAfterMs: 10, offerAfterMs: 40, hardDeadlineMs: 100, lateCloudWindowMs: 200 }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('SttArbiter', () => {
  test('cloud resolving mid-recording commits cloud immediately', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    cloud.resolve('hello from cloud')
    assert.deepEqual(await p, { text: 'hello from cloud', source: 'cloud' })
    a.dispose()
  })

  test('mid-recording chunk with slow cloud does NOT commit local — waits', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud = deferred<string | null>()
    let resolved = false
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    void p.then(() => { resolved = true })
    await wait(150) // way past hardDeadlineMs — but recording never ended
    assert.equal(resolved, false)
    cloud.resolve('late cloud')
    assert.deepEqual(await p, { text: 'late cloud', source: 'cloud' })
    a.dispose()
  })

  test('hard deadline after recordingEnded commits local drafts', async () => {
    const events: string[] = []
    const a = new SttArbiter({ onDraftResolved: (how) => events.push(how) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('local draft'))
    a.recordingEnded()
    const r = await p
    assert.deepEqual(r, { text: 'local draft', source: 'local' })
    assert.deepEqual(events, ['deadline'])
    a.dispose()
  })

  test('offer fires at offerAfterMs; all-cloud completion dismisses it', async () => {
    let offered = 0
    const resolved: string[] = []
    const a = new SttArbiter({ onDraftOffer: () => { offered++ }, onDraftResolved: (h) => resolved.push(h) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    a.recordingEnded()
    await wait(60) // past offerAfterMs, before hardDeadlineMs
    assert.equal(offered, 1)
    cloud.resolve('cloud text')
    assert.deepEqual(await p, { text: 'cloud text', source: 'cloud' })
    assert.deepEqual(resolved, ['cloud'])
    a.dispose()
  })

  test('acceptDraft switches immediately', async () => {
    const resolved: string[] = []
    const a = new SttArbiter({ onDraftResolved: (h) => resolved.push(h) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('quick draft'))
    a.recordingEnded()
    await wait(20) // let speculation start + draft resolve
    a.acceptDraft()
    assert.deepEqual(await p, { text: 'quick draft', source: 'local' })
    assert.deepEqual(resolved, ['accepted'])
    a.dispose()
  })

  test('one-way ordered switch: later chunk with resolved cloud still goes local after switch', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud0 = deferred<string | null>()
    const cloud1 = deferred<string | null>()
    const p0 = a.submitChunk(0, cloud0.promise, () => Promise.resolve('local0'))
    const p1 = a.submitChunk(1, cloud1.promise, () => Promise.resolve('local1'))
    cloud1.resolve('cloud1') // chunk 1's cloud is fast; chunk 0's never comes
    await tick()
    a.recordingEnded()
    const [r0, r1] = await Promise.all([p0, p1])
    // switch happened at index 0 → BOTH local: shape is full-local, never local-sandwich
    assert.deepEqual(r0, { text: 'local0', source: 'local' })
    assert.deepEqual(r1, { text: 'local1', source: 'local' })
    assert.equal(a.engineSummary, 'local')
    a.dispose()
  })

  test('cloud prefix survives: chunks committed cloud BEFORE the switch stay cloud', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud0 = deferred<string | null>()
    const cloud1 = deferred<string | null>()
    const p0 = a.submitChunk(0, cloud0.promise, () => Promise.resolve('local0'))
    cloud0.resolve('cloud0')
    assert.deepEqual(await p0, { text: 'cloud0', source: 'cloud' })
    const p1 = a.submitChunk(1, cloud1.promise, () => Promise.resolve('local1'))
    a.recordingEnded()
    const r1 = await p1
    assert.deepEqual(r1, { text: 'local1', source: 'local' })
    assert.equal(a.engineSummary, 'mixed')
    a.dispose()
  })

  test('switched chunk with no local falls back to awaiting cloud', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, null) // local unavailable
    a.recordingEnded()
    await wait(120) // past hard deadline — switch wanted, no draft
    cloud.resolve('only text there is')
    assert.deepEqual(await p, { text: 'only text there is', source: 'cloud' })
    a.dispose()
  })

  test('both null resolves null', async () => {
    const a = new SttArbiter({}, FAST)
    const p = a.submitChunk(0, Promise.resolve(null), () => Promise.resolve(null))
    a.recordingEnded()
    assert.equal(await p, null)
    a.dispose()
  })

  test('late cloud after local commit fires onLateCloud within the window', async () => {
    const late: Array<[number, string]> = []
    const a = new SttArbiter({ onLateCloud: (i, t) => late.push([i, t]) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    a.recordingEnded()
    await p // committed local via deadline
    cloud.resolve('better take')
    await tick()
    assert.deepEqual(late, [[0, 'better take']])
    a.dispose()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -6` → FAIL (module not found).

- [ ] **Step 3: Write the implementation**

Create `engine-overrides/electron/sttArbiter.ts`:

```ts
// SttArbiter — session-scoped engine routing for dictation STT.
//
// Replaces the per-chunk 4s cloud-vs-local race that produced mixed-engine
// transcripts (the #1 proven accuracy failure, 2026-07-14 investigation:
// every garbled field dictation was a silent local commit or a mid-transcript
// engine flip). The contract it enforces:
//
//   * Mid-recording: NO commits. Nobody is waiting while they're speaking —
//     a chunk resolves early only if its cloud result lands. Local drafts
//     still warm up speculatively so a later switch pastes instantly.
//   * Post key-up (recordingEnded): cloud pastes the moment it completes;
//     at offerAfterMs a "quick draft ready" offer fires (UI); acceptDraft()
//     or the hardDeadlineMs auto-resolve switch to local.
//   * The switch is ONE-WAY and INDEX-ORDERED: once chunk k goes local,
//     every chunk ≥ k goes local, even if its cloud arrived. Every
//     transcript is full-cloud, cloud-prefix + local-suffix, or full-local.
//   * Late cloud results (within lateCloudWindowMs of a local commit) are
//     surfaced via onLateCloud for history's "better take".
//
// Pure module: no electron imports — unit-tested by sttArbiter.test.ts.

export type EngineSource = 'cloud' | 'local'
export interface ChunkResolution { text: string; source: EngineSource }

export interface ArbiterEvents {
  onDraftOffer?: () => void
  onDraftResolved?: (how: 'cloud' | 'accepted' | 'deadline') => void
  onLateCloud?: (chunkIndex: number, text: string) => void
}

export interface ArbiterTimeouts {
  speculateAfterMs: number
  offerAfterMs: number
  hardDeadlineMs: number
  lateCloudWindowMs: number
}

export const DEFAULT_TIMEOUTS: ArbiterTimeouts = {
  speculateAfterMs: 1_500,
  offerAfterMs: 4_000,
  hardDeadlineMs: 12_000,
  lateCloudWindowMs: 30_000,
}

interface ChunkEntry {
  idx: number
  cloud: Promise<string | null>
  cloudResult: string | null
  cloudSettled: boolean
  local: Promise<string | null> | null
  startLocal: (() => Promise<string | null>) | null
  committed: ChunkResolution | null
  resolve: (r: ChunkResolution | null) => void
  promise: Promise<ChunkResolution | null>
  speculateTimer: ReturnType<typeof setTimeout> | null
}

export class SttArbiter {
  private chunks = new Map<number, ChunkEntry>()
  private events: ArbiterEvents
  private t: ArbiterTimeouts
  private ended = false
  /** Index at which the one-way cloud→local switch happened; null = no switch. */
  private switchIndex: number | null = null
  private offerFired = false
  private resolvedNotified = false
  private offerTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(events: ArbiterEvents = {}, timeouts: Partial<ArbiterTimeouts> = {}) {
    this.events = events
    this.t = { ...DEFAULT_TIMEOUTS, ...timeouts }
  }

  get engineSummary(): 'cloud' | 'local' | 'mixed' | 'none' {
    let sawCloud = false
    let sawLocal = false
    for (const c of this.chunks.values()) {
      if (c.committed?.source === 'cloud') sawCloud = true
      if (c.committed?.source === 'local') sawLocal = true
    }
    if (sawCloud && sawLocal) return 'mixed'
    if (sawLocal) return 'local'
    if (sawCloud) return 'cloud'
    return 'none'
  }

  submitChunk(
    idx: number,
    cloud: Promise<string | null>,
    startLocal: (() => Promise<string | null>) | null,
  ): Promise<ChunkResolution | null> {
    let resolveFn!: (r: ChunkResolution | null) => void
    const promise = new Promise<ChunkResolution | null>((r) => { resolveFn = r })
    const entry: ChunkEntry = {
      idx, cloud, cloudResult: null, cloudSettled: false,
      local: null, startLocal, committed: null,
      resolve: resolveFn, promise, speculateTimer: null,
    }
    this.chunks.set(idx, entry)

    // Cloud settlement: commit cloud iff no switch has claimed this index.
    void cloud.then((text) => {
      entry.cloudSettled = true
      entry.cloudResult = text
      if (entry.committed) {
        // Already committed local — this is a late cloud (better take).
        if (text && entry.committed.source === 'local') this.events.onLateCloud?.(idx, text)
        return
      }
      if (this.switchIndex !== null && idx >= this.switchIndex) return // switch owns it
      if (text != null) {
        this.commit(entry, { text, source: 'cloud' })
        this.maybeAllCloudResolved()
      } else {
        // Cloud failed outright — this chunk can only be local now.
        this.tryCommitLocal(entry)
      }
    }).catch(() => {
      entry.cloudSettled = true
      entry.cloudResult = null
      if (!entry.committed) this.tryCommitLocal(entry)
    })

    // Speculation: warm the local draft if cloud is slow. Never commits here.
    if (startLocal) {
      entry.speculateTimer = setTimeout(() => {
        entry.speculateTimer = null
        if (!entry.committed && !entry.local) entry.local = startLocal()
      }, this.t.speculateAfterMs)
    }
    return promise
  }

  recordingEnded(): void {
    if (this.ended) return
    this.ended = true
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null
      if (!this.offerFired && this.hasPending()) {
        this.offerFired = true
        this.events.onDraftOffer?.()
      }
    }, this.t.offerAfterMs)
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null
      if (this.hasPending()) this.switchToLocal('deadline')
    }, this.t.hardDeadlineMs)
    // Ensure every pending chunk has a warming draft NOW — key-up starts the clock.
    for (const c of this.chunks.values()) {
      if (!c.committed && !c.local && c.startLocal) {
        if (c.speculateTimer) { clearTimeout(c.speculateTimer); c.speculateTimer = null }
        c.local = c.startLocal()
      }
    }
  }

  acceptDraft(): void {
    if (this.hasPending()) this.switchToLocal('accepted')
  }

  dispose(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    for (const c of this.chunks.values()) {
      if (c.speculateTimer) clearTimeout(c.speculateTimer)
    }
  }

  private hasPending(): boolean {
    for (const c of this.chunks.values()) if (!c.committed) return true
    return false
  }

  private commit(entry: ChunkEntry, r: ChunkResolution | null): void {
    if (entry.committed) return
    if (r) entry.committed = r
    entry.resolve(r)
  }

  private maybeAllCloudResolved(): void {
    if (!this.ended || this.resolvedNotified) return
    if (this.hasPending()) return
    if (this.switchIndex === null) {
      this.resolvedNotified = true
      this.clearSessionTimers()
      this.events.onDraftResolved?.('cloud')
    }
  }

  private clearSessionTimers(): void {
    if (this.offerTimer) { clearTimeout(this.offerTimer); this.offerTimer = null }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null }
  }

  private switchToLocal(how: 'accepted' | 'deadline'): void {
    // One-way: the switch point is the LOWEST uncommitted index — everything
    // from there on goes local, preserving the cloud-prefix shape.
    let lowest: number | null = null
    for (const c of this.chunks.values()) {
      if (!c.committed && (lowest === null || c.idx < lowest)) lowest = c.idx
    }
    if (lowest === null) return
    this.switchIndex = lowest
    if (!this.resolvedNotified) {
      this.resolvedNotified = true
      this.events.onDraftResolved?.(how)
    }
    this.clearSessionTimers()
    for (const c of this.chunks.values()) {
      if (!c.committed && c.idx >= this.switchIndex) this.tryCommitLocal(c)
    }
  }

  private tryCommitLocal(entry: ChunkEntry): void {
    if (entry.committed) return
    if (!entry.local && entry.startLocal) entry.local = entry.startLocal()
    if (!entry.local) {
      // No local at all — cloud is the only hope, however late.
      void entry.cloud.then((text) => {
        this.commit(entry, text != null ? { text, source: 'cloud' } : null)
      }).catch(() => this.commit(entry, null))
      return
    }
    const commitAt = Date.now()
    void entry.local.then((text) => {
      if (entry.committed) return
      if (text != null) {
        this.commit(entry, { text, source: 'local' })
        // Late-cloud watch: if cloud lands within the window, surface it.
        void entry.cloud.then((cloudText) => {
          if (cloudText != null && Date.now() - commitAt <= this.t.lateCloudWindowMs) {
            this.events.onLateCloud?.(entry.idx, cloudText)
          }
        }).catch(() => { /* no better take */ })
      } else {
        // Local failed — fall back to cloud, however late.
        void entry.cloud.then((cloudText) => {
          this.commit(entry, cloudText != null ? { text: cloudText, source: 'cloud' } : null)
        }).catch(() => this.commit(entry, null))
      }
    }).catch(() => {
      void entry.cloud.then((cloudText) => {
        this.commit(entry, cloudText != null ? { text: cloudText, source: 'cloud' } : null)
      }).catch(() => this.commit(entry, null))
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8` → all pass. If the ordered-switch test flakes, the bug is real — fix the arbiter, not the test.

- [ ] **Step 5: Commit**

```bash
git add engine-overrides/electron/sttArbiter.ts engine-overrides/electron/sttArbiter.test.ts
git commit -m "feat(stt): SttArbiter — one-way ordered engine routing, offer/deadline lifecycle, late-cloud capture"
```

---

### Task 7: Integrate the arbiter into sessionManager

**Files:**
- Modify: `engine-overrides/electron/sessionManager.ts`
- Modify: `engine-overrides/electron/db.ts` (better_transcript column + updater)
- Modify: `desktop/electron/main-extensions.ts` (draft-accept registration)
- Modify: `desktop/electron/paywall-glue.ts` (ipcMain accept handler)
- Modify: `desktop/electron/preload-extensions.ts` (accept + events)

**Interfaces:**
- Consumes: `SttArbiter`, `ChunkResolution` (Task 6); `logTelemetry` (Task 1).
- Produces: widget IPC events `session:draft-offer` (no args), `session:draft-resolved` (arg: `'cloud' | 'accepted' | 'deadline'`); preload methods `paywallAcceptDraft(): void`, `paywallOnDraftOffer(cb)`, `paywallOnDraftResolved(cb)`; `db.updateBetterTranscript(sessionId: string, text: string): void`. Task 8 consumes the preload methods.

- [ ] **Step 1: db.ts — better_transcript column + updater**

In `initDB()` after the engine-column migration add:

```ts
  // better-take storage: when a dictation pasted a local draft and the cloud
  // transcript arrived late (≤30s), we keep the cloud text here. Not shown
  // in History yet — deliberately storage-only (2026-07-15 plan).
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN better_transcript TEXT')
  } catch { /* already there */ }
```

Add the export after `updateSessionResult`:

```ts
export function updateBetterTranscript(sessionId: string, text: string): void {
  try {
    db.prepare('UPDATE sessions SET better_transcript = ? WHERE id = ?').run(text, sessionId)
  } catch (e) {
    console.warn('[db] updateBetterTranscript failed:', e instanceof Error ? e.message : e)
  }
}
```

- [ ] **Step 2: main-extensions.ts — draft-accept registration**

Add next to the capture-quality sink from Task 5:

```ts
// ── Draft-accept handoff (widget tap → glue → sessionManager) ──────────
let draftAcceptHandler: (() => void) | null = null
export function registerDraftAcceptHandler(fn: () => void): void {
  draftAcceptHandler = fn
}
export function invokeDraftAccept(): void {
  try { draftAcceptHandler?.() } catch { /* never break IPC */ }
}
```

- [ ] **Step 3: paywall-glue.ts — ipcMain handler**

Next to the capture-quality handler:

```ts
  ipcMain.on('paywall:accept-draft', () => {
    invokeDraftAccept()
  })
```

(import `invokeDraftAccept` from `./main-extensions` alongside `deliverCaptureQuality`.)

- [ ] **Step 4: preload-extensions.ts — widget-side surface**

```ts
  // Draft-offer lifecycle (slow-cloud UX). Offer = local quick draft is ready
  // and cloud is still pending; accept pastes the draft immediately.
  paywallAcceptDraft: (): void => ipcRenderer.send('paywall:accept-draft'),
  paywallOnDraftOffer: (cb: () => void) => {
    ipcRenderer.on('session:draft-offer', () => cb())
  },
  paywallOnDraftResolved: (cb: (how: string) => void) => {
    ipcRenderer.on('session:draft-resolved', (_e, how: string) => cb(how))
  },
```

- [ ] **Step 5: sessionManager — session-scoped arbiter**

Imports: add `SttArbiter` and `registerDraftAcceptHandler`:

```ts
import { SttArbiter } from './sttArbiter'
import { registerCaptureQualitySink, registerDraftAcceptHandler } from './paywall/main-extensions'
```

Class fields (next to `fallbackNotified`):

```ts
  // Session-scoped STT engine arbiter (see sttArbiter.ts). Recreated per
  // session in startSession; disposed on every teardown path.
  private arbiter: SttArbiter | null = null
```

In the constructor (added in Task 5), register the accept handler:

```ts
    registerDraftAcceptHandler(() => {
      console.log('[session] draft-offer ACCEPTED by user')
      this.arbiter?.acceptDraft()
    })
```

Add these private methods after `notifyEngineFallback`:

```ts
  private newArbiter(): SttArbiter {
    this.arbiter?.dispose()
    const sessionIdAtBirth = this.currentSession?.sessionId
    const lateCloudTexts = new Map<number, string>()
    const arbiter = new SttArbiter({
      onDraftOffer: () => {
        console.log('[session] 🟡 draft offer armed — cloud slow, local draft ready')
        logTelemetry('draft-offer', { sessionId: sessionIdAtBirth ?? null })
        sendToWidget('session:draft-offer')
      },
      onDraftResolved: (how) => {
        console.log(`[session] draft resolved: ${how}`)
        logTelemetry('draft-resolved', { sessionId: sessionIdAtBirth ?? null, how })
        sendToWidget('session:draft-resolved', how)
        if (how !== 'cloud') this.notifyEngineFallback('cloud slow — used on-device model')
      },
      onLateCloud: (chunkIndex, text) => {
        // Collect late cloud transcripts; once we have text for every chunk
        // that pasted local, store the stitched better take for this session.
        lateCloudTexts.set(chunkIndex, text)
        logTelemetry('late-cloud', { sessionId: sessionIdAtBirth ?? null, chunkIndex, chars: text.length })
        if (!sessionIdAtBirth) return
        try {
          const total = this.totalChunksExpected ?? 1
          const parts: string[] = []
          for (let i = 0; i < total; i++) {
            const late = lateCloudTexts.get(i)
            const committed = this.chunkTracker.get(i)?.transcript
            const best = late ?? committed
            if (best) parts.push(best)
          }
          const better = stitchChunks(parts)
          if (better) {
            const { updateBetterTranscript } = require('./db') as typeof import('./db')
            updateBetterTranscript(sessionIdAtBirth, better)
            console.log(`[session] 💾 better take stored (${better.length} chars)`)
          }
        } catch (e) {
          console.warn('[session] better-take store failed:', e instanceof Error ? e.message : e)
        }
      },
    })
    this.arbiter = arbiter
    return arbiter
  }

  /** Local speculative transcription factory for the arbiter (null when the
   *  on-device model isn't installed/ready). */
  private localSttFactory(buffer: Buffer, label: string): (() => Promise<string | null>) | null {
    if (!parakeetManager.isModelReady() || !parakeetManager.isBinaryReady()) return null
    return () => {
      const t0 = Date.now()
      return parakeetManager.transcribe(buffer)
        .then((text) => {
          console.log(`[session:arbiter] ${label}: local draft ready in ${Date.now() - t0}ms (${text.length} chars)`)
          return text
        })
        .catch((e) => {
          console.warn(`[session:arbiter] ${label}: local draft failed — ${e instanceof Error ? e.message : e}`)
          return null
        })
    }
  }
```

(Note the lazy `require('./db')` avoids adding a static db import to sessionManager; db.ts is already loaded by main.)

- [ ] **Step 6: Create the arbiter at session start; end recording at the right moments**

In `startSession`, next to the Task 1/5 resets, add:

```ts
    this.newArbiter()
```

`recordingEnded()` must fire when the mic actually stops delivering. Add one line at the TOP of BOTH `receiveAudioFinalChunk` and `receiveAudio` (after the foreign-session guard):

```ts
    this.arbiter?.recordingEnded()
```

and at the top of `processSession` (right after `this.fallbackNotified = false`):

```ts
    this.arbiter?.recordingEnded() // idempotent — covers instruction-only sessions
```

- [ ] **Step 7: Route dictation chunks through the arbiter**

In `transcribeChunk`, replace the race block:

```ts
      const cloudPromise = this.runManagedSTT(buffer, chunkIndex, 'dictation')
      const raced = await this.raceCloudVsLocalSTT(cloudPromise, buffer, `chunk ${chunkIndex}`)
      if (raced) {
        const chunk = this.chunkTracker.get(chunkIndex)
        if (chunk) { chunk.transcript = raced.text; chunk.completedAt = Date.now() }
        if (raced.source === 'local') {
          // Surface to the whole-session output handler so the widget can
          // hint "via on-device — cloud was slow" once at the end.
          this.notifyEngineFallback('cloud slow — used on-device whisper')
        }
        setLastEngine(raced.source)
        console.log(`[session] ✅ Chunk ${chunkIndex} via ${raced.source === 'cloud' ? 'managed cloud' : 'local whisper (cloud was slow)'} in ${Date.now() - t0}ms`)
        return raced.text
      }
```

with:

```ts
      const mode = getPaywallEngineMode()
      const arbiter = this.arbiter
      if (arbiter && (mode === 'managed' || mode === 'auto')) {
        const cloudPromise = this.runManagedSTT(buffer, chunkIndex, 'dictation').then((r) => r?.text ?? null)
        const resolved = await arbiter.submitChunk(chunkIndex, cloudPromise, this.localSttFactory(buffer, `chunk ${chunkIndex}`))
        if (resolved) {
          const chunk = this.chunkTracker.get(chunkIndex)
          if (chunk) { chunk.transcript = resolved.text; chunk.completedAt = Date.now() }
          setLastEngine(resolved.source)
          logTelemetry('chunk-resolved', { chunkIndex, engine: resolved.source, ms: Date.now() - t0, bytes: buffer.byteLength })
          console.log(`[session] ✅ Chunk ${chunkIndex} via ${resolved.source} (arbiter) in ${Date.now() - t0}ms`)
          return resolved.text
        }
      }
```

(`getPaywallEngineMode` is already imported at line 19.)

- [ ] **Step 8: Route the non-chunked dictation buffer through the arbiter**

In `processSession`'s managed intercept, replace the dictation half:

```ts
        if (session.dictationAudio && !session.dictationTranscript) {
          const cloudPromise = this.runManagedSTT(session.dictationAudio, 0, session.flowType)
          const raced = await this.raceCloudVsLocalSTT(cloudPromise, session.dictationAudio, 'dictation')
          if (raced) {
            session.dictationTranscript = raced.text
            if (raced.source === 'local') this.notifyEngineFallback('cloud slow — used on-device whisper')
            setLastEngine(raced.source)
            console.log(`[session] ✓ Dictation STT via ${raced.source === 'cloud' ? 'managed cloud' : 'local whisper (cloud was slow)'}`)
          }
        }
```

with:

```ts
        if (session.dictationAudio && !session.dictationTranscript) {
          const mode = getPaywallEngineMode()
          const arbiter = this.arbiter
          if (arbiter && (mode === 'managed' || mode === 'auto')) {
            const cloudPromise = this.runManagedSTT(session.dictationAudio, 0, session.flowType).then((r) => r?.text ?? null)
            const resolved = await arbiter.submitChunk(0, cloudPromise, this.localSttFactory(session.dictationAudio, 'dictation'))
            if (resolved) {
              session.dictationTranscript = resolved.text
              setLastEngine(resolved.source)
              logTelemetry('dictation-resolved', { engine: resolved.source, bytes: session.dictationAudio.byteLength })
              console.log(`[session] ✓ Dictation STT via ${resolved.source} (arbiter)`)
            }
          }
        }
```

The instruction half stays on `raceCloudVsLocalSTT` unchanged (instructions are short, post-key-up, and secondary).

- [ ] **Step 9: Dispose the arbiter on every teardown**

`resetChunkState()` is called on every session completion path. Extend it:

```ts
  private resetChunkState(): void {
    this.chunkTracker.clear()
    this.totalChunksExpected = null
    this.isChunkedSession = false
    // NOTE: do NOT dispose the arbiter here — late-cloud better-take capture
    // outlives the paste by up to 30s. It's disposed when the NEXT session
    // creates a fresh one (newArbiter) or the app quits.
  }
```

(That comment is the change: verify no other code assumes arbiter death at reset. `newArbiter()` disposes the previous one — the 30s late-cloud timers being GC'd with resolved promises is fine.)

- [ ] **Step 10: Verify + commit**

`npm run typecheck` → clean. `npm test` → all pass.

```bash
git add engine-overrides/electron/sessionManager.ts engine-overrides/electron/db.ts desktop/electron/main-extensions.ts desktop/electron/paywall-glue.ts desktop/electron/preload-extensions.ts
git commit -m "feat(stt): arbiter wired into sessionManager — no mid-recording commits, one-way switch, better-take storage"
```

---

### Task 8: Widget UI — draft offer + resolved

**Files:**
- Modify: `engine-overrides/renderer/widget/WidgetApp.tsx` (state + listeners + props pass-through ~lines 625-640, 880-898, 986)
- Modify: `engine-overrides/renderer/widget/Widget.tsx` (processing pill ~lines 171-187, props ~lines 4-16)

**Interfaces:**
- Consumes: `paywallOnDraftOffer`, `paywallOnDraftResolved`, `paywallAcceptDraft` (Task 7).

- [ ] **Step 1: WidgetApp state + listeners**

Next to `const [engineNotice, setEngineNotice] = useState<string | null>(null)` add:

```ts
  const [draftOffer, setDraftOffer] = useState(false)
```

In the main `useEffect` (after the `api.onEngineNotice` registration) add:

```ts
    // Draft-offer lifecycle: cloud STT is slow but a local quick draft is
    // ready. The pill grows a one-tap "use quick draft" affordance; it
    // retracts when either side resolves the session.
    const draftApi = api as unknown as {
      paywallOnDraftOffer?: (cb: () => void) => void
      paywallOnDraftResolved?: (cb: (how: string) => void) => void
    }
    draftApi.paywallOnDraftOffer?.(() => setDraftOffer(true))
    draftApi.paywallOnDraftResolved?.(() => setDraftOffer(false))
```

In the cleanup function add:

```ts
      api.removeAllListeners('session:draft-offer')
      api.removeAllListeners('session:draft-resolved')
```

Reset on recording start — inside `api.onRecordingStart` next to `setEngineNotice(null)`:

```ts
      setDraftOffer(false)
```

Add the accept callback near `handleUndo`:

```ts
  const handleAcceptDraft = useCallback(() => {
    setDraftOffer(false)
    const api = window.electronAPI as unknown as { paywallAcceptDraft?: () => void }
    api.paywallAcceptDraft?.()
  }, [])
```

Pass both to the `<Widget ... />` element (find it near line 986 where `engineNotice={engineNotice}` is passed):

```tsx
          draftOffer={draftOffer}
          onAcceptDraft={handleAcceptDraft}
```

- [ ] **Step 2: Widget.tsx props + processing pill**

Extend `WidgetProps`:

```ts
  draftOffer?: boolean
  onAcceptDraft?: () => void
```

and the destructuring: `draftOffer = false, onAcceptDraft,`.

Add one CSS rule to `PILL_CRITICAL_CSS` (before the closing backtick):

```
.unmute-pill-draft-btn { border: 1px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); font-size: 12px; border-radius: 9999px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.unmute-pill-draft-btn:hover { background: rgba(255,255,255,0.16); }
```

Replace the PROCESSING pill block:

```tsx
      {/* ══════ PROCESSING (pill) ══════ */}
      {state === 'processing' && (
        <div className="unmute-pill">
          <div className="unmute-pill-dot unmute-pill-dot--processing animate-dot-pulse-processing" />
          <span className="unmute-pill-label">{engineNotice ? 'On-device' : 'Processing'}</span>
          <div className="unmute-pill-dots unmute-pill-dots--processing">
            <span className="animate-dot-bounce" />
            <span className="animate-dot-bounce" />
            <span className="animate-dot-bounce" />
          </div>
          {engineNotice ? (
            <span className="unmute-pill-helper animate-fade-up-in">offline model</span>
          ) : showDiscardHint && (
            <span className="unmute-pill-helper animate-fade-up-in">Esc to discard</span>
          )}
        </div>
      )}
```

with:

```tsx
      {/* ══════ PROCESSING (pill) ══════ */}
      {state === 'processing' && (
        <div className="unmute-pill">
          <div className="unmute-pill-dot unmute-pill-dot--processing animate-dot-pulse-processing" />
          <span className="unmute-pill-label">
            {draftOffer ? 'Taking longer…' : engineNotice ? 'On-device' : 'Processing'}
          </span>
          <div className="unmute-pill-dots unmute-pill-dots--processing">
            <span className="animate-dot-bounce" />
            <span className="animate-dot-bounce" />
            <span className="animate-dot-bounce" />
          </div>
          {draftOffer ? (
            <button className="unmute-pill-draft-btn animate-fade-up-in" onClick={onAcceptDraft}>
              Use quick draft
            </button>
          ) : engineNotice ? (
            <span className="unmute-pill-helper animate-fade-up-in">offline model</span>
          ) : showDiscardHint && (
            <span className="unmute-pill-helper animate-fade-up-in">Esc to discard</span>
          )}
        </div>
      )}
```

- [ ] **Step 3: Verify + commit**

`npm run typecheck` → clean. `npm test` → pass.

```bash
git add engine-overrides/renderer/widget/WidgetApp.tsx engine-overrides/renderer/widget/Widget.tsx
git commit -m "feat(widget): draft-offer pill — 'Taking longer… / Use quick draft' one-tap accept"
```

---

### Task 9: Prompt threading — worker accepts `prompt`

**Files:**
- Modify: `../backend/cloudflare/pipeline/src/index.ts` (`handleSTT` ~lines 208-230, `handleSTTStream` ~lines 333-396)

**Interfaces:**
- Produces: `/v1/stt` accepts optional multipart field `prompt`; `/v1/stt-stream` accepts optional query param `prompt`. Both forward to Groq's `prompt` parameter, truncated to 800 chars. Task 10 consumes.

- [ ] **Step 1: handleSTT — read + forward the form field**

After `const flowType = (form.get('flow_type') as string) || 'dictation'` add:

```ts
  // Optional decoder-context prompt (Whisper biasing: previous chunk's tail
  // or caller-supplied vocabulary). Style/spelling guidance only — Groq caps
  // at 224 tokens; we cap chars defensively.
  const prompt = ((form.get('prompt') as string) || '').slice(0, 800)
```

After `groqForm.append('language', language)` add:

```ts
  if (prompt) groqForm.append('prompt', prompt)
```

- [ ] **Step 2: handleSTTStream — read + forward the query param**

In `handleSTTStream`, where `duration_seconds` / `language` / `flow_type` are read from the query string (~lines 333-336), add:

```ts
  const prompt = (url.searchParams.get('prompt') || '').slice(0, 800)
```

(match the existing variable used for `url` — if the function reads params via `new URL(req.url)` into a different name, use that name.) Then where the Groq form is built (~lines 384-396), after the `language` append add:

```ts
  if (prompt) groqForm.append('prompt', prompt)
```

- [ ] **Step 3: Verify the worker builds**

Run from `../backend/cloudflare/pipeline`: `npx wrangler deploy --dry-run 2>&1 | tail -5` (or `npx tsc --noEmit` if a tsconfig exists — use whichever the package's own scripts use; check `package.json` first and run its build/check script).
Expected: clean build. Do NOT deploy.

- [ ] **Step 4: Commit**

```bash
git -C ../backend add cloudflare/pipeline/src/index.ts
git commit -m "feat(worker): optional Whisper prompt param on /v1/stt and /v1/stt-stream"
```

(Worker and desktop share one repo — a single `git add`+commit from the desktop cwd with the relative path `../backend/...` also works; use whatever the worktree layout accepts: `git add ../backend/cloudflare/pipeline/src/index.ts`.)

---

### Task 10: Prompt threading — client side (best-effort, fail-safe)

**Files:**
- Create: `engine-overrides/electron/promptTail.ts`
- Test: `engine-overrides/electron/promptTail.test.ts`
- Modify: `desktop/electron/paywall-route.ts` (`tryManagedSTT` signature + form field)
- Modify: `desktop/electron/paywall-stream.ts` (prompt provider + query param)
- Modify: `desktop/electron/paywall-glue.ts` (no change needed — stream-open handler passes through opts; verify)
- Modify: `engine-overrides/electron/sessionManager.ts` (provider registration + runManagedSTT pass-through)

**Interfaces:**
- Produces: `promptTail(text: string | null | undefined, maxChars?: number): string` (pure; `''` = don't send). `setStreamPromptProvider(fn: (chunkIndex: number) => string): void` exported from `paywall-stream.ts`. `tryManagedSTT(audio, durationSeconds, flowType, signal?, prompt?)` gains a 5th optional param.

- [ ] **Step 1: Write the failing test**

Create `engine-overrides/electron/promptTail.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { promptTail } from './promptTail'

test('empty/null/short-junk input yields empty string', () => {
  assert.equal(promptTail(null), '')
  assert.equal(promptTail(''), '')
  assert.equal(promptTail('   '), '')
  assert.equal(promptTail('.'), '')
})

test('short clean text passes through trimmed', () => {
  assert.equal(promptTail('  We are testing unmute. '), 'We are testing unmute.')
})

test('long text keeps only the tail, cut at a word boundary', () => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const tail = promptTail(words, 60)
  assert.ok(tail.length <= 60)
  assert.ok(!tail.startsWith(' '))
  assert.ok(tail.endsWith('word99'))
  assert.ok(words.endsWith(tail))
})

test('known hallucination-y tails are rejected', () => {
  assert.equal(promptTail('Thank you.'), '')
  assert.equal(promptTail('Thanks for watching!'), '')
})
```

- [ ] **Step 2: Run to verify failure**

`npm test 2>&1 | tail -4` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `engine-overrides/electron/promptTail.ts`:

```ts
// promptTail — build the Whisper decoder-context prompt from the PREVIOUS
// chunk's transcript. Whisper natively conditions each 30s window on the
// prior window's text; our chunk cuts broke that. This restores it.
//
// FAIL-SAFE CONTRACT (decided 2026-07-15): '' means "send no prompt" —
// exactly today's behavior. Junky/hallucinated context is worse than none,
// so anything suspicious returns ''.
// Pure module: unit-tested by promptTail.test.ts.

const JUNK_RE = /^\s*(?:thanks? for watching[.!]?|please subscribe[.!]?|thank you[.!]?|bye[.!]?|see you next time[.!]?)\s*$/i

const DEFAULT_MAX_CHARS = 200

export function promptTail(text: string | null | undefined, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (!text) return ''
  const t = text.trim()
  if (t.length < 4) return ''
  if (JUNK_RE.test(t)) return ''
  if (t.length <= maxChars) return t
  // Take the tail, then drop the leading partial word so the prompt starts clean.
  let tail = t.slice(-maxChars)
  const firstSpace = tail.indexOf(' ')
  if (firstSpace > 0 && firstSpace < tail.length - 1) tail = tail.slice(firstSpace + 1)
  return tail.trim()
}
```

- [ ] **Step 4: Run tests to verify pass**

`npm test 2>&1 | tail -4` → PASS.

- [ ] **Step 5: paywall-stream.ts — prompt provider**

After the `sessions` Map declaration add:

```ts
// Optional prompt provider (registered by sessionManager): returns the
// previous chunk's transcript tail for Whisper decoder context. Called at
// open time — best-effort: '' means "no prompt", which is the pre-feature
// behavior. NEVER awaited, NEVER blocks the stream open.
let promptProvider: ((chunkIndex: number) => string) | null = null
export function setStreamPromptProvider(fn: (chunkIndex: number) => string): void {
  promptProvider = fn
}
```

In `openStream`, after `if (lang) paramsInit.language = lang` add:

```ts
  try {
    const prompt = promptProvider?.(chunkIndex) || ''
    if (prompt) paramsInit.prompt = prompt
  } catch { /* prompt is a bonus, never a blocker */ }
```

- [ ] **Step 6: paywall-route.ts — tryManagedSTT prompt param**

Change the signature:

```ts
export async function tryManagedSTT(
  audio: Buffer,
  durationSeconds: number,
  flowType: 'dictation' | 'transform' | 'quote' | 'context' | 'instruction' = 'dictation',
  signal?: AbortSignal,
  prompt?: string,
): Promise<ManagedSTTResult | null> {
```

and after `form.append('flow_type', flowType)` add:

```ts
    if (prompt) form.append('prompt', prompt)
```

- [ ] **Step 7: sessionManager — provide + pass prompts**

Imports: add `setStreamPromptProvider` to the paywall-stream import (line 20) and:

```ts
import { promptTail } from './promptTail'
```

Add a private method after `localSttFactory`:

```ts
  /** Decoder-context for chunk idx: the transcript tail of the nearest
   *  completed lower-index chunk. '' = none ready = send no prompt. */
  private getPromptTailForChunk(idx: number): string {
    for (let j = idx - 1; j >= 0; j--) {
      const t = this.chunkTracker.get(j)?.transcript
      if (t) return promptTail(t)
    }
    return ''
  }
```

In the constructor, register the provider:

```ts
    setStreamPromptProvider((chunkIndex) => this.getPromptTailForChunk(chunkIndex))
```

In `runManagedSTT`, thread the prompt into the upload fallback — change the signature and the `tryManagedSTT` call:

```ts
  private async runManagedSTT(
    audio: Buffer,
    chunkIndex: number,
    flowType: 'dictation' | 'transform' | 'quote' | 'context' | 'instruction',
  ): Promise<{ text: string } | null> {
    if (hasStreamForChunk(chunkIndex)) {
      try {
        const r = await closeAndAwait(chunkIndex, 15000)
        if (r?.text != null) return { text: r.text }
      } catch (e) {
        console.warn(`[session] managed stream chunk ${chunkIndex} failed: ${e instanceof Error ? e.message : e}`)
      }
    }
    try {
      const durationGuess = Math.max(1, Math.round(audio.length / 4000))
      const prompt = flowType === 'dictation' ? this.getPromptTailForChunk(chunkIndex) : ''
      const managed = await tryManagedSTT(audio, durationGuess, flowType, undefined, prompt || undefined)
      if (managed?.text != null) return { text: managed.text }
    } catch (e) {
      console.warn(`[session] tryManagedSTT (${flowType}) failed: ${e instanceof Error ? e.message : e}`)
    }
    return null
  }
```

- [ ] **Step 8: Verify + commit**

`npm run typecheck` → clean. `npm test` → pass.

```bash
git add engine-overrides/electron/promptTail.ts engine-overrides/electron/promptTail.test.ts electron/paywall-route.ts electron/paywall-stream.ts engine-overrides/electron/sessionManager.ts
git commit -m "feat(stt): best-effort chunk-context prompting — previous chunk tail biases Whisper decoding"
```

---

### Task 11: Quiet-capture gate

**Files:**
- Create: `engine-overrides/electron/quietGuard.ts`
- Test: `engine-overrides/electron/quietGuard.test.ts`
- Modify: `engine-overrides/electron/sessionManager.ts` (gate before paste in both dictation output paths)
- Modify: `desktop/electron/preload-extensions.ts` (quiet-miss event)
- Modify: `engine-overrides/renderer/widget/WidgetApp.tsx` + `Widget.tsx` (message)

**Interfaces:**
- Produces: `isSuspectQuietCapture(rmsMax: number | null, transcript: string): boolean` (pure); widget IPC `session:quiet-miss`; preload `paywallOnQuietMiss(cb)`; Widget prop `mutedText?: string`.

- [ ] **Step 1: Failing test**

Create `engine-overrides/electron/quietGuard.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { isSuspectQuietCapture } from './quietGuard'

test('faint capture + tiny transcript = suspect (the "BOT" case)', () => {
  assert.equal(isSuspectQuietCapture(0.02, 'BOT'), true)
  assert.equal(isSuspectQuietCapture(0.02, ' Thank you.'), true)
})

test('faint capture + substantive transcript = NOT suspect (soft-spoken user)', () => {
  assert.equal(isSuspectQuietCapture(0.02, 'So I want to create a new worktree from the main branch'), false)
})

test('healthy level + tiny transcript = NOT suspect (user said one word)', () => {
  assert.equal(isSuspectQuietCapture(0.3, 'Yes.'), false)
})

test('unknown quality (no report) never gates', () => {
  assert.equal(isSuspectQuietCapture(null, 'BOT'), false)
  assert.equal(isSuspectQuietCapture(0, 'BOT'), false)
})
```

- [ ] **Step 2: Run to verify failure**

`npm test 2>&1 | tail -4` → FAIL.

- [ ] **Step 3: Implement**

Create `engine-overrides/electron/quietGuard.ts`:

```ts
// quietGuard — don't paste Whisper fiction from near-silent captures.
//
// Field case (2026-07-14, 21:41:07): a capture averaging -34dB came back
// from cloud Whisper as "BOT" — four characters of pure hallucination,
// pasted into the user's document. The recorder already measures rmsMax;
// this gate fires ONLY when BOTH signals agree: the capture never got loud
// AND the transcript is suspiciously tiny. Either alone is legitimate
// (soft-spoken long dictation / a loud "Yes."), so either alone passes.
// Pure module: unit-tested by quietGuard.test.ts.

/** Below this rmsMax the recording never contained clearly-audible speech.
 *  Matches the renderer's QUIET_MAX_RMS coaching threshold (0.07). */
const QUIET_RMS_MAX = 0.07
/** A real utterance rarely transcribes to fewer characters than this. */
const TINY_TRANSCRIPT_CHARS = 20

export function isSuspectQuietCapture(rmsMax: number | null, transcript: string): boolean {
  if (!rmsMax || rmsMax <= 0) return false // no quality report — never gate
  if (rmsMax >= QUIET_RMS_MAX) return false
  return transcript.trim().length < TINY_TRANSCRIPT_CHARS
}
```

- [ ] **Step 4: Run tests to verify pass, then gate in sessionManager**

`npm test 2>&1 | tail -4` → PASS.

Import in `sessionManager.ts`:

```ts
import { isSuspectQuietCapture } from './quietGuard'
```

Add a private helper after `getPromptTailForChunk`:

```ts
  /** Quiet-capture paste gate: true = suppress the paste, tell the user we
   *  didn't catch it, keep the transcript in history (nothing is lost). */
  private quietMiss(session: SessionState, output: string): boolean {
    const q = this.captureQuality
    if (!q || q.sessionId !== session.sessionId) return false
    if (!isSuspectQuietCapture(q.rmsMax, output)) return false
    console.log(`[session] 🔇 quiet-capture gate: rmsMax=${q.rmsMax}, transcript=${JSON.stringify(output)} — not pasting`)
    logTelemetry('quiet-miss', { sessionId: session.sessionId, rmsMax: q.rmsMax, chars: output.length })
    sendToWidget('session:quiet-miss')
    return true
  }
```

Wire it into BOTH dictation output paths, immediately before injection:

(a) The pipeline STT-only path — right after `output = formatOutputForUser(output)` and before `session.output = output`:

```ts
            if (this.quietMiss(session, output)) {
              session.output = null
              session.status = 'done'
              session.errorMessage = 'quiet-miss'
              this.scheduleAutoHide(1800)
              clearTimeout(apiTimeout)
              this.abortController = null
              this.isProcessing = false
              this.resetChunkState()
              try { this.onSessionComplete?.(session) } catch { /* ignore */ }
              this.currentSession = null
              this.onSessionEnded?.()
              return
            }
```

(b) The sequential/chunked path — in the `switch` `case 'dictation':` branch, after `output = cleanTranscript(session.dictationTranscript || '')`:

```ts
            if (this.quietMiss(session, output)) {
              session.errorMessage = 'quiet-miss'
              output = ''
            }
```

(Downstream, the existing empty-output handling skips the paste; verify the empty-output branch in this path treats `''` as no-paste — it runs through the junk/empty guard; if `output` empty reaches injection, add `if (output)` around the inject call in this path.)

- [ ] **Step 5: Preload + widget message**

`preload-extensions.ts`:

```ts
  paywallOnQuietMiss: (cb: () => void) => {
    ipcRenderer.on('session:quiet-miss', () => cb())
  },
```

`WidgetApp.tsx` — add state + listener (next to draftOffer):

```ts
  const [mutedText, setMutedText] = useState<string | null>(null)
```

in the effect:

```ts
    const quietApi = api as unknown as { paywallOnQuietMiss?: (cb: () => void) => void }
    quietApi.paywallOnQuietMiss?.(() => {
      setMutedText('Mic was too quiet — didn\'t catch that')
      setState('too-short')
      scheduleAutoHide(2500)
    })
```

cleanup: `api.removeAllListeners('session:quiet-miss')`. Reset in `onRecordingStart`: `setMutedText(null)`.

Pass to Widget: `mutedText={mutedText}`. In `Widget.tsx` add prop `mutedText?: string | null` (default null) and change the too-short pill text:

```tsx
      {state === 'too-short' && (
        <div className="unmute-pill unmute-pill--muted animate-fade-up-in">
          <span className="unmute-pill-muted-text">{mutedText || "Didn't catch that"}</span>
        </div>
      )}
```

- [ ] **Step 6: Verify + commit**

`npm run typecheck` → clean. `npm test` → pass.

```bash
git add engine-overrides/electron/quietGuard.ts engine-overrides/electron/quietGuard.test.ts engine-overrides/electron/sessionManager.ts electron/preload-extensions.ts engine-overrides/renderer/widget/WidgetApp.tsx engine-overrides/renderer/widget/Widget.tsx
git commit -m "feat(stt): quiet-capture gate — faint audio + tiny transcript never pastes fiction"
```

---

### Task 12: Post-STT cleanup pass

**Files:**
- Create: `engine-overrides/electron/cleanupPass.ts`
- Test: `engine-overrides/electron/cleanupPass.test.ts`
- Modify: `engine-overrides/electron/sessionManager.ts` (both dictation output paths)
- Modify: `desktop/electron/paywall-glue.ts` (setting getter/setter + IPC)
- Modify: `desktop/electron/preload-extensions.ts` (settings surface)
- Modify: `engine-overrides/renderer/app/Settings.tsx` (toggle)

**Interfaces:**
- Produces: `buildCleanupMessages(raw: string): Array<{ role: 'system' | 'user'; content: string }>`, `acceptCleanupResult(raw: string, cleaned: string | null): string` (pure — returns the text to paste, falling back to `raw` on any doubt), `shouldAttemptCleanup(raw: string): boolean`. Glue: `getDictationCleanupEnabled(): boolean` (electron-store key `dictationCleanup`, default `true`), IPC `paywall:get-dictation-cleanup` / `paywall:set-dictation-cleanup`; preload `paywallGetDictationCleanup(): Promise<boolean>`, `paywallSetDictationCleanup(v: boolean): Promise<void>`.

- [ ] **Step 1: Failing test**

Create `engine-overrides/electron/cleanupPass.test.ts`:

```ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { buildCleanupMessages, acceptCleanupResult, shouldAttemptCleanup } from './cleanupPass'

describe('shouldAttemptCleanup', () => {
  test('skips short utterances (not worth latency)', () => {
    assert.equal(shouldAttemptCleanup('Yes, do it.'), false)
  })
  test('attempts on real dictations', () => {
    assert.equal(shouldAttemptCleanup('Uh so so I I want you to create a new worktree from the main branch and then we will work on the feature'), true)
  })
})

describe('buildCleanupMessages', () => {
  test('two messages, raw text in the user turn, verbatim-preserving system rules', () => {
    const m = buildCleanupMessages('raw text here')
    assert.equal(m.length, 2)
    assert.equal(m[0].role, 'system')
    assert.match(m[0].content, /do not add|never add/i)
    assert.equal(m[1].role, 'user')
    assert.equal(m[1].content, 'raw text here')
  })
})

describe('acceptCleanupResult', () => {
  const raw = 'Uh so so I I want you to create a new worktree from the main branch please'
  test('accepts a plausible cleanup', () => {
    const cleaned = 'So I want you to create a new worktree from the main branch please'
    assert.equal(acceptCleanupResult(raw, cleaned), cleaned)
  })
  test('rejects null/empty', () => {
    assert.equal(acceptCleanupResult(raw, null), raw)
    assert.equal(acceptCleanupResult(raw, '  '), raw)
  })
  test('rejects refusals', () => {
    assert.equal(acceptCleanupResult(raw, "I'm sorry, I can't help with that."), raw)
  })
  test('rejects suspicious shrink (<40% of raw) and growth (>140%)', () => {
    assert.equal(acceptCleanupResult(raw, 'ok'), raw)
    assert.equal(acceptCleanupResult(raw, raw + ' ' + raw), raw)
  })
})
```

- [ ] **Step 2: Run to verify failure**

`npm test 2>&1 | tail -4` → FAIL.

- [ ] **Step 3: Implement**

Create `engine-overrides/electron/cleanupPass.ts`:

```ts
// cleanupPass — the polish layer between raw STT text and the paste.
//
// WHY (2026-07-15 decision): our pipeline pastes verbatim STT output —
// "Uh so so I I want you to create creator..." — while competitors run a
// fast LLM pass that drops fillers and stutter-duplicates. Half the
// perceived accuracy gap is this polish. Rules are deliberately narrow:
// remove disfluencies, fix nothing else, never add content. Every guard
// fails OPEN to the raw transcript — a bad cleanup must never eat words.
// Pure module: unit-tested by cleanupPass.test.ts. The LLM call itself
// lives in sessionManager (tryManagedLLM) with a hard timeout.

export const CLEANUP_TIMEOUT_MS = 900
const MIN_RAW_CHARS = 40
const MIN_RATIO = 0.4
const MAX_RATIO = 1.4

const REFUSAL_RE = /(i('m| am) sorry.{0,20}(can't|cannot)|i (can't|cannot) (help|assist|process)|as an ai|against my (guidelines|policy))/i

const SYSTEM_PROMPT = [
  'You clean up raw speech-to-text dictation. Apply ONLY these edits:',
  '1. Remove filler words (uh, um, like when used as filler).',
  '2. Collapse stutter repeats ("so so", "I I", "the the" → one).',
  '3. Remove false starts the speaker abandoned mid-phrase.',
  'Rules: NEVER add words, facts, or content that is not in the input.',
  'Do not rephrase, summarize, or change meaning, tone, or language.',
  'Keep slang, profanity, and technical terms exactly as spoken.',
  'Return ONLY the cleaned text — no quotes, no commentary.',
].join(' ')

export function shouldAttemptCleanup(raw: string): boolean {
  return raw.trim().length >= MIN_RAW_CHARS
}

export function buildCleanupMessages(raw: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: raw },
  ]
}

export function acceptCleanupResult(raw: string, cleaned: string | null): string {
  if (!cleaned) return raw
  const c = cleaned.trim()
  if (!c) return raw
  if (REFUSAL_RE.test(c)) return raw
  const ratio = c.length / Math.max(1, raw.trim().length)
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) return raw
  return c
}
```

- [ ] **Step 4: Run tests to verify pass; wire the setting into glue + preload**

`npm test 2>&1 | tail -4` → PASS.

`paywall-glue.ts` — find the `PaywallSettings` type / `settings` store usage; add key + accessor + IPC next to the existing settings handlers:

```ts
export function getDictationCleanupEnabled(): boolean {
  return (settings.get('dictationCleanup') as boolean | undefined) ?? true
}
```

```ts
  ipcMain.handle('paywall:get-dictation-cleanup', () => getDictationCleanupEnabled())
  ipcMain.handle('paywall:set-dictation-cleanup', (_e, v: boolean) => {
    settings.set('dictationCleanup', !!v)
    return true
  })
```

(If `PaywallSettings` is a typed interface, add `dictationCleanup?: boolean` to it.)

`preload-extensions.ts`:

```ts
  // Post-STT cleanup pass (fillers/stutters). Default ON; hard 900ms budget,
  // fails open to the raw transcript.
  paywallGetDictationCleanup: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:get-dictation-cleanup'),
  paywallSetDictationCleanup: (v: boolean): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-dictation-cleanup', v),
```

- [ ] **Step 5: sessionManager — the guarded call**

Imports:

```ts
import { buildCleanupMessages, acceptCleanupResult, shouldAttemptCleanup, CLEANUP_TIMEOUT_MS } from './cleanupPass'
import { getDictationCleanupEnabled } from './paywall/paywall-glue'
```

(`paywall-glue` is already imported at lines 16/19 — extend those import statements instead of adding new ones.)

Add a private method after `quietMiss`:

```ts
  /** Fast LLM polish for raw dictation: fillers/stutters out, meaning intact.
   *  Hard CLEANUP_TIMEOUT_MS budget; every failure path returns the raw text. */
  private async maybeCleanupDictation(raw: string, signal?: AbortSignal): Promise<string> {
    try {
      if (!raw || !shouldAttemptCleanup(raw)) return raw
      if (!getDictationCleanupEnabled()) return raw
      const t0 = Date.now()
      const attempt = tryManagedLLM(buildCleanupMessages(raw), { temperature: 0 }, signal)
        .then((r) => r?.text ?? null)
        .catch(() => null)
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), CLEANUP_TIMEOUT_MS))
      const cleaned = await Promise.race([attempt, timeout])
      const result = acceptCleanupResult(raw, cleaned)
      logTelemetry('cleanup-pass', {
        ms: Date.now() - t0,
        applied: result !== raw,
        rawChars: raw.length,
        outChars: result.length,
      })
      if (result !== raw) console.log(`[session] ✨ cleanup pass applied in ${Date.now() - t0}ms (${raw.length}→${result.length} chars)`)
      return result
    } catch {
      return raw
    }
  }
```

Call sites (dictation only, never remote-kind):

(a) Pipeline STT-only path — replace `output = formatOutputForUser(output)` with:

```ts
            output = await this.maybeCleanupDictation(output, controller.signal)
            output = formatOutputForUser(output)
```

(This sits after the remote-kind dispatch return, so remote captures are untouched.)

(b) Sequential/chunked path — in `case 'dictation':` after the quiet gate from Task 11:

```ts
            if (output) output = await this.maybeCleanupDictation(output, controller.signal)
```

- [ ] **Step 6: Settings toggle**

In `engine-overrides/renderer/app/Settings.tsx`, locate the existing screenshot-capture toggle block (search for `screenshot`) and add a sibling toggle row using the exact same row/toggle components and styling used there, with:

- Label: `Dictation cleanup`
- Description: `Remove filler words and stutters before pasting (adds <1s only when needed)`
- State: load via `window.electronAPI.paywallGetDictationCleanup?.()` (cast `window.electronAPI as any` if the row's siblings do the same for paywall methods — mirror the file's existing access pattern), save via `paywallSetDictationCleanup(next)`.

Follow the neighboring toggle's exact JSX structure — same wrapper, same switch component, same class names.

- [ ] **Step 7: Verify + commit**

`npm run typecheck` → clean. `npm test` → pass.

```bash
git add engine-overrides/electron/cleanupPass.ts engine-overrides/electron/cleanupPass.test.ts engine-overrides/electron/sessionManager.ts electron/paywall-glue.ts electron/preload-extensions.ts engine-overrides/renderer/app/Settings.tsx
git commit -m "feat(dictation): post-STT cleanup pass — fillers/stutters out, 900ms budget, fails open to raw"
```

---

### Task 13: Retire the old race for dictation + final sweep

**Files:**
- Modify: `engine-overrides/electron/sessionManager.ts` (rename + comment `raceCloudVsLocalSTT`)

- [ ] **Step 1: Confine the old race to instructions**

`raceCloudVsLocalSTT` now serves ONLY instruction audio. Rename it to `raceCloudVsLocalForInstruction` (update its one remaining call site in `processSession`'s instruction half), and replace its doc comment header with:

```ts
  // ────────────────────────────────────────────────────────────────
  // INSTRUCTION-ONLY legacy race. Dictation STT routing moved to
  // SttArbiter (sttArbiter.ts) on 2026-07-15: the 4s hard local-commit
  // below produced mixed-engine transcripts and silent quality drops —
  // never reintroduce it on the dictation path. Instructions are short,
  // post-key-up commands where the 4s commit remains acceptable.
  // ────────────────────────────────────────────────────────────────
```

Keep `SPECULATIVE_LOCAL_START_MS` / `LOCAL_COMMIT_MS` (the instruction race still uses them).

- [ ] **Step 2: Full verification**

Run: `npm test 2>&1 | tail -8` → ALL pass.
Run: `npm run typecheck` → clean.
Run: `grep -n "raceCloudVsLocalSTT" engine-overrides/electron/sessionManager.ts` → zero hits (fully renamed).

- [ ] **Step 3: Commit**

```bash
git add engine-overrides/electron/sessionManager.ts
git commit -m "refactor(stt): confine legacy 4s race to instruction audio — dictation is arbiter-only"
```

---

## Post-implementation verification (manual, needs relaunch)

Not part of the automated tasks — run after all commits:

1. `npm run dev > /tmp/unmute-dev.log 2>&1 & disown` (detached; engine-overrides only apply at launch).
2. Dictate normally on good wifi → pastes cloud, pill never shows the offer; check `/tmp/unmute-dev.log` for `arbiter` lines and `~/Library/Application Support/unmute/telemetry/dictation-*.jsonl` for `chunk-resolved`/`capture-quality` events.
3. Simulate slow cloud (Network Link Conditioner or toggle wifi off mid-processing) → pill shows "Taking longer… / Use quick draft"; tap pastes the Parakeet draft; DB row gets `better_transcript` when wifi returns within 30s.
4. Whisper-quiet test: dictate from across the room → "Mic was too quiet — didn't catch that", nothing pasted, transcript in History.
5. Long dictation (>45s) with music playing → log shows `cut=silence`/`cut=soft-cap`, not `hard-cap`.
