import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSIST_DEBOUNCE_MS, _resetForTest, adoptPersistedPad, armScratchpad, attachTranscript,
  beginOwnClipboardSequence, beginSegment, cancelOpenSegment, composeWithInserts, deliver,
  discard, endOwnClipboardSequence, endSegment, formatForDelivery, getCaptureSettings,
  initWatchers, isArmed, noteOwnClipboardWrite, pasteAtCursor, recordInsert, registerFormat,
  deliveryInFlight, heldForSurface, promoteSettledPad, registerPadObserver, registerPaste,
  commitDelivery, gateDelivery, registerSettings, removeFromPad, restageDelivery, runDelivery,
  segmentOpen, setOwnSequenceCeiling, setScratchpadRoot, snapshot, takeForDelivery,
  writePadNow,
} from './index'
import { SETTLE_IDLE_MS, deserialize, padDirFor, serialize } from './scratchpadStore'
import { TEXT_DEDUP_WINDOW_MS } from './clipboardLedger'
import { render } from './insertRender'
import { createClipboardWatch } from './clipboardWatch'
import type { createScreenshotWatch } from './screenshotWatch'

// ── Fake watchers ───────────────────────────────────────────────────────
// The real ones are tested in their own files. Here we only care that the
// façade drives their lifecycle in lockstep with the mic.

interface Calls { armed: string[]; disarms: number; starts: number; stops: number; ownWrites: number }

function fakeClipboardWatch(c: Calls): ReturnType<typeof createClipboardWatch> {
  return {
    arm: (dir: string) => { c.armed.push(dir) },
    disarm: () => { c.disarms++ },
    noteOwnWrite: () => { c.ownWrites++ },
    tick: async () => {},
    start: () => { c.starts++ },
    stop: () => { c.stops++ },
  }
}

interface ShotCalls { arms: number; disarms: number }
function fakeScreenshotWatch(c: ShotCalls): ReturnType<typeof createScreenshotWatch> {
  return { arm: () => { c.arms++ }, disarm: () => { c.disarms++ } }
}

let clipCalls: Calls
let shotCalls: ShotCalls
let root: string

function wire(): void {
  clipCalls = { armed: [], disarms: 0, starts: 0, stops: 0, ownWrites: 0 }
  shotCalls = { arms: 0, disarms: 0 }
  initWatchers(fakeClipboardWatch(clipCalls), fakeScreenshotWatch(shotCalls))
}

beforeEach(() => {
  _resetForTest()
  root = mkdtempSync(join(tmpdir(), 'unmute-pad-'))
  setScratchpadRoot(root)
  wire()
})

afterEach(() => {
  _resetForTest()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* gone */ }
})

const segs = () => snapshot().pad?.entries.filter((e) => e.type === 'segment') ?? []
const inserts = () => snapshot().pad?.entries.filter((e) => e.type === 'insert') ?? []

describe('the capture window is the recording window', () => {
  test('beginSegment arms both watchers, endSegment disarms both', () => {
    beginSegment('cursor', 1000, true)
    assert.equal(clipCalls.armed.length, 1)
    assert.equal(clipCalls.starts, 1)
    assert.equal(shotCalls.arms, 1)

    endSegment(2000)
    assert.equal(clipCalls.stops, 1)
    assert.equal(clipCalls.disarms, 1)
    assert.equal(shotCalls.disarms, 1)
  })

  test('observe:false arms NOTHING — capture disabled means never observed', () => {
    beginSegment('cursor', 1000, false)
    assert.equal(clipCalls.armed.length, 0)
    assert.equal(clipCalls.starts, 0)
    assert.equal(shotCalls.arms, 0)
  })

  test('the clipboard watcher is armed on the pad\'s own directory', () => {
    beginSegment('cursor', 1000, true)
    assert.equal(clipCalls.armed[0], padDirFor(root, snapshot().pad!.id))
  })

  test('cancelling the utterance also closes the capture window', () => {
    beginSegment('cursor', 1000, true)
    cancelOpenSegment(1500)
    assert.equal(clipCalls.stops, 1)
    assert.equal(shotCalls.disarms, 1)
  })

  test('noteOwnClipboardWrite reaches the watcher', () => {
    noteOwnClipboardWrite()
    assert.equal(clipCalls.ownWrites, 1)
  })

  test('noteOwnClipboardWrite with no watcher is a no-op, not a throw', () => {
    initWatchers(null, null)
    assert.doesNotThrow(() => noteOwnClipboardWrite())
  })

  test('the dedup claims do not accumulate across captures', () => {
    // The claims map answers "did the other detector already report this one
    // action?", which is only meaningful inside a window. Left unreset it is a
    // Map that grows for the life of the main process.
    const shot = join(root, 'same.png')
    writeFileSync(shot, 'IDENTICAL-BYTES')

    beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'image', content: shot, atMs: 1100 }, 1100)
    assert.equal(inserts().length, 1)
    endSegment(2000)

    beginSegment('cursor', 3000, true)
    recordInsert({ kind: 'image', content: shot, atMs: 3100 }, 3100)
    assert.equal(inserts().length, 1, 'a NEW capture re-copying the same image still records it')
  })
})

// The failure this exists to prevent: our own synthesised ⌘C read back as a
// user copy, which would put the user's own selection at the top of every
// dictation that started from a selection — on the fast path, silently. These
// tests drive the REAL clipboardWatch, because the guarantee is about what a
// tick can observe, not about what the façade remembers.
describe('our own pasteboard sequences are unobservable', () => {
  /** Wires a real clipboardWatch over a fake pasteboard. */
  function realWatch(state: { counter: number; text: string }) {
    const seen: { kind: string; content: string }[] = []
    const cw = createClipboardWatch({
      changeCount: () => state.counter,
      readText: () => state.text,
      hasImage: () => false,
      rescueImage: async () => null,
      exists: () => false,
      now: () => Date.now(),
      onInsert: (i) => { seen.push({ kind: i.kind, content: i.content }); recordInsert(i, Date.now()) },
    })
    initWatchers(cw, fakeScreenshotWatch(shotCalls))
    return { cw, seen }
  }

  test('THE TRACED TIMELINE: a tick landing between the copy and its record inserts NOTHING', async () => {
    const state = { counter: 10, text: 'https://the-users-own-selection.example' }
    const { cw, seen } = realWatch(state)
    beginSegment('cursor', Date.now(), true)

    // captureSelectedText begins.
    beginOwnClipboardSequence()

    state.counter++            // T+0    our clear …
    noteOwnClipboardWrite()    //        … announced immediately
    state.counter++            // T+200  the target app serves our synthesised ⌘C
    await cw.tick()            // T+250  THE POLL LANDS HERE — before the record
    noteOwnClipboardWrite()    // T+260  execFile's callback, 10ms too late
    state.counter++            //        our restore …
    noteOwnClipboardWrite()    //        … announced immediately

    endOwnClipboardSequence(Date.now())

    assert.deepEqual(seen, [], 'no tick may observe any change in the sequence')
    assert.equal(inserts().length, 0, 'and nothing reached the pad')
  })

  test('a tick DURING the sequence cannot fire even if the counter moved twice', async () => {
    const state = { counter: 10, text: 'user selection' }
    const { cw, seen } = realWatch(state)
    beginSegment('cursor', Date.now(), true)

    beginOwnClipboardSequence()
    state.counter += 2
    await cw.tick()
    await cw.tick()
    endOwnClipboardSequence(Date.now())

    assert.deepEqual(seen, [])
  })

  test('an insert DETECTED during the sequence is refused even if it arrives after it', async () => {
    // The in-flight rescue case: a tick suspended mid-await when suppression
    // began, resolving only once we have resumed.
    const state = { counter: 10, text: 'x' }
    realWatch(state)
    beginSegment('cursor', 1000, true)

    beginOwnClipboardSequence()
    const detectedAt = Date.now()
    endOwnClipboardSequence(detectedAt + 5)

    recordInsert({ kind: 'image', content: '/tmp/in-flight.png', atMs: detectedAt }, Date.now())
    assert.equal(inserts().length, 0, 'refused on its DETECTION instant, not its arrival')
  })

  test('a REAL copy after the sequence still lands — suppression is not a mute switch', async () => {
    const state = { counter: 10, text: 'before' }
    const { cw, seen } = realWatch(state)
    beginSegment('cursor', Date.now(), true)

    beginOwnClipboardSequence()
    state.counter++
    endOwnClipboardSequence(Date.now())

    await new Promise((r) => setTimeout(r, 2))
    state.counter++
    state.text = 'https://a-genuine-copy.example'
    await cw.tick()

    assert.equal(seen.length, 1)
    assert.equal(seen[0].content, 'https://a-genuine-copy.example')
    assert.equal(inserts().length, 1)
  })

  test('the sequence suspends the poll and resumes it', () => {
    beginSegment('cursor', 1000, true)
    const armsBefore = clipCalls.armed.length
    beginOwnClipboardSequence()
    assert.equal(clipCalls.stops, 1, 'no tick can START inside the sequence')
    assert.equal(clipCalls.disarms, 1, 'an in-flight tick takes the window-closed exit')
    endOwnClipboardSequence(2000)
    assert.equal(clipCalls.armed.length, armsBefore + 1, 're-baselined on resume')
    assert.equal(clipCalls.starts, 2, 'polling resumed')
  })

  test('nested sequences suspend once and resume once', () => {
    beginSegment('cursor', 1000, true)
    beginOwnClipboardSequence()
    beginOwnClipboardSequence()
    endOwnClipboardSequence(2000)
    assert.equal(clipCalls.starts, 1, 'still suspended — the outer sequence is live')
    endOwnClipboardSequence(2001)
    assert.equal(clipCalls.starts, 2)
  })

  test('an unmatched end is a no-op, not a spurious arm', () => {
    beginSegment('cursor', 1000, false)
    endOwnClipboardSequence(2000)
    assert.equal(clipCalls.armed.length, 0, 'the capture gate stays honoured')
  })

  test('resuming does NOT arm a watcher the gate left off', () => {
    beginSegment('cursor', 1000, false)
    beginOwnClipboardSequence()
    endOwnClipboardSequence(2000)
    assert.equal(clipCalls.armed.length, 0)
    assert.equal(clipCalls.starts, 0)
  })

  // The screenshot watcher is NOT suspended and fires synchronously, so a
  // Cmd-Shift-4 landing inside the sequence really does reach recordInsert.
  test('the CHUNKING SIGNAL is refused too, not just the pad entry', () => {
    beginSegment('cursor', 1000, true)
    beginOwnClipboardSequence()
    const recorded = recordInsert(
      { kind: 'image', content: join(root, 'shot-mid-sequence.png'), atMs: 1100 }, 1100,
    )
    assert.equal(recorded, false, 'recordInsert reports the refusal to its caller')
    assert.equal(inserts().length, 0, 'and nothing reached the pad')
    endOwnClipboardSequence(2000)
  })

  test('a normal insert reports that it WAS recorded', () => {
    beginSegment('cursor', 1000, true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.com', atMs: 1100 }, 1100), true)
    assert.equal(inserts().length, 1)
  })

  test('a deduped image reports refused, so it cannot double-signal either', () => {
    beginSegment('cursor', 1000, true)
    const a = join(root, 'dup-a.png')
    const b = join(root, 'dup-b.png')
    writeFileSync(a, 'SAME-BYTES')
    writeFileSync(b, 'SAME-BYTES')
    assert.equal(recordInsert({ kind: 'image', content: a, atMs: 1100 }, 1100), true)
    assert.equal(recordInsert({ kind: 'image', content: b, atMs: 1200 }, 1200), false)
  })

  test('with no pad at all, recordInsert reports refused', () => {
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.com', atMs: 5 }, 5), false)
  })

  // init.ts is not unit-testable (it pulls in the whole remote stack), so this
  // mirrors its onInsertRecorded helper exactly — `if (!recordInsert(…)) return`
  // — and asserts the property that matters: the pad and the screen can never
  // disagree about whether an insert happened.
  test('the announce is gated: a refused insert is never drawn', () => {
    const broadcasts: number[] = []
    const onInsertRecorded = (i: { kind: 'url' | 'image'; content: string; atMs: number }) => {
      if (!recordInsert(i, Date.now())) return
      broadcasts.push(i.atMs)
    }

    beginSegment('cursor', 1000, true)

    beginOwnClipboardSequence()
    onInsertRecorded({ kind: 'image', content: join(root, 'mid.png'), atMs: 1100 })
    assert.deepEqual(broadcasts, [], 'no pad broadcast for a refused insert')
    endOwnClipboardSequence(1200)

    onInsertRecorded({ kind: 'url', content: 'https://a.com', atMs: 1300 })
    assert.deepEqual(broadcasts, [1300])
    assert.equal(inserts().length, 1, 'the pad agrees with the surface')
  })
})

// captureSelectedText's osascript child has NO timeout, so a hung System
// Events could otherwise hold suppression up for the rest of the recording —
// refusing unrelated screenshot inserts the whole time. We bound the
// suppression rather than the child.
describe('suppression cannot outlive its purpose', () => {
  test('a sequence that never ends expires, and observation resumes', async () => {
    setOwnSequenceCeiling(30)
    beginSegment('cursor', 1000, true)

    const warn = console.warn
    console.warn = () => {} // the expiry IS logged; keep it out of test output
    try {
      beginOwnClipboardSequence() // and never end it — the child hung
      assert.equal(recordInsert({ kind: 'url', content: 'https://a.com', atMs: 1100 }, 1100), false)
      await new Promise((r) => setTimeout(r, 60))
    } finally {
      console.warn = warn
    }

    assert.equal(clipCalls.starts, 2, 'polling was restored without the caller returning')
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://b.com', atMs: Date.now() }, Date.now()),
      true,
      'capture resumed rather than staying dead for the recording',
    )
  })

  test('a sequence that ends normally cancels its ceiling', async () => {
    setOwnSequenceCeiling(30)
    beginSegment('cursor', 1000, true)
    beginOwnClipboardSequence()
    endOwnClipboardSequence(2000)
    const startsAfterEnd = clipCalls.starts
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(clipCalls.starts, startsAfterEnd, 'the expiry did not fire a second resume')
  })

  test('the ceiling does not clobber a still-running NESTED sequence prematurely', () => {
    setOwnSequenceCeiling(30)
    beginSegment('cursor', 1000, true)
    beginOwnClipboardSequence()
    beginOwnClipboardSequence()
    endOwnClipboardSequence(2000)
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://a.com', atMs: 2100 }, 2100), false,
      'the outer sequence is still live',
    )
  })
})

