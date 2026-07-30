import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSIST_DEBOUNCE_MS, _resetForTest, armScratchpad, attachTranscript, beginSegment,
  cancelOpenSegment, currentPad, deliver, discard, endSegment, getCaptureSettings,
  initWatchers, isArmed, noteOwnClipboardWrite, pasteAtCursor, rebaselineClipboard,
  recordInsert, registerPaste, registerSettings, removeFromPad, setScratchpadRoot,
  writePadNow,
} from './index'
import { deserialize, padDirFor } from './scratchpadStore'
import type { createClipboardWatch } from './clipboardWatch'
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
})

describe('rebaselineClipboard', () => {
  test('re-arms the clipboard watcher on the same pad dir', () => {
    beginSegment('cursor', 1000, true)
    rebaselineClipboard()
    assert.equal(clipCalls.armed.length, 2)
    assert.equal(clipCalls.armed[0], clipCalls.armed[1])
  })

  test('does NOTHING when the watcher was never armed — the gate stays honoured', () => {
    beginSegment('cursor', 1000, false)
    rebaselineClipboard()
    assert.equal(clipCalls.armed.length, 0)
  })

  test('does nothing after the window closed', () => {
    beginSegment('cursor', 1000, true)
    endSegment(2000)
    rebaselineClipboard()
    assert.equal(clipCalls.armed.length, 1)
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

  test('a persist failure never throws at the caller', () => {
    armScratchpad(true)
    beginSegment('cursor', 1000, true)
    setScratchpadRoot('/dev/null/definitely-not-a-directory')
    const warn = console.warn
    console.warn = () => {} // the failure IS logged; keep it out of test output
    try {
      assert.doesNotThrow(() => writePadNow())
    } finally {
      console.warn = warn
    }
  })
})
