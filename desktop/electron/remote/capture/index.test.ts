import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSIST_DEBOUNCE_MS, _resetForTest, armScratchpad, attachTranscript,
  beginOwnClipboardSequence, beginSegment, cancelOpenSegment, currentPad, deliver,
  discard, endOwnClipboardSequence, endSegment, getCaptureSettings, initWatchers,
  isArmed, noteOwnClipboardWrite, pasteAtCursor, recordInsert, registerPaste,
  registerSettings, removeFromPad, setOwnSequenceCeiling, setScratchpadRoot, writePadNow,
} from './index'
import { deserialize, padDirFor } from './scratchpadStore'
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
