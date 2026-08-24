# Meeting notetaker — per-segment speaker attribution (Zoom) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute each system-channel transcript segment to a named Zoom speaker when detectable, falling back to today's generic "Them" everywhere else — no change to audio capture, detection, or the manual trigger.

**Architecture:** A new poller reads Zoom's accessibility tree (via the already-verified-reachable `unmute-native-ax` module) only while a Zoom capture session is active, collecting timestamped `{speakerName, timestampMs}` samples. At session-end, each system-channel segment is attributed to whichever speaker was active for the largest share of its `[startMs,endMs]` window (majority vote by time-overlap) — a pure function over plain data, independent of the audio pipeline.

**Tech Stack:** TypeScript, `unmute-native-ax`'s existing `find(app, label, role)` API, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-notetaker-speaker-attribution.md` — read this first. §2 is critical: Zoom's exact in-call AX-tree shape for "who is speaking" was NOT verified against a real live call tonight (would require joining one) — every task below is written with that disclosed uncertainty in mind, which is why Task 1's heuristic ships with extensive raw-candidate logging rather than a single hardcoded assumption.

## Global Constraints

- Google Meet is explicitly out of scope (native-ax cannot reach Chrome's web content — verified empirically, see spec §1).
- No change to the global-audio-tap architecture, detection, the manual chord trigger, or the mic/system channel split.
- `speakerName` is additive-only on `TranscriptSegment`/`NotetakerTranscriptSegment` — every existing consumer must keep working unchanged when it's absent.
- Mic-channel segments never get a `speakerName` — only `system`-channel segments are eligible.
- New polling only runs when a session is active AND the resolved target app's bundle id is `us.zoom.xos` — never otherwise.

---

### Task 1: Zoom speaker-poll heuristic (pure, unit-tested)

**Files:**
- Create: `desktop/engine-overrides/electron/notetaker/zoomSpeaker.ts`
- Test: `desktop/engine-overrides/electron/notetaker/zoomSpeaker.test.ts`

**Interfaces:**
- Produces: `pollZoomSpeaker(ax: NativeAxLike): SpeakerPollResult`, `type NativeAxLike`, `type SpeakerPollResult = { speakerName: string | null; candidateCount: number; rawCandidates: Array<{ role: string; label: string }> }`
- Consumes: nothing from earlier tasks (this is the first task)

This function is deliberately a best-effort heuristic, not a confirmed-correct implementation — see spec §2. It must be safe to call frequently and must never throw.

- [ ] **Step 1: Write the failing tests**

```typescript
// desktop/engine-overrides/electron/notetaker/zoomSpeaker.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { pollZoomSpeaker, type NativeAxLike } from './zoomSpeaker'

function fakeAx(nodes: Array<{ id: number; role: string; label: string; actions: string[] }>): NativeAxLike {
  return {
    find: () => ({ app: 'zoom.us', nodes, total: nodes.length }),
  }
}

describe('pollZoomSpeaker', () => {
  test('finds a name adjacent to a common speaking-state hint', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'Sarah Chen is speaking', actions: [] },
      { id: 2, role: 'AXStaticText', label: 'Participants (4)', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, 'Sarah Chen')
    assert.equal(result.candidateCount, 1)
  })

  test('handles a parenthesized hint', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'John Park (active speaker)', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, 'John Park')
  })

  test('no matching nodes returns null speakerName, zero candidates', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXButton', label: 'Mute', actions: ['AXPress'] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, null)
    assert.equal(result.candidateCount, 0)
  })

  test('empty node list returns null, does not throw', () => {
    const result = pollZoomSpeaker(fakeAx([]))
    assert.equal(result.speakerName, null)
    assert.equal(result.candidateCount, 0)
  })

  test('an ax.find() error result returns null, does not throw', () => {
    const ax: NativeAxLike = { find: () => ({ app: 'zoom.us', nodes: [], total: 0, error: 'app not running' }) }
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, null)
  })

  test('every matching node is captured in rawCandidates, even though only the first is used as speakerName', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'Sarah Chen is speaking', actions: [] },
      { id: 2, role: 'AXStaticText', label: 'John Park is speaking', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.candidateCount, 2)
    assert.equal(result.rawCandidates.length, 2)
    assert.equal(result.speakerName, 'Sarah Chen') // first match wins, deterministic
  })

  test('a hint with no recoverable name (empty after stripping) returns null, not an empty string', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'is speaking', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, null)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail** (module doesn't exist yet)

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/zoomSpeaker.test.ts`
Expected: FAIL — cannot find module './zoomSpeaker'

- [ ] **Step 3: Implement**

```typescript
// desktop/engine-overrides/electron/notetaker/zoomSpeaker.ts
//
// Best-effort, UNVERIFIED heuristic for "who is Zoom's currently active
// speaker," read from Zoom's own accessibility tree via unmute-native-ax.
//
// WHY UNVERIFIED: confirming Zoom's exact in-call AX-tree shape for a
// speaking-state indicator would require joining a real, live, multi-person
// Zoom call — not available while building this. What IS verified (see
// docs/superpowers/specs/2026-08-24-notetaker-speaker-attribution.md §2):
// native-ax's find()/getTree() genuinely reaches deep into Zoom's real UI
// content (confirmed against Zoom's actual sign-in form — AXTextField
// "Email", AXCheckBox "Keep me signed in", etc. — not just window chrome),
// unlike Chrome, where the same mechanism returns only toolbar/tab-strip
// nodes and never reaches web page content. So the MECHANISM is sound; only
// the exact label pattern Zoom uses for "this person is talking" is a
// documented guess, not a confirmed fact.
//
// This ships with every candidate node it examined captured in
// rawCandidates specifically so a real capture's notetaker log (which logs
// this function's full result on every poll — see notetakerInit.ts) can be
// read after a real Zoom call to see what the tree actually contains, and
// this heuristic can be tuned from real data in a fast follow-up round —
// the same "ship instrumented, verify from real logs, fix" loop that found
// and fixed this session's real audio-tap bugs.

export type NativeAxFindResult = {
  app: string
  nodes: Array<{ id: number; role: string; label: string; actions: string[] }>
  total: number
  error?: string
}

export type NativeAxLike = {
  find: (app: string, label: string, role: string) => NativeAxFindResult
}

export type SpeakerPollResult = {
  speakerName: string | null
  candidateCount: number
  rawCandidates: Array<{ role: string; label: string }>
}

// Common screen-reader conventions for indicating an active speaker —
// documented guess, see header comment.
const SPEAKING_HINT = /\bis speaking\b|\bspeaking now\b|\bactive speaker\b|\btalking\b/i

export function pollZoomSpeaker(ax: NativeAxLike): SpeakerPollResult {
  let found: NativeAxFindResult
  try {
    found = ax.find('zoom.us', '', '')
  } catch {
    return { speakerName: null, candidateCount: 0, rawCandidates: [] }
  }
  if (found.error || !Array.isArray(found.nodes)) {
    return { speakerName: null, candidateCount: 0, rawCandidates: [] }
  }

  const candidates = found.nodes.filter((n) => SPEAKING_HINT.test(n.label ?? ''))
  const rawCandidates = candidates.map((n) => ({ role: n.role, label: n.label }))
  if (candidates.length === 0) {
    return { speakerName: null, candidateCount: 0, rawCandidates }
  }

  // Strip the matched hint phrase and any surrounding punctuation/parens to
  // recover just the name. First match wins — deterministic, not a guess
  // at "most likely" when multiple candidates exist.
  const rawName = candidates[0].label
    .replace(SPEAKING_HINT, '')
    .replace(/[(),.\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    speakerName: rawName.length > 0 ? rawName : null,
    candidateCount: candidates.length,
    rawCandidates,
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/zoomSpeaker.test.ts`
Expected: PASS, all 7 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/zoomSpeaker.ts desktop/engine-overrides/electron/notetaker/zoomSpeaker.test.ts
git commit -m "notetaker: add best-effort Zoom active-speaker AX-tree heuristic"
```

---

### Task 2: Per-segment speaker attribution (pure, unit-tested)

**Files:**
- Modify: `desktop/engine-overrides/electron/notetaker/transcriptMerge.ts`
- Modify: `desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent — takes plain `{speakerName, timestampMs}[]`, not `SpeakerPollResult` directly; the caller in a later task adapts one to the other)
- Produces: `attributeSpeakers(segments: TranscriptSegment[], samples: SpeakerSample[]): TranscriptSegment[]`, `type SpeakerSample = { speakerName: string | null; timestampMs: number }`, and extends `TranscriptSegment` with `speakerName?: string | null`