describe('pad lifecycle across captures', () => {
  test('an UNARMED leftover pad is dropped at the next capture', () => {
    const first = beginSegment('cursor', 1000, true)
    attachTranscript(first, 'one', 1500)
    endSegment(2000)
    const firstPadId = snapshot().pad!.id

    beginSegment('cursor', 3000, true)
    assert.notEqual(snapshot().pad!.id, firstPadId, 'a new pad, not the old one')
    assert.equal(segs().length, 1, 'only this capture\'s segment')
  })

  test('an ARMED pad survives and the next capture appends to it', () => {
    armScratchpad(true)
    const a = beginSegment('cursor', 1000, true)
    attachTranscript(a, 'one', 1500)
    endSegment(2000)
    const padId = snapshot().pad!.id

    const b = beginSegment('cursor', 3000, true)
    attachTranscript(b, 'two', 3500)
    endSegment(4000)

    assert.equal(snapshot().pad!.id, padId)
    assert.equal(segs().length, 2)
  })

  test('arming BETWEEN captures starts fresh — a stranger\'s dictation is not adopted', () => {
    const a = beginSegment('cursor', 1000, true)
    attachTranscript(a, 'someone else\'s words', 1500)
    endSegment(2000)

    armScratchpad(true)
    assert.equal(snapshot().pad, null, 'the leftover pad was dropped')
  })

  test('arming DURING a capture keeps what is being said right now', () => {
    const a = beginSegment('cursor', 1000, true)
    const padId = snapshot().pad!.id
    armScratchpad(true)
    assert.equal(snapshot().pad?.id, padId)
    attachTranscript(a, 'mine', 1500)
    assert.equal(segs().length, 1)
  })

  test('arming is refused when the scratchpad feature is off', () => {
    registerSettings(() => ({ scratchpadEnabled: false, captureEnabled: true }))
    assert.equal(armScratchpad(true), false)
    assert.equal(isArmed(), false)
  })

  test('disarming always works, gate or no gate', () => {
    armScratchpad(true)
    assert.equal(armScratchpad(false), false)
    assert.equal(isArmed(), false)
  })
})

describe('transcripts land on the right segment', () => {
  test('attachTranscript fills the open segment', () => {
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'hello there', 1500)
    assert.equal(segs()[0].type === 'segment' && segs()[0].text, 'hello there')
  })

  test('a transcript for a segment that was cancelled is APPENDED, never dropped', () => {
    const id = beginSegment('cursor', 1000, true)
    cancelOpenSegment(1200) // Escape removed it
    assert.equal(segs().length, 0)
    attachTranscript(id, 'undo re-processed this', 1500)
    assert.equal(segs().length, 1)
    assert.equal(segs()[0].type === 'segment' && segs()[0].text, 'undo re-processed this')
  })

  test('attachTranscript with no pad is a no-op', () => {
    assert.doesNotThrow(() => attachTranscript('nope', 'x', 1))
    assert.equal(snapshot().pad, null)
  })
})

describe('inserts', () => {
  test('are positioned on the pad\'s clock — which for a fresh pad IS the capture start', () => {
    beginSegment('cursor', 10_000, true)
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 12_500 }, 12_500)
    const i = inserts()[0]
    assert.equal(i.type === 'insert' && i.atMs, 2500)
  })

  test('are ignored when there is no pad', () => {
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 5 }, 5)
    assert.equal(snapshot().pad, null)
  })

  test('two detectors reporting the SAME image content yield ONE insert', () => {
    beginSegment('cursor', 1000, true)
    const a = join(root, 'shot.png')
    const b = join(root, 'rescued.png')
    writeFileSync(a, 'PNG-BYTES-SAME')
    writeFileSync(b, 'PNG-BYTES-SAME')
    recordInsert({ kind: 'image', content: a, atMs: 1100 }, 1100)
    recordInsert({ kind: 'image', content: b, atMs: 1200 }, 1200)
    assert.equal(inserts().length, 1, 'claimed on content, not on path')
  })

  test('two genuinely different images both land', () => {
    beginSegment('cursor', 1000, true)
    const a = join(root, 'one.png')
    const b = join(root, 'two.png')
    writeFileSync(a, 'FIRST')
    writeFileSync(b, 'SECOND-AND-LONGER')
    recordInsert({ kind: 'image', content: a, atMs: 1100 }, 1100)
    recordInsert({ kind: 'image', content: b, atMs: 1200 }, 1200)
    assert.equal(inserts().length, 2)
  })

  test('an UNREADABLE image is inserted rather than dropped', () => {
    beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'image', content: join(root, 'missing.png'), atMs: 1100 }, 1100)
    assert.equal(inserts().length, 1)
  })

  test('removeFromPad drops one entry and leaves the rest', () => {
    beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 1100 }, 1100)
    const id = inserts()[0].id
    removeFromPad(id, 1200)
    assert.equal(inserts().length, 0)
    assert.equal(segs().length, 1)
  })
})

// ── One clock per pad ───────────────────────────────────────────────────
//
// §2.1: "Order carries almost all of that value." It only carries it if every
// entry in the pad is measured from the same origin. Segments used to be
// written with a literal startMs: 0 while inserts carried an offset into the
// capture they happened in — so across two captures the segments piled up at
// zero and the inserts sorted against different zeroes, and the render came out
// with all the speech first and the inserts in the wrong order relative to each
// other. Stamping everything against pad.createdAt makes ordering a plain
// numeric sort again.

describe('one clock per pad — order composes ACROSS captures', () => {
  /** Two armed captures a minute apart, each with one copy in it. */
  function twoCaptures(): void {
    armScratchpad(true)
    const a = beginSegment('task', 100_000, true)
    recordInsert({ kind: 'url', content: 'https://LATE-in-capture-1', atMs: 110_000 }, 110_000)
    attachTranscript(a, 'first utterance', 120_000)
    endSegment(120_000)

    const b = beginSegment('task', 180_000, true)
    recordInsert({ kind: 'url', content: 'https://EARLY-in-capture-2', atMs: 182_000 }, 182_000)
    attachTranscript(b, 'second utterance', 190_000)
    endSegment(190_000)
  }

  test('an insert EARLY in capture 2 renders AFTER one LATE in capture 1', () => {
    // The exact failure, reproduced end to end. Before: "first utterance second
    // utterance https://EARLY-in-capture-2 https://LATE-in-capture-1".
    twoCaptures()
    assert.equal(
      render(snapshot().pad!, 'task').text,
      'first utterance https://LATE-in-capture-1 second utterance https://EARLY-in-capture-2',
    )
  })

  test('every entry is stamped from the pad\'s creation, not its capture\'s start', () => {
    twoCaptures()
    const times = snapshot().pad!.entries.map((e) => (e.type === 'segment' ? e.startMs : e.atMs))
    assert.deepEqual(times, [0, 10_000, 80_000, 82_000], 'seg1, insert1, seg2, insert2')
  })

  test('a segment knows when it ENDED, so it has a real duration', () => {
    // endMs was written as a literal 0 and never touched again, so the pad
    // panel could never show the "0:14" its own design calls for.
    armScratchpad(true)
    beginSegment('cursor', 100_000, true)
    endSegment(114_000)
    const s = segs()[0]
    assert.equal(s.type === 'segment' && s.startMs, 0)
    assert.equal(s.type === 'segment' && s.endMs, 14_000)
  })

  test('and so does a segment from a LATER capture in the same pad', () => {
    twoCaptures()
    const [first, second] = segs()
    assert.deepEqual(
      [first.type === 'segment' && first.endMs, second.type === 'segment' && second.endMs],
      [20_000, 90_000],
    )
    assert.equal(
      (second.type === 'segment' ? second.endMs - second.startMs : 0), 10_000,
      'the duration is right even though the origin is not this capture\'s start',
    )
  })

  test('THE SUPPRESSION FLOOR STILL SPEAKS WALL-CLOCK — the units under it did not move', () => {
    // suppressDetectedUpTo is a Date.now(), and it is compared against the raw
    // detection instant. The conversion to pad time happens strictly below it.
    // A second capture is what makes a units mix-up visible: the pad's origin
    // and this capture's start are 100s apart.
    armScratchpad(true)
    beginSegment('cursor', 100_000, true)
    endSegment(110_000)
    beginSegment('cursor', 200_000, true)

    beginOwnClipboardSequence()
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://ours', atMs: 200_100 }, 200_100), false,
      'refused during the sequence',
    )
    endOwnClipboardSequence(200_200)
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://stale', atMs: 200_200 }, 200_200), false,
      'and a rescue that only resolves after it is still refused',
    )
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://theirs', atMs: 200_300 }, 200_300), true,
      'a genuine copy after the sequence is admitted',
    )
    const i = inserts()[0]
    assert.equal(i.type === 'insert' && i.atMs, 100_300, 'and positioned on the PAD\'s clock')
  })
})

