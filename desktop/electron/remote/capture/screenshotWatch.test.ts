import { test, describe } from 'node:test'
import assert from 'node:assert'
import { isScreenshotFile, createScreenshotWatch, type ScreenshotWatchDeps } from './screenshotWatch'
import type { InsertKind } from './types'

describe('name matching outside a dedicated folder', () => {
  test('the macOS default name is accepted', () => {
    assert.equal(isScreenshotFile('Screenshot 2026-07-30 at 14.22.01.png', false), true)
  })
  test('case and the space variant are accepted', () => {
    assert.equal(isScreenshotFile('screen shot 1.png', false), true)
    assert.equal(isScreenshotFile('SCREENSHOT.png', false), true)
  })
  test('an unrelated Desktop png is NOT swept in', () => {
    assert.equal(isScreenshotFile('logo.png', false), false)
  })
  test('a downloaded photo is not swept in', () => {
    assert.equal(isScreenshotFile('IMG_4821.jpeg', false), false)
  })
})

describe('inside a dedicated Screenshots folder any image counts', () => {
  test('an arbitrary name is accepted there', () => {
    assert.equal(isScreenshotFile('logo.png', true), true)
  })
  test('jpg and jpeg are accepted', () => {
    assert.equal(isScreenshotFile('a.jpg', true), true)
    assert.equal(isScreenshotFile('a.jpeg', true), true)
  })
  test('a non-image is still rejected', () => {
    assert.equal(isScreenshotFile('notes.txt', true), false)
    assert.equal(isScreenshotFile('Screenshot.txt', true), false)
  })
})

describe('macOS in-progress writes', () => {
  test('the .sb- temp file macOS writes first is ignored', () => {
    assert.equal(isScreenshotFile('.sb-abc123-Screenshot.png', false), false)
  })
  test('a dotfile is never a screenshot', () => {
    assert.equal(isScreenshotFile('.DS_Store', true), false)
  })
})