- [ ] **Step 1: Write the failing tests**

Read the existing `transcriptMerge.test.ts` first for the house style (import pattern, `describe`/`test` shape) before adding these — match it exactly rather than guessing.

```typescript
// added to desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts
import { attributeSpeakers, type SpeakerSample } from './transcriptMerge'

describe('attributeSpeakers', () => {
  test('a system segment gets the speaker who was sampled for the largest share of its time window', () => {
    const segments = [{ channel: 'system' as const, text: 'hello', startMs: 0, endMs: 10000 }]
    const samples: SpeakerSample[] = [
      { speakerName: 'Sarah', timestampMs: 1000 },
      { speakerName: 'Sarah', timestampMs: 3000 },
      { speakerName: 'John', timestampMs: 8000 },
    ]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, 'Sarah')
  })

  test('no samples fall inside the segment window -> speakerName is null', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [{ speakerName: 'Sarah', timestampMs: 50000 }]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, null)
  })

  test('every in-range sample is null -> speakerName is null, not "null" the string', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [{ speakerName: null, timestampMs: 500 }]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, null)
  })

  test('mic segments are never attributed, even with in-range samples', () => {
    const segments = [{ channel: 'mic' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [{ speakerName: 'Sarah', timestampMs: 500 }]
    const result = attributeSpeakers(segments, samples)
    assert.equal('speakerName' in result[0], false)
  })

  test('empty samples array -> every system segment stays null, no throw', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const result = attributeSpeakers(segments, [])
    assert.equal(result[0].speakerName, null)
  })

  test('a tie between two speakers picks whichever was sampled first, deterministically', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [
      { speakerName: 'John', timestampMs: 100 },
      { speakerName: 'Sarah', timestampMs: 200 },
    ]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, 'John')
  })

  test('does not mutate the input segments array', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    attributeSpeakers(segments, [{ speakerName: 'Sarah', timestampMs: 500 }])
    assert.equal('speakerName' in segments[0], false)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/transcriptMerge.test.ts`