describe('deliver and discard', () => {
  test('deliver renders the pad and clears it', () => {
    armScratchpad(true)
    const id = beginSegment('task', 1000, true)
    attachTranscript(id, 'look at this', 1500)
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 1600 }, 1600)
    endSegment(2000)

    const out = deliver('task')
    assert.equal(out?.text, 'look at this https://a.com')
    assert.equal(snapshot().pad, null)
    assert.equal(isArmed(), false, 'delivering ends the hold')
  })

  test('deliver on an empty pad returns null and still clears', () => {
    assert.equal(deliver('cursor'), null)
    assert.equal(snapshot().pad, null)
  })

  test('discard clears the pad and the hold', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    discard()
    assert.equal(snapshot().pad, null)
    assert.equal(isArmed(), false)
  })
})

describe('registered effects — no import edge', () => {
  test('pasteAtCursor is false until a paste effect is registered', async () => {
    assert.equal(await pasteAtCursor('hi'), false)
  })

  test('pasteAtCursor calls the registered effect', async () => {
    const seen: string[] = []
    registerPaste(async (t) => { seen.push(t) })
    assert.equal(await pasteAtCursor('hi'), true)
    assert.deepEqual(seen, ['hi'])
  })

  test('settings default to ON when nothing is registered', () => {
    assert.deepEqual(getCaptureSettings(), { scratchpadEnabled: true, captureEnabled: true })
  })

  test('a THROWING settings reader falls back to ON rather than taking the session down', () => {
    registerSettings(() => { throw new Error('store gone') })
    assert.deepEqual(getCaptureSettings(), { scratchpadEnabled: true, captureEnabled: true })
  })
})

describe('persistence', () => {
  test('an ARMED pad is written, and what lands on disk deserializes back', () => {
    armScratchpad(true)
    const id = beginSegment('task', 1000, true)
    attachTranscript(id, 'held work', 1500)
    writePadNow()

    const file = join(padDirFor(root, snapshot().pad!.id), 'pad.json')
    assert.ok(existsSync(file), 'pad.json exists')
    assert.deepEqual(deserialize(readFileSync(file, 'utf8')), snapshot().pad)
  })

  test('THE FAST PATH TOUCHES NO DISK: an unarmed capture writes nothing', async () => {
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'ordinary dictation', 1500)
    endSegment(2000)
    await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 120))
    assert.equal(existsSync(padDirFor(root, snapshot().pad!.id)), false)
  })

  test('discard takes the pad directory with it', () => {
    armScratchpad(true)
    // Held work, not a blank segment: an EMPTY pad is deliberately never on
    // disk (see writePad), so there would be no directory to take.
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'held work', 1500)
    writePadNow()
    const dir = padDirFor(root, snapshot().pad!.id)
    assert.ok(existsSync(dir))
    discard()
    assert.equal(existsSync(dir), false)
  })

  test('the held state outlives the TAKE and dies at the COMMIT — the rescued files never do', () => {
    // A destination can take ~36s to answer (init.ts measured a Codex task at
    // that), and for as long as it does, pad.json is the ONLY copy of the work
    // left: `deliver` has already emptied the live slot. Removing it at the
    // take meant a crash or a quit in that window lost the pad from memory AND
    // from disk — the one thing the scratchpad promises cannot happen.
    armScratchpad(true)
    const id = beginSegment('task', 1000, true)
    attachTranscript(id, 'text', 1500)
    writePadNow()
    const dir = padDirFor(root, snapshot().pad!.id)
    const attachment = join(dir, 'insert-1.png')
    writeFileSync(attachment, 'IMG')

    takeForDelivery('newTask')
    assert.equal(snapshot().pad, null, 'the live slot really is empty')
    assert.ok(existsSync(join(dir, 'pad.json')), 'still recoverable while the destination decides')

    commitDelivery()
    assert.equal(existsSync(join(dir, 'pad.json')), false, 'the destination took it — now it is gone')
    assert.ok(existsSync(attachment), 'the delivered attachment survives')
  })

  test('a delivery that is never committed leaves the work on disk', () => {
    // The crash case, exactly: take it, then never reach commit or restage.
    armScratchpad(true)
    const id = beginSegment('task', 1000, true)
    attachTranscript(id, 'the thing I was keeping', 1500)
    writePadNow()
    const dir = padDirFor(root, snapshot().pad!.id)

    takeForDelivery('newTask')

    const raw = readFileSync(join(dir, 'pad.json'), 'utf8')
    assert.match(raw, /the thing I was keeping/, 'recoverable by the next launch')
  })

  test('a persist failure never throws — and the pad survives it intact', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'held work', 1500)

    // First prove the write is REAL, so the no-throw below cannot be satisfied
    // by writePadNow simply doing nothing.
    writePadNow()
    const good = join(padDirFor(root, snapshot().pad!.id), 'pad.json')
    assert.ok(existsSync(good), 'the happy path genuinely writes')
    const bytes = readFileSync(good, 'utf8')

    setScratchpadRoot('/dev/null/definitely-not-a-directory')
    const warn = console.warn
    console.warn = () => {} // the failure IS logged; keep it out of test output
    try {
      assert.doesNotThrow(() => writePadNow())
    } finally {
      console.warn = warn
    }

    assert.equal(snapshot().pad?.entries.length, 1, 'the in-memory pad is untouched')
    assert.equal(readFileSync(good, 'utf8'), bytes, 'the last good write is not corrupted')
  })
})

// ── Delivery ────────────────────────────────────────────────────────────

/** A pad with one spoken segment and one pasted block, held and armed. */
function heldWork(text = 'ship it'): void {
  armScratchpad(true)
  const id = beginSegment('cursor', 1000, true)
  attachTranscript(id, text, 1500)
  endSegment(2000)
}

describe('delivery formats for the cursor, and ONLY for the cursor', () => {
  test('the cursor destination runs the registered formatter', async () => {
    const seen: string[] = []
    registerFormat((t) => { seen.push(t); return `«${t}»` })
    heldWork()

    const out = takeForDelivery('cursor')!
    const ready = await formatForDelivery(out, 'cursor')
    assert.deepEqual(seen, ['ship it'], 'the formatter saw the held text')
    assert.equal(ready.text, '«ship it»')
  })

  test('a NEW TASK never reaches the formatter', async () => {
    let calls = 0
    registerFormat((t) => { calls++; return `«${t}»` })
    heldWork()

    const out = takeForDelivery('newTask')!
    const ready = await formatForDelivery(out, 'newTask')
    assert.equal(calls, 0, 'the formatter was not invoked at all')
    assert.equal(ready.text, 'ship it', 'the agent gets what was said, verbatim')
  })

  test('the OPEN TASK never reaches the formatter either', async () => {
    let calls = 0
    registerFormat((t) => { calls++; return `«${t}»` })
    heldWork()

    const out = takeForDelivery('openTask')!
    const ready = await formatForDelivery(out, 'openTask')
    assert.equal(calls, 0, 'the formatter was not invoked at all')
    assert.equal(ready.text, 'ship it')
  })

  test('no formatter registered: the cursor still gets its text', async () => {
    heldWork()
    const out = takeForDelivery('cursor')!
    assert.equal((await formatForDelivery(out, 'cursor')).text, 'ship it')
  })

  test('a THROWING formatter delivers the text as captured — held work is never lost', async () => {
    registerFormat(() => { throw new Error('groq is down') })
    heldWork()
    const out = takeForDelivery('cursor')!
    const warn = console.warn
    console.warn = () => {} // the failure IS logged; keep it out of test output
    try {
      assert.equal((await formatForDelivery(out, 'cursor')).text, 'ship it')
    } finally {
      console.warn = warn
    }
  })

  test('a formatter that returns nothing usable is ignored, not obeyed', async () => {
    registerFormat(() => '   ')
    heldWork()
    const out = takeForDelivery('cursor')!
    assert.equal((await formatForDelivery(out, 'cursor')).text, 'ship it')
  })

  test('an async formatter is awaited', async () => {
    registerFormat(async (t) => { await new Promise((r) => setTimeout(r, 1)); return t.toUpperCase() })
    heldWork()
    const out = takeForDelivery('cursor')!
    assert.equal((await formatForDelivery(out, 'cursor')).text, 'SHIP IT')
  })
})

describe('takeForDelivery renders for the target and clears', () => {
  test('the cursor keeps images out of the TEXT; both destinations deliver them', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'this one', 1500)
    recordInsert({ kind: 'image', content: '/tmp/shot.png', atMs: 1600 }, 1600)
    endSegment(2000)

    const cursor = takeForDelivery('cursor')!
    assert.equal(cursor.text, 'this one', 'no path pasted into a text field')
    assert.deepEqual(cursor.attachments, ['/tmp/shot.png'], 'the image itself still goes')

    armScratchpad(true)
    const id2 = beginSegment('task', 1000, true)
    attachTranscript(id2, 'this one', 1500)
    recordInsert({ kind: 'image', content: '/tmp/shot2.png', atMs: 1600 }, 1600)
    endSegment(2000)

    const task = takeForDelivery('newTask')!
    assert.deepEqual(task.attachments, ['/tmp/shot2.png'])
  })

  test('nothing to send returns null — and the pad is cleared anyway', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, '   ', 1500)
    endSegment(2000)

    assert.equal(takeForDelivery('cursor'), null)
    assert.equal(snapshot().pad, null, 'the user committed it; it does not linger')
    assert.equal(isArmed(), false)
  })
})

// ── Startup adoption ────────────────────────────────────────────────────

/** Write a pad straight to disk, as a previous run would have left it. */
function leaveOnDisk(p: {
  id: string; updatedAt: number; text?: string; raw?: string
}): void {
  const dir = padDirFor(root, p.id)
  mkdirSync(dir, { recursive: true })
  const body = p.raw ?? serialize({
    id: p.id,
    origin: 'cursor',
    createdAt: 1000,
    updatedAt: p.updatedAt,
    entries: [{ type: 'segment', id: `${p.id}-s`, text: p.text ?? 'friday draft', startMs: 0, endMs: 0 }],
  })
  writeFileSync(join(dir, 'pad.json'), body, 'utf8')
}