describe('createScreenshotWatch', () => {
  const DESKTOP = '/Users/x/Desktop'
  const SCREENSHOTS = '/Users/x/Pictures/Screenshots'

  function harness(overrides: Partial<ScreenshotWatchDeps> = {}) {
    const inserts: { kind: InsertKind; content: string; atMs: number }[] = []
    const closed: string[] = []
    const callbacks = new Map<string, (filename: string) => void>()
    let now = 1000
    const claimed = new Set<string>()
    const deps: ScreenshotWatchDeps = {
      dirs: () => [
        { dir: DESKTOP, dedicated: false },
        { dir: SCREENSHOTS, dedicated: true },
      ],
      watch: (dir, cb) => {
        callbacks.set(dir, cb)
        return { close: () => { closed.push(dir) } }
      },
      now: () => now,
      claim: (hash) => {
        if (claimed.has(hash)) return false
        claimed.add(hash)
        return true
      },
      onInsert: (i) => { inserts.push(i) },
      ...overrides,
    }
    const w = createScreenshotWatch(deps)
    return {
      w, inserts, closed, callbacks,
      setNow: (t: number) => { now = t },
      fire: (dir: string, filename: string) => callbacks.get(dir)?.(filename),
    }
  }

  test('arm registers a watcher per directory', () => {
    const h = harness()
    h.w.arm()
    assert.equal(h.callbacks.has(DESKTOP), true)
    assert.equal(h.callbacks.has(SCREENSHOTS), true)
  })

  test('a matching file in a non-dedicated dir fires onInsert with the full path', () => {
    const h = harness()
    h.w.arm()
    h.fire(DESKTOP, 'Screenshot 2026-07-30 at 1.png')
    assert.equal(h.inserts.length, 1)
    assert.equal(h.inserts[0].kind, 'image')
    assert.equal(h.inserts[0].content, `${DESKTOP}/Screenshot 2026-07-30 at 1.png`)
  })

  test('a non-matching file in a non-dedicated dir is ignored', () => {
    const h = harness()
    h.w.arm()
    h.fire(DESKTOP, 'logo.png')
    assert.equal(h.inserts.length, 0)
  })

  test('any image in the dedicated folder fires onInsert', () => {
    const h = harness()
    h.w.arm()
    h.fire(SCREENSHOTS, 'random-name.jpg')
    assert.equal(h.inserts.length, 1)
  })

  test('a dotfile temp write never fires', () => {
    const h = harness()
    h.w.arm()
    h.fire(DESKTOP, '.sb-abc123-Screenshot.png')
    assert.equal(h.inserts.length, 0)
  })

  test('an empty/undefined filename from fs.watch is ignored, not treated as a match', () => {
    const h = harness()
    h.w.arm()
    h.fire(DESKTOP, '')
    assert.equal(h.inserts.length, 0)
  })

  test('the insert timestamp is when the event fired', () => {
    const h = harness()
    h.w.arm()
    h.setNow(5_000)
    h.fire(DESKTOP, 'Screenshot 1.png')
    assert.equal(h.inserts[0].atMs, 5_000)
  })

  test('claim dedups: a second event for the same path is dropped', () => {
    const h = harness()
    h.w.arm()
    h.fire(DESKTOP, 'Screenshot 1.png')
    h.fire(DESKTOP, 'Screenshot 1.png')
    assert.equal(h.inserts.length, 1)
  })

  test('claim returning false suppresses the insert (another detector already claimed it)', () => {
    const h = harness({ claim: () => false })
    h.w.arm()
    h.fire(DESKTOP, 'Screenshot 1.png')
    assert.equal(h.inserts.length, 0)
  })

  test('disarm closes every watcher that was armed', () => {
    const h = harness()
    h.w.arm()
    h.w.disarm()
    assert.equal(h.closed.length, 2)
    assert.deepEqual(h.closed.sort(), [DESKTOP, SCREENSHOTS].sort())
  })

  test('disarm is safe to call when never armed', () => {
    const h = harness()
    assert.doesNotThrow(() => h.w.disarm())
    assert.equal(h.closed.length, 0)
  })

  test('disarm is safe to call twice in a row', () => {
    const h = harness()
    h.w.arm()
    h.w.disarm()
    assert.doesNotThrow(() => h.w.disarm())
    // the second disarm() must not re-close (or double-count) the same handles
    assert.equal(h.closed.length, 2)
  })

  test('a close() that throws during disarm does not stop the others from closing', () => {
    const closedOther: string[] = []
    const deps: ScreenshotWatchDeps = {
      dirs: () => [
        { dir: DESKTOP, dedicated: false },
        { dir: SCREENSHOTS, dedicated: true },
      ],
      watch: (dir) => ({
        close: () => {
          if (dir === DESKTOP) throw new Error('already gone')
          closedOther.push(dir)
        },
      }),
      now: () => 0,
      claim: () => true,
      onInsert: () => {},
    }
    const w = createScreenshotWatch(deps)
    w.arm()
    assert.doesNotThrow(() => w.disarm())
    assert.deepEqual(closedOther, [SCREENSHOTS])
  })

  test('a throwing onInsert does not escape the watch callback', () => {
    const h = harness({
      onInsert: () => { throw new Error('destroyed BrowserWindow') },
    })
    h.w.arm()
    assert.doesNotThrow(() => h.fire(DESKTOP, 'Screenshot 1.png'))
    assert.equal(h.inserts.length, 0)
  })

  test('a throwing claim does not escape the watch callback', () => {
    const h = harness({
      claim: () => { throw new Error('claim blew up') },
    })
    h.w.arm()
    assert.doesNotThrow(() => h.fire(DESKTOP, 'Screenshot 1.png'))
    assert.equal(h.inserts.length, 0)
  })

  test('a throwing onInsert on one event does not prevent a later, non-throwing event from firing', () => {
    let shouldThrow = true
    const h = harness({
      onInsert: (i) => {
        if (shouldThrow) throw new Error('destroyed BrowserWindow')
        h.inserts.push(i)
      },
    })
    h.w.arm()
    h.fire(DESKTOP, 'Screenshot 1.png')
    assert.equal(h.inserts.length, 0)

    shouldThrow = false
    h.fire(DESKTOP, 'Screenshot 2.png')
    assert.equal(h.inserts.length, 1)
  })
})