Expected: FAIL — `attributeSpeakers` is not exported

- [ ] **Step 3: Implement**

Read the top of `transcriptMerge.ts` first for the exact existing `TranscriptSegment` type and export style before editing — match it exactly.

```typescript
// added to desktop/engine-overrides/electron/notetaker/transcriptMerge.ts

export type SpeakerSample = { speakerName: string | null; timestampMs: number }

/**
 * Attributes each system-channel segment to whichever speaker was sampled
 * for the largest share of that segment's [startMs, endMs] window
 * (majority vote by count of in-range samples — samples arrive on a
 * roughly-fixed poll interval, so sample count is a fair proxy for time
 * share). Mic segments are never touched — they're always "You," no
 * attribution needed. Ties go to whichever candidate was sampled first
 * (Map insertion order), deterministic rather than arbitrary.
 *
 * Pure — does not mutate its inputs. See
 * docs/superpowers/specs/2026-08-24-notetaker-speaker-attribution.md §3.2.
 */
export function attributeSpeakers(
  segments: TranscriptSegment[],
  samples: SpeakerSample[]
): TranscriptSegment[] {
  return segments.map((seg) => {
    if (seg.channel !== 'system') return seg
    const inRange = samples.filter(
      (s) => s.timestampMs >= seg.startMs && s.timestampMs <= seg.endMs && s.speakerName
    )
    if (inRange.length === 0) return { ...seg, speakerName: null }
    const counts = new Map<string, number>()
    for (const s of inRange) {
      counts.set(s.speakerName as string, (counts.get(s.speakerName as string) ?? 0) + 1)
    }
    let winner: string | null = null
    let winnerCount = 0
    for (const [name, count] of counts) {
      if (count > winnerCount) { winner = name; winnerCount = count }
    }
    return { ...seg, speakerName: winner }
  })
}
```