describe('a pad on disk is adopted at startup', () => {
  test('a valid pad is adopted UNARMED and SETTLED — the pill is not pinned open', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })

    const adopted = adoptPersistedPad()
    assert.equal(adopted?.id, 'pad-a')
    assert.equal(isArmed(), false, 'never armed on the user\'s behalf')
    assert.equal(snapshot().pad, null, 'not live — nothing demands attention')
    assert.equal(snapshot().held?.id, 'pad-a', 'held, waiting')
    assert.deepEqual(snapshot(), { pad: null, armed: false, held: adopted })
  })

  test('ARMING IS WHAT BRINGS IT BACK', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    assert.equal(armScratchpad(true), true)
    assert.equal(snapshot().pad?.id, 'pad-a', 'the pad the user left is live again')
    assert.equal(snapshot().held, null, 'and is no longer waiting')
    const e = snapshot().pad!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'friday draft')
  })

  test('an ORDINARY DICTATION does not destroy a settled pad', async () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    adoptPersistedPad()

    // The whole unarmed fast path: capture, transcript, stop.
    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'unrelated dictation', 6500)
    endSegment(7000)
    assert.equal(snapshot().held?.id, 'pad-a', 'still waiting')
    assert.ok(existsSync(join(padDirFor(root, 'pad-a'), 'pad.json')), 'still on disk')

    // …and the FIRST arm after that dictation is what brings it back — it must
    // not spend itself clearing the leftover unarmed pad.
    assert.equal(armScratchpad(true), true)
    assert.equal(snapshot().pad?.id, 'pad-a')
  })

  test('a CORRUPT pad is discarded silently and never blocks startup', () => {
    leaveOnDisk({ id: 'pad-bad', updatedAt: 5000, raw: '{ this is not json' })
    assert.doesNotThrow(() => adoptPersistedPad())
    assert.equal(snapshot().held, null)
    assert.equal(snapshot().pad, null)
  })

  test('a pad whose ENTRIES are half-shaped is refused too', () => {
    // deserialize validates payloads, not just tags — a segment with no text
    // would throw at render, which is the one thing the pad promises never
    // happens. Prove the refusal reaches adoption.
    leaveOnDisk({
      id: 'pad-half',
      updatedAt: 5000,
      raw: JSON.stringify({
        id: 'pad-half', origin: 'cursor', createdAt: 1, updatedAt: 5000,
        entries: [{ type: 'segment', id: 's1' }],
      }),
    })
    assert.equal(adoptPersistedPad(), null)
    assert.equal(snapshot().held, null)
  })

  test('NO pad on disk: nothing happens, nothing throws', () => {
    assert.equal(adoptPersistedPad(), null)
    assert.equal(snapshot().held, null)
  })

  test('a missing scratchpad root is not an error', () => {
    setScratchpadRoot(join(root, 'never-created'))
    assert.doesNotThrow(() => adoptPersistedPad())
    assert.equal(snapshot().held, null)
  })

  test('an EMPTY pad is not worth bringing back', () => {
    leaveOnDisk({
      id: 'pad-empty',
      updatedAt: 5000,
      raw: JSON.stringify({ id: 'pad-empty', origin: 'cursor', createdAt: 1, updatedAt: 5000, entries: [] }),
    })
    assert.equal(adoptPersistedPad(), null)
  })

  test('the NEWEST pad wins when more than one run died holding work', () => {
    leaveOnDisk({ id: 'pad-old', updatedAt: 1000, text: 'older' })
    leaveOnDisk({ id: 'pad-new', updatedAt: 9000, text: 'newer' })
    leaveOnDisk({ id: 'pad-bad', updatedAt: 99000, raw: 'nonsense' })

    assert.equal(adoptPersistedPad()?.id, 'pad-new', 'a corrupt file cannot win by being newest')
  })

  test('adoption never clobbers a live pad', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'live work', 1500)

    assert.equal(adoptPersistedPad(), null)
    const e = snapshot().pad!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'live work')
  })

  test('discard throws away the settled pad AND its files', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    adoptPersistedPad()

    discard()
    assert.equal(snapshot().held, null)
    assert.equal(existsSync(padDirFor(root, 'pad-a')), false, 'it cannot come back at the next arm')
  })

  test('a refused arm (feature off) leaves the settled pad exactly where it was', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    adoptPersistedPad()
    registerSettings(() => ({ scratchpadEnabled: false, captureEnabled: true }))

    assert.equal(armScratchpad(true), false)
    assert.equal(snapshot().held?.id, 'pad-a', 'not promoted into a pad nothing will hold')
    assert.equal(snapshot().pad, null)
  })
})

// ── Delivery must not lose held work ────────────────────────────────────
//
// The pad is rendered, cleared, and its pad.json deleted BEFORE the
// destination is reached. From that instant the user's work exists only as a
// local variable, and held work is held precisely because the user chose not
// to risk it. So every path where the destination does not take it has to put
// the pad back.

describe('a destination that fails does not take the pad with it', () => {
  test('the CURSOR throwing leaves the pad live, armed, and intact', async () => {
    heldWork('the paragraph I spent ten minutes on')

    const r = await runDelivery('cursor', async () => { throw new Error('pasteboard is locked') })

    assert.equal(r.landed, null)
    assert.equal(r.restaged?.id, snapshot().pad?.id, 'it went back into the live slot')
    assert.equal((r.error as Error).message, 'pasteboard is locked')
    assert.equal(isArmed(), true, 'still held — the next capture appends, it does not replace')
    const e = snapshot().pad!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'the paragraph I spent ten minutes on')
  })

  test('a TASK destination throwing leaves the pad live, armed, and intact', async () => {
    // The real case: dispatchFromCapture's no-open-tasks branch has no failsafe,
    // so a network blip on the router propagates straight out of it.
    heldWork('refactor the arbiter and add the missing test')

    const r = await runDelivery('newTask', async () => { throw new Error('fetch failed') })

    assert.equal(r.landed, null)
    assert.equal(r.restaged?.id, snapshot().pad?.id)
    assert.equal(isArmed(), true)
    const e = snapshot().pad!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'refactor the arbiter and add the missing test')
  })

  test('the OPEN TASK destination throwing puts it back too', async () => {
    heldWork('and one more thing')
    const r = await runDelivery('openTask', async () => { throw new Error('pty is gone') })
    assert.equal(r.landed, null)
    assert.equal(snapshot().pad?.entries.length, 1)
  })

  test('a destination that DECLINES (returns null) puts it back — no throw needed', async () => {
    // pasteAtCursor returns false when no paste effect is registered, and
    // dispatchFromCapture returns null when nothing routed. Neither throws, and
    // both mean the text reached nothing.
    heldWork('nothing took this')

    const r = await runDelivery('newTask', async () => null)

    assert.equal(r.landed, null)
    assert.equal(r.restaged?.entries.length, 1)
    assert.equal(snapshot().pad?.entries.length, 1)
    assert.equal(r.error, undefined, 'declining is not an error, it is an answer')
  })

  test('THE RESTORED PAD IS BACK ON DISK — a crash after a failed delivery loses nothing', async () => {
    heldWork('durable again')
    writePadNow()
    const padId = snapshot().pad!.id
    const file = join(padDirFor(root, padId), 'pad.json')
    assert.ok(existsSync(file))

    // deliver() removes pad.json on the assumption the destination took it…
    const r = await runDelivery('newTask', async () => { throw new Error('boom') })

    // …and the restage has to undo that, not just fix memory.
    assert.ok(existsSync(file), 'pad.json is back')
    assert.equal(r.restaged?.id, padId)
    const onDisk = deserialize(readFileSync(file, 'utf8'))
    assert.deepEqual(onDisk, snapshot().pad, 'and it matches what is held')
  })

  test('a SUCCESSFUL delivery really does clear it — the safety net is not a leak', async () => {
    heldWork('ship it')
    const r = await runDelivery('cursor', async () => 'cursor')

    assert.equal(r.landed, 'cursor')
    assert.equal(r.restaged, null)
    assert.equal(snapshot().pad, null, 'delivered work does not linger')
    assert.equal(isArmed(), false)
    assert.equal(snapshot().held, null, 'and it is not quietly settled either')
  })

  test('a delivered pad cannot be resurrected by a LATER failure', async () => {
    heldWork('first')
    await runDelivery('cursor', async () => 'cursor')
    // Nothing in flight any more; a second delivery of an empty pad must not
    // restage the pad the first one legitimately consumed.
    const r = await runDelivery('cursor', async () => { throw new Error('boom') })
    assert.equal(r.restaged, null)
    assert.equal(snapshot().pad, null)
  })

  test('the destination is not even called when there is nothing to send', async () => {
    let calls = 0
    const r = await runDelivery('cursor', async () => { calls++; return 'cursor' })
    assert.equal(calls, 0)
    assert.deepEqual({ landed: r.landed, restaged: r.restaged }, { landed: null, restaged: null })
  })

  test('if a NEW CAPTURE claimed the live slot, the failed pad settles instead of colliding', async () => {
    heldWork('the work I tried to send')
    const padId = snapshot().pad!.id

    const r = await runDelivery('newTask', async () => {
      // The user starts talking again while the router is hanging.
      beginSegment('cursor', 9000, true)
      throw new Error('router died')
    })

    assert.equal(r.restaged?.id, padId)
    assert.notEqual(snapshot().pad?.id, padId, 'the new capture keeps the live slot')
    assert.equal(snapshot().held?.id, padId, 'and the failed delivery is one arm away')
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')), 'on disk either way')
  })

  test('two pads wanting the settled slot: NEITHER is deleted', async () => {
    // A pad from a previous run is still waiting when a delivery fails and a
    // fresh capture is holding the live slot.
    leaveOnDisk({ id: 'pad-old', updatedAt: 100, text: 'from last week' })
    adoptPersistedPad()
    heldWork('todays work')
    const padId = snapshot().pad!.id

    const warn = console.warn
    console.warn = () => {} // the second pad's location IS logged; keep it quiet here
    let r
    try {
      r = await runDelivery('newTask', async () => { beginSegment('cursor', 9000, true); throw new Error('nope') })
    } finally {
      console.warn = warn
    }

    assert.equal(r!.restaged?.id, padId)
    assert.equal(snapshot().held?.id, padId, 'the more recently touched pad is the one arming brings back')
    assert.ok(existsSync(join(padDirFor(root, 'pad-old'), 'pad.json')), 'the older one is still recoverable on disk')
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')))
  })

  test('the surface is told twice: once when the pad is taken, once when it comes back', async () => {
    heldWork('watch the pad')
    const seen: (string | null)[] = []
    await runDelivery('newTask', async () => { throw new Error('boom') }, () => {
      seen.push(snapshot().pad?.id ?? null)
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[0], null, 'cleared the instant the user committed it')
    assert.ok(seen[1], 'and back again when nothing took it')
  })

  test('formatting still runs once, and still only for the cursor, through runDelivery', async () => {
    let calls = 0
    registerFormat((t) => { calls++; return t.toUpperCase() })

    heldWork('to the cursor')
    let sent = ''
    await runDelivery('cursor', async (t) => { sent = t; return 'cursor' })
    assert.equal(sent, 'TO THE CURSOR')
    assert.equal(calls, 1)

    heldWork('to a task')
    await runDelivery('newTask', async (t) => { sent = t; return 'task-1' })
    assert.equal(sent, 'to a task')
    assert.equal(calls, 1, 'the task never reached the formatter')
  })
})

