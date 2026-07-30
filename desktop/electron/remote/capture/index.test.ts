import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSIST_DEBOUNCE_MS, _resetForTest, adoptPersistedPad, armScratchpad, attachTranscript,
  beginOwnClipboardSequence, beginSegment, cancelOpenSegment, currentPad, deliver,
  discard, endOwnClipboardSequence, endSegment, formatForDelivery, getCaptureSettings,
  initWatchers, isArmed, noteOwnClipboardWrite, pasteAtCursor, recordInsert, registerFormat,
  deliveryInFlight, registerPaste, registerSettings, removeFromPad, runDelivery,
  setOwnSequenceCeiling, setScratchpadRoot, settledPad, snapshot, takeForDelivery,
  writePadNow,
} from './index'
import { deserialize, padDirFor, serialize } from './scratchpadStore'
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

const segs = () => currentPad()?.entries.filter((e) => e.type === 'segment') ?? []
const inserts = () => currentPad()?.entries.filter((e) => e.type === 'insert') ?? []

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
    assert.equal(clipCalls.armed[0], padDirFor(root, currentPad()!.id))
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
// user copy. That would put the user's selection at the top of every dictation
// AND — through capture:insert-detected → insertPendingRef → decideCut — move
// the unarmed fast path's chunking. These tests drive the REAL clipboardWatch,
// because the guarantee is about what a tick can observe, not about what the
// façade remembers.
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
  // — and asserts the property that matters: the pad and the two siblings can
  // never disagree about whether an insert happened.
  test('BOTH siblings are gated: refused fires neither, recorded fires both', () => {
    const broadcasts: number[] = []
    const detects: number[] = []
    const onInsertRecorded = (i: { kind: 'url' | 'image'; content: string; atMs: number }) => {
      if (!recordInsert(i, Date.now())) return
      broadcasts.push(i.atMs)
      detects.push(i.atMs)
    }

    beginSegment('cursor', 1000, true)

    beginOwnClipboardSequence()
    onInsertRecorded({ kind: 'image', content: join(root, 'mid.png'), atMs: 1100 })
    assert.deepEqual(broadcasts, [], 'no pad broadcast for a refused insert')
    assert.deepEqual(detects, [], 'and NO capture:insert-detected — chunking is untouched')
    endOwnClipboardSequence(1200)

    onInsertRecorded({ kind: 'url', content: 'https://a.com', atMs: 1300 })
    assert.deepEqual(broadcasts, [1300])
    assert.deepEqual(detects, [1300])
    assert.equal(inserts().length, 1, 'the pad agrees with the signals')
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
    const firstPadId = currentPad()!.id

    beginSegment('cursor', 3000, true)
    assert.notEqual(currentPad()!.id, firstPadId, 'a new pad, not the old one')
    assert.equal(segs().length, 1, 'only this capture\'s segment')
  })

  test('an ARMED pad survives and the next capture appends to it', () => {
    armScratchpad(true)
    const a = beginSegment('cursor', 1000, true)
    attachTranscript(a, 'one', 1500)
    endSegment(2000)
    const padId = currentPad()!.id

    const b = beginSegment('cursor', 3000, true)
    attachTranscript(b, 'two', 3500)
    endSegment(4000)

    assert.equal(currentPad()!.id, padId)
    assert.equal(segs().length, 2)
  })

  test('arming BETWEEN captures starts fresh — a stranger\'s dictation is not adopted', () => {
    const a = beginSegment('cursor', 1000, true)
    attachTranscript(a, 'someone else\'s words', 1500)
    endSegment(2000)

    armScratchpad(true)
    assert.equal(currentPad(), null, 'the leftover pad was dropped')
  })

  test('arming DURING a capture keeps what is being said right now', () => {
    const a = beginSegment('cursor', 1000, true)
    const padId = currentPad()!.id
    armScratchpad(true)
    assert.equal(currentPad()?.id, padId)
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
    assert.equal(currentPad(), null)
  })
})