Also add `speakerName?: string | null` to the existing `TranscriptSegment` type definition in this file (find it, extend it additively — do not reorder or rename existing fields).

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetaker/transcriptMerge.test.ts`
Expected: PASS, all existing tests plus the 7 new ones

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/transcriptMerge.ts desktop/engine-overrides/electron/notetaker/transcriptMerge.test.ts
git commit -m "notetaker: add per-segment speaker attribution by time-overlap majority vote"
```

---

### Task 3: Wire Zoom polling into the capture session

**Files:**
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts`

No test file — this task is Electron main-process wiring glue, same category as the rest of `notetakerInit.ts` (not unit-tested, per this file's own established precedent throughout the branch).

**Interfaces:**
- Consumes: `pollZoomSpeaker`, `type NativeAxLike`, `type SpeakerPollResult` (Task 1); `type SpeakerSample` (Task 2)
- Produces: a per-session `zoomSpeakerSamples: SpeakerSample[]` array, populated only during a Zoom session, available to Task 4's `persistSession()` call

- [ ] **Step 1: Read the current file's session-lifecycle code first**

Read `desktop/engine-overrides/electron/notetakerInit.ts` in full before editing — specifically `HookedNotetakerSession.start()`/`stop()`, the `ax`/`nativeAudioTap` closures, the existing `NativeAx` interface (currently only declares `frontmostApp()`/`listApps()` — deliberately narrow, "the slice of the native-ax addon's surface this file actually needs," per its own doc comment), and the existing `pollMeetingSignal`/`pollTimer` pattern (change-only debug logging, `.unref()`, cleared implicitly since it runs for the app's lifetime not per-session — this new poller is different: per-SESSION, started in `start()` and cleared in `stop()`, not a lifetime timer). Match the established logging/closure conventions in this file exactly (it already has a `createNotetakerLogger('init')` instance in scope as `log`, and `mlog`/`clog` child-logger patterns per session/chunk).

- [ ] **Step 2: Implement**

Add the import:

```typescript
import { pollZoomSpeaker } from './notetaker/zoomSpeaker'
import type { SpeakerSample } from './notetaker/transcriptMerge'
```

Extend the existing `NativeAx` interface with `find` (do NOT cast around the missing method — extend the interface itself, matching the file's own established pattern of declaring exactly the surface it uses):

```typescript
interface NativeAx {
  frontmostApp(): string
  listApps(): Array<{ name: string; bundleId: string; pid: number; windowsHere: number; windowsAnywhere: number }>
  /** Added for Zoom active-speaker polling — see zoomSpeaker.ts. Matches
   *  unmute-native-ax's real find(app, label, role) signature. */
  find(app: string, label: string, role: string): {
    app: string
    nodes: Array<{ id: number; role: string; label: string; actions: string[] }>
    total: number
    error?: string
  }
}
```

Add a per-session state variable alongside `micTracker`/`systemTracker` (declared with the other `let`s before `HookedNotetakerSession`):

```typescript
let zoomSpeakerSamples: SpeakerSample[] = []
let zoomSpeakerPollTimer: ReturnType<typeof setInterval> | null = null
```

In `HookedNotetakerSession.start(pid)`, after resolving whether this is a Zoom session (reuse the already-in-scope `ax` closure variable — do NOT re-require or duplicate the native-ax load):

```typescript
zoomSpeakerSamples = []
const isZoomSession = ax.listApps().some((a) => a.pid === pid && a.bundleId === 'us.zoom.xos')
if (isZoomSession) {
  const ZOOM_SPEAKER_POLL_MS = 2500
  let lastLoggedSpeaker: string | null | undefined = undefined // undefined = never logged yet
  zoomSpeakerPollTimer = setInterval(() => {
    // `ax: NativeAx` (now including `find`, per the interface extension
    // above) structurally satisfies zoomSpeaker.ts's NativeAxLike — no
    // cast needed.
    const result = pollZoomSpeaker(ax)
    zoomSpeakerSamples.push({ speakerName: result.speakerName, timestampMs: Date.now() })
    // Change-only logging for the resolved name (same convention as
    // pollMeetingSignal's meeting-signal sample changed below), but always
    // include rawCandidates when there's anything to show — this raw data
    // is the whole point, see zoomSpeaker.ts's header comment.
    if (result.speakerName !== lastLoggedSpeaker || result.candidateCount > 0) {
      lastLoggedSpeaker = result.speakerName
      mlog.debug('zoom-speaker-poll', {
        speakerName: result.speakerName,
        candidateCount: result.candidateCount,
        rawCandidates: result.rawCandidates,
      })
    }
  }, ZOOM_SPEAKER_POLL_MS)
  zoomSpeakerPollTimer.unref()
}
```

(`mlog` here must be the same per-session child logger already constructed earlier in `start()` — confirm its exact variable name by reading the surrounding code, don't assume.)

In `HookedNotetakerSession.stop()`, alongside where `micEm`/`systemEm` are snapshotted before the async chain:

```typescript
if (zoomSpeakerPollTimer) {
  clearInterval(zoomSpeakerPollTimer)
  zoomSpeakerPollTimer = null
}
const speakerSamplesForThisSession = zoomSpeakerSamples
```

Use `speakerSamplesForThisSession` (not the module-level `zoomSpeakerSamples`, which a subsequent `start()` could reassign before this session's async persist chain finishes — same reasoning already applied to `mic`/`system`/`meetingId`/`startedAt` snapshots in this exact function) — thread it into the `persistSession(...)` call added in Task 4.

- [ ] **Step 3: Typecheck**

Run: `cd desktop && npx tsc -p tsconfig.typecheck.json 2>&1 | grep -c "error TS"`
Expected: some number of errors from `persistSession`'s signature not yet matching (Task 4 fixes this) — this is expected and resolved by the next task, not a regression to chase down in isolation. Note the count here for the review package; Task 4's reviewer confirms it drops back to the 7-error baseline.

- [ ] **Step 4: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerInit.ts
git commit -m "notetaker: poll Zoom's active speaker during Zoom capture sessions"
```