// ── One delivery at a time ──────────────────────────────────────────────
//
// `inFlight` is a single slot. A second delivery arriving before the first
// resolves finds the pad already taken, and — before the guard — its
// "nothing to send" branch cleared the slot out from under the first one,
// leaving the first pad in no slot at all and already off disk. A double-click
// on a Send button is the most ordinary thing a user does.

describe('a second delivery cannot clobber one already in flight', () => {
  test('THE FIRST PAD SURVIVES a second click and is still recoverable when it fails', async () => {
    heldWork('the work in flight')
    const padId = snapshot().pad!.id

    let release: () => void = () => {}
    const destinationIsSlow = new Promise<void>((r) => { release = r })

    const first = runDelivery('newTask', async () => {
      await destinationIsSlow
      throw new Error('router died') // …and then it fails
    })

    // The user clicks Send again while the first is still going.
    const second = await runDelivery('newTask', async () => 'task-2')
    assert.equal(second.landed, null)
    assert.equal(second.busy, true, 'reported as ignored, not as an empty pad')
    assert.equal(second.restaged, null)

    release()
    const r = await first
    assert.equal(r.restaged?.id, padId, 'the first delivery could still put its pad back')
    assert.equal(snapshot().pad?.id, padId, 'and it is live again, not lost')
    assert.equal(isArmed(), true)
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')), 'and back on disk')
  })

  test('the second call runs no destination and mutates nothing', async () => {
    heldWork('one delivery only')
    let sends = 0
    let release: () => void = () => {}
    const destinationIsSlow = new Promise<void>((r) => { release = r })

    const first = runDelivery('cursor', async () => { sends++; await destinationIsSlow; return 'cursor' })

    const before = snapshot()
    const second = await runDelivery('cursor', async () => { sends++; return 'cursor' }, () => {
      assert.fail('the ignored call must not announce anything to the surface')
    })

    assert.equal(sends, 1, 'the second call never reached a destination')
    assert.equal(second.busy, true)
    assert.deepEqual(snapshot(), before, 'and it moved no state at all')

    release()
    const r = await first
    assert.equal(r.landed, 'cursor', 'the first delivery finishes normally')
    assert.equal(snapshot().pad, null)
  })

  test('once the first finishes, a later delivery is accepted again', async () => {
    heldWork('first')
    assert.equal((await runDelivery('cursor', async () => 'cursor')).landed, 'cursor')

    heldWork('second')
    const r = await runDelivery('cursor', async () => 'cursor')
    assert.equal(r.landed, 'cursor', 'the guard is not sticky')
    assert.equal(r.busy, undefined)
  })

  test('a FAILED delivery also releases the guard — the pad can be retried', async () => {
    heldWork('retry me')
    const failed = await runDelivery('newTask', async () => { throw new Error('blip') })
    assert.ok(failed.restaged, 'it came back')

    const retry = await runDelivery('newTask', async () => 'task-9')
    assert.equal(retry.landed, 'task-9', 'the retry is not refused as busy')
    assert.equal(snapshot().pad, null)
  })
})

describe('nothing can wedge the delivery slot', () => {
  test('a THROWING surface notification does not strand the pad or block the next delivery', async () => {
    heldWork('do not wedge me')
    const warn = console.warn
    console.warn = () => {} // the broadcast failure IS logged; keep it out of test output
    let r
    try {
      r = await runDelivery('newTask', async () => { throw new Error('blip') }, () => {
        throw new Error('every window is gone')
      })
    } finally {
      console.warn = warn
    }

    assert.ok(r!.restaged, 'the pad still came back')
    assert.equal(deliveryInFlight(), false, 'and the slot was released')

    // The proof that matters: a later delivery is not refused as busy.
    const retry = await runDelivery('newTask', async () => 'task-7')
    assert.equal(retry.landed, 'task-7')
    assert.equal(retry.busy, undefined)
  })

  test('the slot is free before and after an ordinary delivery', async () => {
    assert.equal(deliveryInFlight(), false)
    heldWork('in and out')
    await runDelivery('cursor', async () => 'cursor')
    assert.equal(deliveryInFlight(), false)
  })
})

// ── which pad a surface may show ────────────────────────────────────────
//
// THE RULE THE PANEL IS DRAWN FROM. `beginSegment` opens a live pad for EVERY
// dictation, armed or not — inserts have to be positioned against speech either
// way — so "there is a pad with content in it" is NOT the same question as
// "the user is holding work". Getting these two confused put a panel on screen
// during an ordinary dictation, offering to send an utterance that was about to
// be pasted automatically, with a Discard that reached into the live capture.

describe('a surface may only ever show work the user chose to hold', () => {
  test('UNARMED capture with content → nothing to show', () => {
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'just dictating into slack', 1500)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 1200 }, 1200)

    assert.ok(snapshot().pad, 'the live pad exists — it always does')
    assert.ok(snapshot().pad!.entries.length >= 2, 'and it has content')
    assert.equal(heldForSurface(), null, 'but NONE of it is the user\'s held work')
  })

  test('ARMED capture with content → the live pad is shown', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'this one I am keeping', 1500)

    assert.equal(heldForSurface()?.id, snapshot().pad!.id)
  })

  test('arming MID-capture promotes what is being said right now', () => {
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'wait, keep this', 1200)
    assert.equal(heldForSurface(), null)

    armScratchpad(true)
    assert.equal(heldForSurface()?.id, snapshot().pad!.id, 'the gesture keeps the live pad')
  })

  test('a SETTLED pad is shown when nothing is live', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    assert.equal(snapshot().pad, null)
    // `now` is explicit because the settle rule reads it — these pads live in
    // the test's own clock domain, and against the wall clock every one of them
    // is decades idle.
    assert.equal(heldForSurface(snapshot(), 5500)?.id, 'pad-a')
  })

  test('a settled pad stays shown THROUGH an ordinary dictation, and the live one never is', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'unrelated dictation', 6500)
    assert.equal(heldForSurface(snapshot(), 6600)?.id, 'pad-a', 'still the held pad, never the live one')
    endSegment(7000)
    assert.equal(heldForSurface(snapshot(), 7100)?.id, 'pad-a')
  })

  test('disarming stops showing the live pad without destroying it mid-capture', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'never mind', 1200)
    assert.equal(heldForSurface()?.id, snapshot().pad!.id)

    armScratchpad(false)
    assert.equal(heldForSurface(), null, 'no longer held work')
    assert.ok(snapshot().pad, 'but the capture is untouched — it still delivers normally')
  })
})

describe('discard cannot reach an utterance the user is still speaking', () => {
  test('an UNARMED capture in progress survives a discard', () => {
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'half a sentence so far', 1200)
    const before = snapshot().pad!.id

    discard()

    assert.equal(snapshot().pad?.id, before, 'the live pad is still there')
    // The real damage was downstream of a null pad: everything after went
    // nowhere, silently.
    attachTranscript(id, 'half a sentence so far, and the rest of it', 1800)
    const seg = snapshot().pad!.entries.find((e) => e.type === 'segment')
    assert.equal(seg?.type === 'segment' && seg.text, 'half a sentence so far, and the rest of it',
      'the words still land')
    assert.equal(recordInsert({ kind: 'url', content: 'https://x.test', atMs: 1900 }, 1900), true,
      'and copies are still recorded')
  })

  test('an ARMED pad IS discarded, open segment or not — that is the gesture', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    discard()
    assert.equal(snapshot().pad, null)
    assert.equal(isArmed(), false)
  })

  test('a settled pad is discarded while an ordinary dictation runs, and the dictation lives', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()
    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'unrelated dictation', 6500)

    discard()   // the user means the pad on screen — the settled one

    assert.equal(snapshot().held, null, 'the held pad is gone')
    assert.ok(!existsSync(join(padDirFor(root, 'pad-a'), 'pad.json')), 'and off disk')
    const seg = snapshot().pad?.entries.find((e) => e.type === 'segment')
    assert.equal(seg?.type === 'segment' && seg.text, 'unrelated dictation',
      'the dictation is untouched')
  })

  test('between captures, a leftover unarmed pad is still discarded', () => {
    // No open segment ⇒ nothing is being spoken into, so the old behaviour
    // stands: there is nothing to protect.
    beginSegment('cursor', 1000, true)
    endSegment(2000)
    assert.ok(snapshot().pad)
    discard()
    assert.equal(snapshot().pad, null)
  })
})

describe('a destination button that is shown must work', () => {
  test('a SETTLED pad delivers — it is promoted into the live slot first', async () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()
    assert.equal(snapshot().pad, null, 'the seam only ever reads the live slot')

    assert.equal(promoteSettledPad(), true)
    assert.equal(snapshot().pad?.id, 'pad-a')
    assert.equal(snapshot().held, null)

    let sent = ''
    const r = await runDelivery('cursor', async (t) => { sent = t; return 'cursor' })
    assert.equal(r.landed, 'cursor', 'it actually landed')
    assert.match(sent, /friday draft/)
    assert.equal(heldForSurface(), null, 'and nothing is held any more')
  })

  test('WITHOUT the promotion the same delivery is a silent no-op', async () => {
    // This is the shape of the bug: every button inert, no feedback, panel
    // unchanged — and `landed: null` is indistinguishable from an empty pad.
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    let sends = 0
    const r = await runDelivery('cursor', async () => { sends++; return 'cursor' })
    assert.equal(r.landed, null)
    assert.equal(sends, 0, 'the destination was never even called')
    assert.equal(snapshot().held?.id, 'pad-a', 'the pad is exactly where it was')
  })

  test('promotion REFUSES while a capture owns the live slot', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()
    beginSegment('cursor', 6000, true)

    assert.equal(promoteSettledPad(), false, 'callers must refuse, not deliver the wrong pad')
    assert.equal(snapshot().held?.id, 'pad-a', 'the held pad is untouched')
    assert.ok(snapshot().pad, 'and so is the capture')
  })

  test('promotion is not behind the feature gate — held work stays deliverable when it is off', () => {
    registerSettings(() => ({ scratchpadEnabled: false, captureEnabled: true }))
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    assert.equal(armScratchpad(true), false, 'arming is refused, as it should be')
    assert.equal(snapshot().held?.id, 'pad-a', 'and the work is still stranded where it was')
    assert.equal(promoteSettledPad(), true, 'but it can still be got out')
    assert.equal(snapshot().pad?.id, 'pad-a')
  })
})

describe('the pad announces itself when the capture lifecycle moves it', () => {
  test('an armed stop and the transcript that follows both announce', () => {
    let announces = 0
    registerPadObserver(() => { announces++ })
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)

    endSegment(2000)
    assert.ok(announces >= 1, 'the stop that settles the pad is the moment the panel appears')

    const afterStop = announces
    attachTranscript(id, 'the words, 30 seconds later', 32000)
    assert.ok(announces > afterStop, 'and the words must reach the panel when they land')
  })

  test('cancelling an open segment announces too', () => {
    let announces = 0
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    registerPadObserver(() => { announces++ })
    cancelOpenSegment(1500)
    assert.equal(announces, 1)
  })

  test('an observer that throws cannot break a capture', () => {
    registerPadObserver(() => { throw new Error('surface is gone') })
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    assert.doesNotThrow(() => endSegment(2000))
  })
})