describe('inserts', () => {
  test('are positioned relative to the start of the capture', () => {
    beginSegment('cursor', 10_000, true)
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 12_500 }, 12_500)
    const i = inserts()[0]
    assert.equal(i.type === 'insert' && i.atMs, 2500)
  })

  test('are ignored when there is no pad', () => {
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 5 }, 5)
    assert.equal(currentPad(), null)
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

describe('deliver and discard', () => {
  test('deliver renders the pad and clears it', () => {
    armScratchpad(true)
    const id = beginSegment('task', 1000, true)
    attachTranscript(id, 'look at this', 1500)
    recordInsert({ kind: 'url', content: 'https://a.com', atMs: 1600 }, 1600)
    endSegment(2000)

    const out = deliver('task')
    assert.equal(out?.text, 'look at this https://a.com')
    assert.equal(currentPad(), null)
    assert.equal(isArmed(), false, 'delivering ends the hold')
  })

  test('deliver on an empty pad returns null and still clears', () => {
    assert.equal(deliver('cursor'), null)
    assert.equal(currentPad(), null)
  })

  test('discard clears the pad and the hold', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    discard()
    assert.equal(currentPad(), null)
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

    const file = join(padDirFor(root, currentPad()!.id), 'pad.json')
    assert.ok(existsSync(file), 'pad.json exists')
    assert.deepEqual(deserialize(readFileSync(file, 'utf8')), currentPad())
  })

  test('THE FAST PATH TOUCHES NO DISK: an unarmed capture writes nothing', async () => {
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'ordinary dictation', 1500)
    endSegment(2000)
    await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 120))
    assert.equal(existsSync(padDirFor(root, currentPad()!.id)), false)
  })

  test('discard takes the pad directory with it', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    writePadNow()
    const dir = padDirFor(root, currentPad()!.id)
    assert.ok(existsSync(dir))
    discard()
    assert.equal(existsSync(dir), false)
  })

  test('deliver removes the HELD STATE but leaves the rescued files', () => {
    armScratchpad(true)
    const id = beginSegment('task', 1000, true)
    attachTranscript(id, 'text', 1500)
    writePadNow()
    const dir = padDirFor(root, currentPad()!.id)
    const attachment = join(dir, 'insert-1.png')
    writeFileSync(attachment, 'IMG')

    deliver('task')
    assert.equal(existsSync(join(dir, 'pad.json')), false, 'held state gone')
    assert.ok(existsSync(attachment), 'the delivered attachment survives')
  })

  test('a persist failure never throws — and the pad survives it intact', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'held work', 1500)

    // First prove the write is REAL, so the no-throw below cannot be satisfied
    // by writePadNow simply doing nothing.
    writePadNow()
    const good = join(padDirFor(root, currentPad()!.id), 'pad.json')
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

    assert.equal(currentPad()?.entries.length, 1, 'the in-memory pad is untouched')
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
  test('the cursor skips images; a task keeps them as attachments', () => {
    armScratchpad(true)
    const id = beginSegment('cursor', 1000, true)
    attachTranscript(id, 'this one', 1500)
    recordInsert({ kind: 'image', content: '/tmp/shot.png', atMs: 1600 }, 1600)
    endSegment(2000)

    const cursor = takeForDelivery('cursor')!
    assert.equal(cursor.text, 'this one', 'no path pasted into a text field')
    assert.deepEqual(cursor.attachments, [])

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
    assert.equal(currentPad(), null, 'the user committed it; it does not linger')
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
    assert.equal(currentPad(), null, 'not live — nothing demands attention')
    assert.equal(settledPad()?.id, 'pad-a', 'held, waiting')
    assert.deepEqual(snapshot(), { pad: null, armed: false, held: adopted })
  })

  test('ARMING IS WHAT BRINGS IT BACK', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000, text: 'friday draft' })
    adoptPersistedPad()

    assert.equal(armScratchpad(true), true)
    assert.equal(currentPad()?.id, 'pad-a', 'the pad the user left is live again')
    assert.equal(settledPad(), null, 'and is no longer waiting')
    const e = currentPad()!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'friday draft')
  })

  test('an ORDINARY DICTATION does not destroy a settled pad', async () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    adoptPersistedPad()

    // The whole unarmed fast path: capture, transcript, stop.
    const id = beginSegment('cursor', 6000, true)
    attachTranscript(id, 'unrelated dictation', 6500)
    endSegment(7000)
    assert.equal(settledPad()?.id, 'pad-a', 'still waiting')
    assert.ok(existsSync(join(padDirFor(root, 'pad-a'), 'pad.json')), 'still on disk')

    // …and the FIRST arm after that dictation is what brings it back — it must
    // not spend itself clearing the leftover unarmed pad.
    assert.equal(armScratchpad(true), true)
    assert.equal(currentPad()?.id, 'pad-a')
  })

  test('a CORRUPT pad is discarded silently and never blocks startup', () => {
    leaveOnDisk({ id: 'pad-bad', updatedAt: 5000, raw: '{ this is not json' })
    assert.doesNotThrow(() => adoptPersistedPad())
    assert.equal(settledPad(), null)
    assert.equal(currentPad(), null)
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
    assert.equal(settledPad(), null)
  })

  test('NO pad on disk: nothing happens, nothing throws', () => {
    assert.equal(adoptPersistedPad(), null)
    assert.equal(settledPad(), null)
  })

  test('a missing scratchpad root is not an error', () => {
    setScratchpadRoot(join(root, 'never-created'))
    assert.doesNotThrow(() => adoptPersistedPad())
    assert.equal(settledPad(), null)
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
    const e = currentPad()!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'live work')
  })

  test('discard throws away the settled pad AND its files', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    adoptPersistedPad()

    discard()
    assert.equal(settledPad(), null)
    assert.equal(existsSync(padDirFor(root, 'pad-a')), false, 'it cannot come back at the next arm')
  })

  test('a refused arm (feature off) leaves the settled pad exactly where it was', () => {
    leaveOnDisk({ id: 'pad-a', updatedAt: 5000 })
    adoptPersistedPad()
    registerSettings(() => ({ scratchpadEnabled: false, captureEnabled: true }))

    assert.equal(armScratchpad(true), false)
    assert.equal(settledPad()?.id, 'pad-a', 'not promoted into a pad nothing will hold')
    assert.equal(currentPad(), null)
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
    assert.equal(r.restaged?.id, currentPad()?.id, 'it went back into the live slot')
    assert.equal((r.error as Error).message, 'pasteboard is locked')
    assert.equal(isArmed(), true, 'still held — the next capture appends, it does not replace')
    const e = currentPad()!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'the paragraph I spent ten minutes on')
  })

  test('a TASK destination throwing leaves the pad live, armed, and intact', async () => {
    // The real case: dispatchFromCapture's no-open-tasks branch has no failsafe,
    // so a network blip on the router propagates straight out of it.
    heldWork('refactor the arbiter and add the missing test')

    const r = await runDelivery('newTask', async () => { throw new Error('fetch failed') })

    assert.equal(r.landed, null)
    assert.equal(r.restaged?.id, currentPad()?.id)
    assert.equal(isArmed(), true)
    const e = currentPad()!.entries[0]
    assert.equal(e.type === 'segment' && e.text, 'refactor the arbiter and add the missing test')
  })

  test('the OPEN TASK destination throwing puts it back too', async () => {
    heldWork('and one more thing')
    const r = await runDelivery('openTask', async () => { throw new Error('pty is gone') })
    assert.equal(r.landed, null)
    assert.equal(currentPad()?.entries.length, 1)
  })

  test('a destination that DECLINES (returns null) puts it back — no throw needed', async () => {
    // pasteAtCursor returns false when no paste effect is registered, and
    // dispatchFromCapture returns null when nothing routed. Neither throws, and
    // both mean the text reached nothing.
    heldWork('nothing took this')

    const r = await runDelivery('newTask', async () => null)

    assert.equal(r.landed, null)
    assert.equal(r.restaged?.entries.length, 1)
    assert.equal(currentPad()?.entries.length, 1)
    assert.equal(r.error, undefined, 'declining is not an error, it is an answer')
  })

  test('THE RESTORED PAD IS BACK ON DISK — a crash after a failed delivery loses nothing', async () => {
    heldWork('durable again')
    writePadNow()
    const padId = currentPad()!.id
    const file = join(padDirFor(root, padId), 'pad.json')
    assert.ok(existsSync(file))

    // deliver() removes pad.json on the assumption the destination took it…
    const r = await runDelivery('newTask', async () => { throw new Error('boom') })

    // …and the restage has to undo that, not just fix memory.
    assert.ok(existsSync(file), 'pad.json is back')
    assert.equal(r.restaged?.id, padId)
    const onDisk = deserialize(readFileSync(file, 'utf8'))
    assert.deepEqual(onDisk, currentPad(), 'and it matches what is held')
  })

  test('a SUCCESSFUL delivery really does clear it — the safety net is not a leak', async () => {
    heldWork('ship it')
    const r = await runDelivery('cursor', async () => 'cursor')

    assert.equal(r.landed, 'cursor')
    assert.equal(r.restaged, null)
    assert.equal(currentPad(), null, 'delivered work does not linger')
    assert.equal(isArmed(), false)
    assert.equal(settledPad(), null, 'and it is not quietly settled either')
  })

  test('a delivered pad cannot be resurrected by a LATER failure', async () => {
    heldWork('first')
    await runDelivery('cursor', async () => 'cursor')
    // Nothing in flight any more; a second delivery of an empty pad must not
    // restage the pad the first one legitimately consumed.
    const r = await runDelivery('cursor', async () => { throw new Error('boom') })
    assert.equal(r.restaged, null)
    assert.equal(currentPad(), null)
  })

  test('the destination is not even called when there is nothing to send', async () => {
    let calls = 0
    const r = await runDelivery('cursor', async () => { calls++; return 'cursor' })
    assert.equal(calls, 0)
    assert.deepEqual({ landed: r.landed, restaged: r.restaged }, { landed: null, restaged: null })
  })

  test('if a NEW CAPTURE claimed the live slot, the failed pad settles instead of colliding', async () => {
    heldWork('the work I tried to send')
    const padId = currentPad()!.id

    const r = await runDelivery('newTask', async () => {
      // The user starts talking again while the router is hanging.
      beginSegment('cursor', 9000, true)
      throw new Error('router died')
    })

    assert.equal(r.restaged?.id, padId)
    assert.notEqual(currentPad()?.id, padId, 'the new capture keeps the live slot')
    assert.equal(settledPad()?.id, padId, 'and the failed delivery is one arm away')
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')), 'on disk either way')
  })

  test('two pads wanting the settled slot: NEITHER is deleted', async () => {
    // A pad from a previous run is still waiting when a delivery fails and a
    // fresh capture is holding the live slot.
    leaveOnDisk({ id: 'pad-old', updatedAt: 100, text: 'from last week' })
    adoptPersistedPad()
    heldWork('todays work')
    const padId = currentPad()!.id

    const warn = console.warn
    console.warn = () => {} // the second pad's location IS logged; keep it quiet here
    let r
    try {
      r = await runDelivery('newTask', async () => { beginSegment('cursor', 9000, true); throw new Error('nope') })
    } finally {
      console.warn = warn
    }

    assert.equal(r!.restaged?.id, padId)
    assert.equal(settledPad()?.id, padId, 'the more recently touched pad is the one arming brings back')
    assert.ok(existsSync(join(padDirFor(root, 'pad-old'), 'pad.json')), 'the older one is still recoverable on disk')
    assert.ok(existsSync(join(padDirFor(root, padId), 'pad.json')))
  })

  test('the surface is told twice: once when the pad is taken, once when it comes back', async () => {
    heldWork('watch the pad')
    const seen: (string | null)[] = []
    await runDelivery('newTask', async () => { throw new Error('boom') }, () => {
      seen.push(currentPad()?.id ?? null)
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
    const padId = currentPad()!.id

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
    assert.equal(currentPad()?.id, padId, 'and it is live again, not lost')
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
    assert.equal(currentPad(), null)
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
    assert.equal(currentPad(), null)
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