---

### Task 4: Thread speaker samples through persistSession, attribute, and log

**Files:**
- Modify: `desktop/engine-overrides/electron/notetaker/transcribeSession.ts`
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts` (the `persistSession(...)` call site from Task 3)

**Interfaces:**
- Consumes: `attributeSpeakers`, `type SpeakerSample` (Task 2); the `speakerSamplesForThisSession` local from Task 3
- Produces: `persistSession(...)` with one new parameter; `transcript.json` segments now carry `speakerName` when attributable

- [ ] **Step 1: Read `persistSession`'s current signature and body in `transcribeSession.ts` first** — match its existing parameter-ordering and logging conventions exactly, don't guess.

- [ ] **Step 2: Implement**

Add the new parameter (append at the end of the existing parameter list, so this is a pure addition, not a reordering that would silently break any other caller):

```typescript
export async function persistSession(
  micChunks: TimedChunkText[],
  systemChunks: TimedChunkText[],
  meetingId: string,
  startedAt: number,
  endedAt: number,
  failed: boolean,
  audioMicPath: string | null,
  audioSystemPath: string | null,
  zoomSpeakerSamples: SpeakerSample[] = [],
): Promise<void> {
  // ... existing body up through `const segments: TranscriptSegment[] = mergeChannelChunks(micChunks, systemChunks)` unchanged ...
  const attributedSegments = attributeSpeakers(segments, zoomSpeakerSamples)
  const title = generateTitle(attributedSegments)
  // ... use attributedSegments everywhere `segments` was previously used below this point (the transcript.json write, and any logging that references segment count) ...

  const attributedCount = attributedSegments.filter((s) => s.channel === 'system' && s.speakerName).length
  const systemSegmentCount = attributedSegments.filter((s) => s.channel === 'system').length
  mlog.event('speaker-attribution-summary', {
    zoomSpeakerSamplesCollected: zoomSpeakerSamples.length,
    systemSegmentCount,
    attributedCount,
  })
  // ... rest of the existing body (insertMeeting call etc.) unchanged, but referencing attributedSegments' length where `segments.length`/`segmentCount` was logged before ...
}
```

Import `attributeSpeakers` and `type SpeakerSample` from `./transcriptMerge` (already importing other things from that module — extend the existing import line, don't add a second one).

Update the Task-3 call site in `notetakerInit.ts` to pass the new argument:

```typescript
return persistSession(
  micChunks,
  systemChunks,
  meetingId,
  startedAt,
  endedAt,
  micFailed || systemFailed,
  mic.audioFileName,
  system.audioFileName,
  speakerSamplesForThisSession,
)
```

- [ ] **Step 3: Typecheck**

Run: `cd desktop && npx tsc -p tsconfig.typecheck.json 2>&1 | grep -c "error TS"`
Expected: back to exactly 7 (the pre-existing baseline) — if not, the signature threading has a mismatch, fix before moving on.

- [ ] **Step 4: Run the full notetaker test suite**

Run: `cd desktop && node --import tsx --test 'engine-overrides/electron/notetaker/**/*.test.ts' engine-overrides/electron/notetakerSession.test.ts engine-overrides/electron/notetakerController.test.ts`
Expected: PASS, all tests (baseline 91 + this plan's new tests — confirm the exact number against what Task 1/2 actually added).

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetaker/transcribeSession.ts desktop/engine-overrides/electron/notetakerInit.ts
git commit -m "notetaker: attribute speaker names into persisted transcript segments"
```