// ── disarming settles; it does not abandon ──────────────────────────────
//
// IN-SESSION HELD WORK DOES NOT LIVE IN `heldPad`. After an armed stop it sits
// in the LIVE slot with `armed = true` — heldPad is written only by
// adoptPersistedPad and by a restage into an occupied slot. So a disarm that
// only cleared the flag left the pad live-but-unarmed: heldForSurface stopped
// returning it, the panel emptied, and beginSegment or the next arm then
// destroyed the files. Silent loss of work the user explicitly chose to keep.

describe('turning the scratchpad off cannot lose what is already held', () => {
  /** arm → capture → stop. The work is now held in the LIVE slot. */
  function holdSomeWork(text = 'the thing I am keeping'): string {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, text, 1500)
    endSegment(2000)
    return snapshot().pad!.id
  }

  test('the icon: disarming keeps the work reachable', () => {
    const padId = holdSomeWork()
    assert.equal(heldForSurface()?.id, padId)

    armScratchpad(false)

    assert.equal(isArmed(), false)
    assert.equal(heldForSurface(snapshot(), 2500)?.id, padId, 'still on screen, not abandoned')
    assert.equal(snapshot().held?.id, padId, 'settled, where arming brings it back from')
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')), 'and durable')
  })

  test('the setting: the same path, because both go through armScratchpad', () => {
    // Disabling the feature calls armScratchpad(false) exactly like the icon.
    const padId = holdSomeWork()
    registerSettings(() => ({ scratchpadEnabled: false, captureEnabled: true }))

    armScratchpad(false)

    assert.equal(heldForSurface(snapshot(), 2500)?.id, padId, 'the work outlives the feature being switched off')
    assert.equal(snapshot().held?.id, padId)
  })

  test('and it is still DELIVERABLE after being switched off', async () => {
    holdSomeWork('friday notes')
    registerSettings(() => ({ scratchpadEnabled: false, captureEnabled: true }))
    armScratchpad(false)

    assert.equal(armScratchpad(true), false, 'arming stays refused — the gate still works')
    assert.equal(promoteSettledPad(), true, 'but the work can still be got out')

    let sent = ''
    const r = await runDelivery('cursor', async (t) => { sent = t; return 'cursor' })
    assert.equal(r.landed, 'cursor')
    assert.match(sent, /friday notes/)
    assert.equal(heldForSurface(), null, 'and it is gone once it lands')
  })

  test('the next dictation does not destroy it', () => {
    // This was the destruction step: beginSegment drops an unarmed live pad.
    const padId = holdSomeWork()
    armScratchpad(false)

    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'something unrelated', 6500)
    endSegment(7000)

    assert.equal(snapshot().held?.id, padId, 'survived the next capture')
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')))
  })

  test('re-arming brings the very same pad back', () => {
    const padId = holdSomeWork('half a thought')
    armScratchpad(false)
    assert.equal(armScratchpad(true), true)
    assert.equal(snapshot().pad?.id, padId, 'the same pad, not a fresh one')
    const seg = snapshot().pad!.entries.find((e) => e.type === 'segment')
    assert.equal(seg?.type === 'segment' && seg.text, 'half a thought')
  })

  test('an EMPTY armed pad is not settled — there is nothing to keep', () => {
    armScratchpad(true)
    armScratchpad(false)
    assert.equal(snapshot().held, null, 'settling nothing would resurrect an empty pad at the next arm')
  })

  test('disarming MID-capture still leaves the pad live, to be delivered normally', () => {
    // Unchanged, and load-bearing: settling a pad the recorder is writing into
    // would null the live slot under it and everything after would go nowhere.
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'never mind, just paste it', 1200)

    armScratchpad(false)

    assert.ok(snapshot().pad, 'still live')
    assert.equal(snapshot().held, null, 'not settled out from under the capture')
    attachTranscript(id, 'never mind, just paste it — and the rest', 1800)
    const seg = snapshot().pad!.entries.find((e) => e.type === 'segment')
    assert.equal(seg?.type === 'segment' && seg.text, 'never mind, just paste it — and the rest',
      'the capture keeps working')
  })

  test('a settled disarm does not evict a pad from a previous run — both stay on disk', () => {
    leaveOnDisk({ id: 'pad-old', updatedAt: 1, text: 'last week' })
    adoptPersistedPad()
    // Arm DURING a capture, so the settled pad is not promoted and both exist.
    beginSegment('cursor', 1000, true)
    armScratchpad(true)
    attachTranscript(snapshot().pad!.entries[0].id, 'this week', 1500)
    endSegment(2000)
    const fresh = snapshot().pad!.id

    armScratchpad(false)

    assert.equal(snapshot().held?.id, fresh, 'the more recently touched one wins the slot')
    assert.ok(existsSync(join(padDirFor(root, 'pad-old'), 'pad.json')), 'the older one is NOT deleted')
  })
})

// ── Universal capture reaches the UNARMED delivery, and does not move it ────
//
// A copy made during an ordinary dictation was recorded faithfully and then
// thrown away: render() had one caller chain and none of it was reachable from
// an unarmed stop. The URL appeared nowhere, and the copy had already cost a
// chunk boundary. §2/§4/§9a all say the opposite, and origin/main did stage a
// screenshot and paste it after the text, so it was a regression as well.

describe('an unarmed stop delivers what was captured, not the speech alone', () => {
  /** The delivery seam in one line: sessionManager composes, and sends whatever
   *  comes back — the composed text, or the string it already had. */
  const delivered = (segId: string | null, text: string, dest: 'cursor' | 'task' = 'cursor') =>
    composeWithInserts(segId, text, dest) ?? text

  test('a URL copied mid-dictation lands in the pasted text', () => {
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://slack.com/archives/C04', atMs: 4000 }, 4000)
    endSegment(9000)

    assert.equal(
      delivered(id, 'go through the thread from this morning'),
      'go through the thread from this morning https://slack.com/archives/C04',
    )
  })

  test('a block is fenced, and the fence outgrows the backticks inside it', () => {
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'block', content: 'a ``` b', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(delivered(id, 'look at this'), 'look at this\n\n````\na ``` b\n````')
  })

  test('an image is skipped at the cursor and referenced for a task', () => {
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'image', content: '/tmp/Screenshot 14.22.png', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(delivered(id, 'fix this'), 'fix this', 'a text field cannot hold an image')
    assert.equal(delivered(id, 'fix this', 'task'), 'fix this', 'the real image travels through the attachment channel, never as a leaked path')
  })

  test('it does not run while ARMED — that stop holds, it does not deliver', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)

    assert.equal(composeWithInserts(id, 'held', 'cursor'), null)
  })

  test('it MUTATES NOTHING — the unarmed pad is untouched scaffolding', () => {
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)
    const before = JSON.stringify(snapshot().pad)

    composeWithInserts(id, 'some words', 'cursor')

    assert.equal(JSON.stringify(snapshot().pad), before, 'no segment text, no persist, no announce')
  })

  // ── A capture with NO USABLE SPEECH delivers nothing ──────────────────
  //
  // Composing is a REFINEMENT of speech that is already being delivered: an
  // insert lands "at the point it happened", and with nothing said there is no
  // point. The regression these cover is real and was live: the sequential
  // dictation flow's quiet-miss sets `output = ''` and FALLS THROUGH to its
  // delivery site, so the composer was reached with an empty transcript and a
  // pad holding a URL — it rendered the insert alone and `if (output)` pasted
  // the bare URL. Before universal capture, a quiet miss pasted nothing.

  test('a QUIET MISS with an insert on the pad pastes NOTHING, not the bare URL', () => {
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(composeWithInserts(id, '', 'cursor'), null, 'no speech ⇒ nothing to compose')
    assert.equal(delivered(id, ''), '', 'so the delivery site has nothing to inject')
  })

  test('the same for a TASK — a quiet miss dispatches nothing', () => {
    // dispatchRemoteAndFinish composes too, and its `if (cmd)` guard would have
    // sent a task whose entire content was a link the user had merely copied.
    const id = beginSegment('task', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(composeWithInserts(id, '', 'task'), null)
    assert.equal(delivered(id, '', 'task'), '')
  })

  test('whitespace-only speech is no speech', () => {
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(composeWithInserts(id, '   \n  ', 'cursor'), null)
  })

  test('a blank transcript is no speech either — not the insert alone', () => {
    // '[BLANK_AUDIO]' is normalised to nothing (the same rule holdIfArmed
    // applies when holding), and nothing said is nothing delivered.
    const id = beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(composeWithInserts(id, '[BLANK_AUDIO]', 'cursor'), null)
    assert.equal(delivered(id, '[BLANK_AUDIO]'), '[BLANK_AUDIO]', 'left for the caller to discard, as it does')
  })

  test('an unknown segment id still delivers the speech — a cancelled+undone capture', () => {
    beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 2000 }, 2000)
    endSegment(3000)

    assert.equal(delivered('a-segment-that-is-gone', 'the words'), 'the words https://example.com')
  })
})

describe('THE FAST PATH DOES NOT MOVE — byte-identical when nothing was copied', () => {
  // The hard constraint, and it outranks the feature. It is answered
  // STRUCTURALLY rather than argued: with no insert on the pad,
  // composeWithInserts returns null before it reaches the renderer, so the
  // caller delivers the very string it was already holding — the same
  // reference, not an equal one. Every byte, including the ones a renderer
  // would quietly eat.
  const NASTY = [
    'plain words',
    'trailing newline\n',
    'trailing spaces   ',
    ' leading space',
    'two\n\nparagraphs',
    'a line\nthen another\n',
    '  ',
    '',
    'unicode — em dash, curly ’quotes’, emoji 🎙',
    '```\nnot actually a fence, just spoken\n```',
  ]

  test('with nothing copied, the delivered string is the SAME string, byte for byte', () => {
    for (const text of NASTY) {
      _resetForTest()
      setScratchpadRoot(root)
      wire()
      const id = beginSegment('cursor', 1000, true)
      endSegment(5000)

      const out = composeWithInserts(id, text, 'cursor')
      assert.equal(out, null, `no insert ⇒ no composition (${JSON.stringify(text)})`)
      // What sessionManager actually delivers.
      const deliveredText = out ?? text
      assert.strictEqual(deliveredText, text, `byte-identical (${JSON.stringify(text)})`)
      assert.equal(deliveredText.length, text.length, 'and the same length')
    }
  })

  test('this is why it returns null: rendering the same pad would NOT be byte-identical', () => {
    // The divergence the null return exists to avoid, demonstrated rather than
    // asserted — a pad holding one segment renders through a trim().
    const id = beginSegment('cursor', 1000, true)
    endSegment(5000)
    const pad = snapshot().pad!
    const segment = pad.entries.find((e) => e.type === 'segment')!
    const rendered = render(
      { ...pad, entries: [{ ...segment, type: 'segment', text: 'trailing newline\n' }] },
      'cursor',
    ).text
    assert.notStrictEqual(rendered, 'trailing newline\n', 'render() trims — so it must not be on this path')
    assert.strictEqual(rendered, 'trailing newline')
  })

  test('no pad at all — before any capture — is also a pass-through', () => {
    assert.equal(composeWithInserts(null, 'anything', 'cursor'), null)
  })

  test('a REFUSED insert (our own pasteboard sequence) leaves the fast path alone', () => {
    const id = beginSegment('cursor', 1000, true)
    beginOwnClipboardSequence()
    // captureSelectedText's own ⌘C — recorded by nobody, so nothing to compose.
    assert.equal(recordInsert({ kind: 'line', content: 'the user selection', atMs: 1100 }, 1100), false)
    endOwnClipboardSequence(1200)
    endSegment(5000)

    assert.equal(composeWithInserts(id, 'ordinary dictation', 'cursor'), null)
  })
})

describe('settle, do not nag — a pad stops asking for attention (§9)', () => {
  test('a pad idle past the threshold is not shown, but is still on disk and still held', () => {
    leaveOnDisk({ id: 'pad-friday', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    assert.equal(heldForSurface(snapshot(), 5000 + SETTLE_IDLE_MS - 1)?.id, 'pad-friday', 'inside the window it shows')
    assert.equal(heldForSurface(snapshot(), 5000 + SETTLE_IDLE_MS + 1), null, 'past it, it stops asking')
    assert.equal(snapshot().held?.id, 'pad-friday', 'still held — nothing was dropped')
    assert.ok(existsSync(join(padDirFor(root, 'pad-friday'), 'pad.json')), 'and still on disk')
  })

  test('arming brings a settled pad back however long it has been waiting', () => {
    leaveOnDisk({ id: 'pad-friday', updatedAt: 1, text: 'friday draft' })
    adoptPersistedPad()
    assert.equal(heldForSurface(snapshot(), Date.now()), null, 'not on screen')

    assert.equal(armScratchpad(true), true)

    assert.equal(snapshot().pad?.id, 'pad-friday', 'back in the live slot')
    assert.equal(heldForSurface(snapshot(), Date.now())?.id, 'pad-friday', 'and on screen again')
  })

  test('a LIVE armed pad never settles, whatever its timestamps say', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'this is the capture I am in the middle of', 1500)
    endSegment(2000)

    assert.equal(heldForSurface(snapshot(), 2000 + SETTLE_IDLE_MS * 10)?.id, snapshot().pad!.id)
  })
})

describe('an armed tap that said nothing holds nothing', () => {
  test('a pad of one blank segment is empty — nothing to show, nothing to deliver', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    endSegment(2000)

    assert.equal(snapshot().pad!.entries.length, 1, 'the segment IS there — it positions inserts')
    assert.equal(heldForSurface(snapshot(), 2500), null, 'but no panel pins itself open on it')
    assert.equal(deliver('cursor'), null, 'and no destination button delivers an empty render')
  })

  test('it is not settled by a disarm either — an empty pad must not come back at the next arm', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    endSegment(2000)

    armScratchpad(false)

    assert.equal(snapshot().held, null)
  })

  test('but a copy alone IS content, even with nothing said', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    recordInsert({ kind: 'url', content: 'https://example.com', atMs: 1500 }, 1500)
    endSegment(2000)

    assert.ok(heldForSurface(snapshot(), 2500), 'the user captured it deliberately')
    assert.equal(deliver('cursor')?.text, 'https://example.com')
  })
})

describe('a capture in progress is not deliverable', () => {
  test('segmentOpen is exactly the recording window', () => {
    assert.equal(segmentOpen(), false)
    beginSegment('cursor', 1000, true)
    assert.equal(segmentOpen(), true, 'the delivery seam refuses on this')
    endSegment(2000)
    assert.equal(segmentOpen(), false)
  })

  test('and it stays true for an ARMED capture — the case the pad-identity guard missed', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    attachTranscript(snapshot().pad!.entries[0].id, 'still talking', 1200)

    // heldForSurface returns the LIVE pad here, so a guard comparing the two
    // sees no difference and lets the delivery through.
    assert.equal(heldForSurface(snapshot(), 1300), snapshot().pad)
    assert.equal(segmentOpen(), true, 'which is why the seam asks this instead')
  })
})

// ── May a delivery run at all ───────────────────────────────────────────
//
// The rule lived in init.ts's deliverScratchpad, which has no test file, and it
// had a hole: both guards were written as `showing && …`, and `showing` is null
// for a pad that has settled past the idle threshold. So delivery fell through
// both of them and ran against whatever was in the LIVE slot.

describe('a delivery may only ever move the pad the user was looking at', () => {
  const past = 5000 + SETTLE_IDLE_MS + 1

  test('nothing held and nothing live: nothing to send', () => {
    assert.equal(gateDelivery(5000), 'nothing-showing')
  })

  test('THE HOLE: past the settle threshold, delivery ran against a LEFTOVER pad', () => {
    // A settled pad from a previous run, plus the buffer of a finished unarmed
    // dictation still sitting in the live slot waiting for the next capture
    // boundary to drop it.
    leaveOnDisk({ id: 'pad-old', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()
    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'someone else\'s dictation', 6500)
    endSegment(7000)

    const before = snapshot()
    const showing = heldForSurface(before, past)
    assert.equal(showing, null, 'the panel shows nothing — the pad has settled')

    // The pre-fix guard, verbatim. `showing` is null, so BOTH `showing && …`
    // tests short-circuit to false and delivery proceeded.
    const preFixWouldRefuse = !!(showing && showing !== before.pad && !promoteSettledPad())
    assert.equal(preFixWouldRefuse, false, 'the old guard did not fire')
    assert.equal(
      before.pad?.entries.some((e) => e.type === 'segment' && e.text === 'someone else\'s dictation'),
      true,
      'and THIS is what it would have sent',
    )

    assert.equal(gateDelivery(past), 'nothing-showing', 'the gate refuses')
    assert.equal(snapshot().pad, before.pad, 'and moves nothing — the leftover is untouched')
    assert.equal(snapshot().held?.id, 'pad-old', 'the settled pad is still waiting')
  })

  test('a capture in progress refuses, whatever is on screen', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'still speaking', 1500)
    assert.equal(gateDelivery(2000), 'capture-in-progress')
  })

  test('a live ARMED pad is deliverable', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'held work', 1500)
    endSegment(2000)
    assert.equal(gateDelivery(2500), 'ok')
  })

  test('a settled pad INSIDE the window is promoted so its buttons work', () => {
    leaveOnDisk({ id: 'pad-old', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()
    assert.equal(gateDelivery(5001), 'ok')
    assert.equal(snapshot().pad?.id, 'pad-old', 'promoted into the live slot')
    assert.equal(snapshot().held, null)
  })

  test('a settled pad the live slot will not make room for is refused, not swapped', () => {
    leaveOnDisk({ id: 'pad-old', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()
    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'someone else\'s dictation', 6500)
    endSegment(7000)

    assert.equal(gateDelivery(5001), 'live-slot-taken')
    assert.equal(snapshot().held?.id, 'pad-old', 'untouched, and still on disk')
  })

  test('a held pad with nothing IN it is nothing to send', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    endSegment(2000)   // an armed tap that said nothing
    assert.equal(gateDelivery(2500), 'nothing-showing')
  })
})

// ── Two nits with real edges ────────────────────────────────────────────

describe('a restage counts as touching the pad', () => {
  test('a pad the user JUST tried to send does not settle out from under them', () => {
    // updatedAt is what the settle rule measures idleness against. Restaging
    // into an occupied slot used to leave it alone, so a pad that had been idle
    // past the threshold became invisible at the exact moment the user pressed
    // Send on it — the one moment they are demonstrably engaged with it.
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'friday draft', 1500)
    endSegment(2000)
    const stale = snapshot().pad!.updatedAt
    assert.ok(stale <= 2000)

    takeForDelivery('newTask')
    // A new capture claims the live slot before the destination answers, so
    // the restage has to settle rather than go live.
    beginSegment('cursor', 3000, true)
    endSegment(3500)

    const back = restageDelivery(2000 + SETTLE_IDLE_MS)!
    assert.equal(back.updatedAt, 2000 + SETTLE_IDLE_MS, 'stamped at the attempt')
    assert.equal(snapshot().held?.id, back.id, 'and it settled, as expected')
    assert.ok(
      heldForSurface(snapshot(), 2000 + SETTLE_IDLE_MS + 10),
      'still on screen — it would have vanished on the old timestamp',
    )
  })

  test('a restage into a FREE slot is stamped too — it is the same gesture', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'friday draft', 1500)
    endSegment(2000)

    takeForDelivery('cursor')
    const back = restageDelivery(99_000)!
    assert.equal(back.updatedAt, 99_000)
    assert.equal(snapshot().pad?.updatedAt, 99_000, 'the live slot holds the stamped pad')
  })
})

describe('an empty pad leaves nothing behind on disk', () => {
  test('an armed tap on silence does not leave a directory forever', async () => {
    // Written while armed, emptied when the blank transcript lands, then
    // skipped by adoptPersistedPad (isEmpty) and never cleaned: one directory
    // of cruft under ~/.unmute per silent armed tap.
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    const dir = padDirFor(root, snapshot().pad!.id)
    endSegment(2000)
    removeFromPad(id, 2100)   // what holdIfArmed does on a blank transcript

    await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 120))
    assert.equal(existsSync(dir), false, 'no pad.json, and no directory either')
  })

  test('it also sweeps up what a REFUSED insert\'s rescue left in the directory', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    const dir = padDirFor(root, snapshot().pad!.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'insert-1.png'), 'ORPHAN')   // rescued, then refused
    endSegment(2000)

    writePadNow()
    assert.equal(existsSync(dir), false)
  })

  test('but a pad WITH CONTENT is written, not swept', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'real work', 1500)
    endSegment(2000)

    writePadNow()
    assert.ok(existsSync(join(padDirFor(root, snapshot().pad!.id), 'pad.json')))
  })

  test('and a pad holding only a COPY is content — its rescued image survives', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    const dir = padDirFor(root, snapshot().pad!.id)
    mkdirSync(dir, { recursive: true })
    const shot = join(dir, 'insert-1.png')
    writeFileSync(shot, 'PNG')
    recordInsert({ kind: 'image', content: shot, atMs: 1500 }, 1500)
    endSegment(2000)

    writePadNow()
    assert.ok(existsSync(join(dir, 'pad.json')), 'nothing was said, but something was captured')
    assert.ok(existsSync(shot))
  })

  test('MID-CAPTURE it never touches the directory — a rescue may be writing into it', () => {
    // Removing the directory here would pull it out from under an in-flight
    // osascript and lose an image the user deliberately captured.
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    const dir = padDirFor(root, snapshot().pad!.id)
    mkdirSync(dir, { recursive: true })
    const inflight = join(dir, 'insert-1.png')
    writeFileSync(inflight, 'BEING-RESCUED')

    writePadNow()   // the pad is empty, but the mic is still hot
    assert.ok(existsSync(inflight), 'the rescue in progress is left alone')
    assert.equal(existsSync(join(dir, 'pad.json')), false, 'and an empty pad is still not written')
  })
})