---

### Task 5: Surface speaker names in the UI

**Files:**
- Modify: `desktop/electron/remote-preload.ts` (the `NotetakerTranscriptSegment` type)
- Modify: `desktop/engine-overrides/renderer/notetaker/MeetingDetail.tsx`

No test file — this is UI rendering glue, same as `MeetingDetail.tsx`'s existing untested precedent (its own file header explains why: needs a real Electron window to test meaningfully).

**Interfaces:**
- Consumes: the `speakerName?: string | null` field now present on segments returned by `notetaker:get-transcript` (Task 2/4's backend change — no IPC handler code changes needed, `notetaker:get-transcript` already returns whatever's in `transcript.json` verbatim)

- [ ] **Step 1: Extend the preload type**

In `remote-preload.ts`, find `NotetakerTranscriptSegment` and add the field:

```typescript
export type NotetakerTranscriptSegment = {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
  speakerName?: string | null
}
```

- [ ] **Step 2: Extend `MeetingDetail.tsx`'s local mirror type and rendering**

In `MeetingDetail.tsx`, find its local `NotetakerTranscriptSegment` mirror (this file redefines the preload type locally rather than importing it — match that existing pattern, don't introduce a cross-tree import) and add the same field:

```typescript
type NotetakerTranscriptSegment = {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
  speakerName?: string | null
}
```

Update the segment-rendering line:

```tsx
{segments?.map((seg, i) => (
  <div key={i} className="text-[13px] leading-relaxed">
    <span className="font-semibold text-ink">
      {seg.channel === 'mic' ? 'You' : (seg.speakerName || 'Them')}:{' '}
    </span>
    <span className="text-ink">{seg.text}</span>
  </div>
))}
```

- [ ] **Step 3: Typecheck**

Run: `cd desktop && npx tsc -p tsconfig.renderer.json 2>&1 | grep -c "error TS"`
Expected: exactly 122 (the pre-existing baseline), no new errors.

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/remote-preload.ts desktop/engine-overrides/renderer/notetaker/MeetingDetail.tsx
git commit -m "notetaker: show attributed speaker names in the meeting detail transcript"
```

---

## What this plan does not (and cannot) verify

- **Whether `pollZoomSpeaker`'s heuristic actually matches Zoom's real in-call accessibility labels.** This is the plan's central, explicitly disclosed risk (spec §2) — it was not possible to verify against a real live call while building this. The extensive `rawCandidates` logging exists specifically so the next real Zoom call's notetaker log can be read to confirm or fix this in a fast follow-up, not guessed at again.
- **Whether the 2.5s poll cadence is fine-grained enough** to catch fast speaker turn-taking in a real conversation, or too aggressive on `native-ax`'s AX-tree-walk cost during a live call (this file already documents a `HAL Voice Isolation`-adjacent "heavy main-process work while capturing corrupts audio" constraint elsewhere in the codebase — polling Zoom's AX tree is not audio work, but its cost on the main thread during an active mic/system capture is unverified).
- **Real on-device behavior of the whole pipeline** — same category of gap as this session's earlier plans; requires an actual signed, installed build and a real Zoom call.