// ── THE THREE FIELD BUGS (2026-08-02) ───────────────────────────────────
//
// Found on a real dev build, in one dictation. Every test below fails against
// the code as it shipped.

describe('a copy lands WHERE IT HAPPENED, not at the end of the paste', () => {
  // The report, verbatim. The user spoke, copied a link after "…this tracker",
  // and kept speaking. The link came out on its own line at the very end,
  // because one capture produced ONE segment holding the whole transcript and
  // there was no seam inside the speech for an insert to occupy.
  const SPOKEN = 'So I want you to go through the open source cross project, '
    + "right? It's about agent or this tracker. It allows you to do all case "
    + 'straight multiple agents.'
  const LINK = 'https://github.com/Untrivial-ai/agent-orchestrator'

  const delivered = (segId: string | null, text: string, dest: 'cursor' | 'task' = 'cursor') =>
    composeWithInserts(segId, text, dest) ?? text

  test('THE FIELD CASE: the link reads inside the sentence it was copied after', () => {
    // 15s of speech; the copy at 9s, just after "…this tracker."
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'url', content: LINK, atMs: 10_000 }, 10_000)
    endSegment(16_000)

    assert.equal(
      delivered(id, SPOKEN),
      'So I want you to go through the open source cross project, '
      + "right? It's about agent or this tracker. "
      + `${LINK} `
      + 'It allows you to do all case straight multiple agents.',
    )
  })

  test('two copies open two seams, each after the sentence it followed', () => {
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'url', content: 'https://a.example', atMs: 5_500 }, 5_500)
    recordInsert({ kind: 'url', content: 'https://b.example', atMs: 10_000 }, 10_000)
    endSegment(16_000)

    assert.equal(
      delivered(id, SPOKEN),
      'So I want you to go through the open source cross project, right? '
      + 'https://a.example '
      + "It's about agent or this tracker. "
      + 'https://b.example '
      + 'It allows you to do all case straight multiple agents.',
    )
  })

  test('NEVER MID-SENTENCE: with no sentence boundary the insert still appends', () => {
    // The 2026-07-14 accuracy work: a bad cut is worse than a late insert.
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'url', content: LINK, atMs: 5_000 }, 5_000)
    endSegment(16_000)

    assert.equal(
      delivered(id, 'go through the thread from this morning and compare them'),
      `go through the thread from this morning and compare them ${LINK}`,
    )
  })

  test('the ARMED pad interleaves too — the same seam, held instead of pasted', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'url', content: LINK, atMs: 10_000 }, 10_000)
    endSegment(16_000)
    attachTranscript(id, SPOKEN, 16_500)

    const out = takeForDelivery('cursor')!
    assert.match(out.text, /this tracker\. https:\/\/github\.com\/Untrivial-ai\/agent-orchestrator It allows/)
  })

  test('a held pad splits ONLY its own stretch — an earlier capture is untouched', () => {
    armScratchpad(true)
    const first = beginSegment('cursor', 1_000, true)
    endSegment(5_000)
    attachTranscript(first, 'One. Two. Three.', 5_100)

    const second = beginSegment('cursor', 10_000, true)
    recordInsert({ kind: 'url', content: LINK, atMs: 13_000 }, 13_000)
    endSegment(16_000)
    attachTranscript(second, 'Four. Five. Six.', 16_100)

    const out = takeForDelivery('cursor')!
    assert.equal(
      out.text,
      `One. Two. Three. Four. ${LINK} Five. Six.`,
      'the earlier capture reads exactly as it did, and the link sits INSIDE the second',
    )
  })

  test('the split survives a write and a read back from disk', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'url', content: LINK, atMs: 10_000 }, 10_000)
    endSegment(16_000)
    attachTranscript(id, SPOKEN, 16_500)
    writePadNow()

    const raw = readFileSync(join(padDirFor(root, snapshot().pad!.id), 'pad.json'), 'utf8')
    const back = deserialize(raw)!
    assert.equal(
      render(back, 'cursor').text,
      render(snapshot().pad!, 'cursor').text,
      'the ids and offsets round-trip, so the pieces still bracket the insert',
    )
  })
})

describe('ONE COPY IS ONE INSERT — a browser writing three flavours is still one', () => {
  // The field screenshot showed the same link twice; an earlier one showed it
  // three times. A browser writes the pasteboard several times for a single ⌘C
  // (plain text, HTML, a public.url) and each bumps changeCount, so the watcher
  // reported N identical copies. Images were already deduped; text was not.
  const LINK = 'https://github.com/Untrivial-ai/agent-orchestrator'

  test('three pasteboard writes of the same link produce ONE insert', () => {
    const id = beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'url', content: LINK, atMs: 4_000 }, 4_000), true)
    assert.equal(recordInsert({ kind: 'url', content: LINK, atMs: 4_060 }, 4_060), false)
    assert.equal(recordInsert({ kind: 'url', content: LINK, atMs: 4_310 }, 4_310), false)
    endSegment(9_000)

    assert.equal(
      composeWithInserts(id, 'take a look at this', 'cursor'),
      `take a look at this ${LINK}`,
      'once, not three times',
    )
  })

  test('the classification does not matter — the CONTENT is what is claimed', () => {
    // The same string can classify differently between ticks (a path that
    // exists on one read and not the next). Claiming on content alone means one
    // user action is one insert whatever the classifier said.
    beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'line', content: 'same string', atMs: 2_000 }, 2_000), true)
    assert.equal(recordInsert({ kind: 'block', content: 'same string', atMs: 2_100 }, 2_100), false)
    assert.equal(snapshot().pad!.entries.filter((e) => e.type === 'insert').length, 1)
  })

  test('DIFFERENT text is never merged', () => {
    beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.example', atMs: 2_000 }, 2_000), true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://b.example', atMs: 2_050 }, 2_050), true)
    assert.equal(snapshot().pad!.entries.filter((e) => e.type === 'insert').length, 2)
  })

  test('past the window it IS a second copy — the user copied it again', () => {
    beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.example', atMs: 2_000 }, 2_000), true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.example', atMs: 9_000 }, 9_000), true)
    assert.equal(snapshot().pad!.entries.filter((e) => e.type === 'insert').length, 2)
  })

  test('TEXT GETS ITS OWN, TIGHTER WINDOW — a deliberate re-copy is not swallowed', () => {
    // The multi-flavour burst is sub-100ms. Borrowing the 2s IMAGE window (a
    // screenshot tool's disk write racing its pasteboard write) meant copying
    // the same string again one second later — an ordinary thing to do after
    // moving the cursor — silently vanished.
    beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.example', atMs: 2_000 }, 2_000), true)
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://a.example', atMs: 2_000 + TEXT_DEDUP_WINDOW_MS - 1 }, 0),
      false, 'inside the burst window it is still one copy',
    )
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://a.example', atMs: 3_200 }, 0),
      true, 'a second later it is a second copy — inside the old 2s image window',
    )
  })

  test('IMAGES keep the wide window — a disk write and a pasteboard write are slow apart', () => {
    // The image dedup is cross-DETECTOR and must still span the gap between a
    // screenshot tool writing the file and writing the pasteboard.
    const dir = mkdtempSync(join(tmpdir(), 'dedup-'))
    const shot = join(dir, 'shot.png')
    writeFileSync(shot, 'PNGBYTES')

    beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'image', content: shot, atMs: 2_000 }, 2_000), true)
    assert.equal(
      recordInsert({ kind: 'image', content: shot, atMs: 3_200 }, 0), false,
      '1.2s apart is still ONE screenshot — well past the text window',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('the window dies with the capture — the next one starts fresh', () => {
    beginSegment('cursor', 1_000, true)
    assert.equal(recordInsert({ kind: 'url', content: 'https://a.example', atMs: 2_000 }, 2_000), true)
    endSegment(3_000)

    beginSegment('cursor', 3_500, true)
    assert.equal(
      recordInsert({ kind: 'url', content: 'https://a.example', atMs: 4_000 }, 4_000), true,
      'a new recording is a new intention',
    )
  })
})

describe('a screenshot taken during a dictation actually reaches the cursor', () => {
  const SHOT = '/tmp/Screenshot 2026-08-02 at 14.22.png'

  test('the path stays out of the text, and the IMAGE is handed to delivery', () => {
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'image', content: SHOT, atMs: 2_000 }, 2_000)
    endSegment(3_000)

    const captured = { attachments: [] as string[] }
    const text = composeWithInserts(id, 'fix this', 'cursor', captured)
    assert.equal(text, 'fix this', 'a text field cannot hold a path')
    assert.deepEqual(captured.attachments, [SHOT], 'and it is NOT silently dropped')
  })

  test('text and image together: text first, image after', () => {
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'url', content: 'https://a.example', atMs: 2_000 }, 2_000)
    recordInsert({ kind: 'image', content: SHOT, atMs: 2_500 }, 2_500)
    endSegment(3_000)

    const captured = { attachments: [] as string[] }
    const text = composeWithInserts(id, 'look. and fix.', 'cursor', captured)
    assert.equal(text, 'look. https://a.example and fix.', 'the URL is text, so it composes inline')
    assert.deepEqual(captured.attachments, [SHOT], 'the image rides separately, after the text')
  })

  test('several images arrive in the order they were captured', () => {
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'image', content: '/tmp/one.png', atMs: 2_000 }, 2_000)
    recordInsert({ kind: 'image', content: '/tmp/two.png', atMs: 4_000 }, 4_000)
    endSegment(5_000)

    const captured = { attachments: [] as string[] }
    composeWithInserts(id, 'these two', 'cursor', captured)
    assert.deepEqual(captured.attachments, ['/tmp/one.png', '/tmp/two.png'])
  })

  test('NOTHING SPOKEN IS NOTHING DELIVERED — not even the image', () => {
    const id = beginSegment('cursor', 1_000, true)
    recordInsert({ kind: 'image', content: SHOT, atMs: 2_000 }, 2_000)
    endSegment(3_000)

    const captured = { attachments: [] as string[] }
    assert.equal(composeWithInserts(id, '', 'cursor', captured), null)
    assert.deepEqual(captured.attachments, [], 'a null answer must leave the caller with nothing')
  })

  test('the paste effect receives the images, in order, alongside the text', async () => {
    const seen: { text: string; images?: readonly string[] }[] = []
    registerPaste(async (text, images) => { seen.push({ text, images }) })

    armScratchpad(true)
    const id = beginSegment('cursor', 1_000, true)
    attachTranscript(id, 'these two', 1_500)
    recordInsert({ kind: 'image', content: '/tmp/one.png', atMs: 1_600 }, 1_600)
    recordInsert({ kind: 'image', content: '/tmp/two.png', atMs: 1_800 }, 1_800)
    endSegment(2_000)

    const r = await runDelivery(
      'cursor',
      async (text, attachments) => ((await pasteAtCursor(text, attachments)) ? 'cursor' : null),
    )
    assert.equal(r.landed, 'cursor')
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].images, ['/tmp/one.png', '/tmp/two.png'])
  })
})
