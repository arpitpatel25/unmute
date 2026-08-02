import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { handOffImages, SETTLE_MS, type HandoffDeps } from './pasteboardHandoff'

/** The decoded-image handle a real `prepareImage` would return. Opaque to the
 *  module; carried straight through to the write. */
interface FakeImage { from: string }

/** Every effect, in the order it happened. The contract IS the order. */
function recorder(overrides: Partial<HandoffDeps<FakeImage>> = {}) {
  const trace: string[] = []
  const warnings: string[] = []
  const decodes: string[] = []
  const deps: HandoffDeps<FakeImage> = {
    prepareImage: (p) => {
      decodes.push(p)
      trace.push(`prepare(${p})`)
      return p.endsWith('.png') ? { image: { from: p }, bytes: p.length * 100 } : null
    },
    clearAndRecord: () => { trace.push('clear+record') },
    writeImageAndRecord: (img) => { trace.push(`writeImage(${img.from})+record`) },
    writeTextAndRecord: (t) => { trace.push(`writeText(${t})+record`) },
    verifyServesPNG: async (b) => { trace.push(`verify(${b})`); return true },
    paste: async () => { trace.push('paste') },
    settle: async (ms) => { trace.push(`settle(${ms})`) },
    warn: (m) => { warnings.push(m) },
    ...overrides,
  }
  return { trace, warnings, decodes, deps }
}

describe('nothing to hand over costs nothing', () => {
  test('no images ⇒ not one effect, not even a settle', async () => {
    const { trace, deps } = recorder()
    assert.equal(await handOffImages(deps, [], 'the words'), 0)
    assert.deepEqual(trace, [], 'an ordinary dictation must not pay for this')
  })
})

describe('the pasteboard race is closed by ORDER, not by hope', () => {
  test('one image: settle, decode, pre-clear, write, child-verify, paste, settle, restore', async () => {
    const { trace, deps } = recorder()
    const pasted = await handOffImages(deps, ['/pad/a.png'], ' the words ')

    assert.equal(pasted, 1)
    assert.deepEqual(trace, [
      // The text's ⌘V has been POSTED, not served — nothing may overwrite it yet.
      `settle(${SETTLE_MS})`,
      // The decode happens BEFORE the pasteboard is touched at all.
      'prepare(/pad/a.png)',
      // Pre-clear is what makes the verify sound: a PNG in an emptied slot is ours.
      'clear+record',
      'writeImage(/pad/a.png)+record',
      // ANOTHER process confirms the system pasteboard serves our exact payload.
      `verify(${'/pad/a.png'.length * 100})`,
      'paste',
      `settle(${SETTLE_MS})`,
      // The clipboard ends up holding what was dictated, not the screenshot.
      'writeText( the words )+record',
    ])
  })

  // The hazard: a second nativeImage.createFromPath between the clear and the
  // write would leave the SYSTEM PASTEBOARD EMPTY for the length of a Retina
  // decode — tens of milliseconds — and if the two decodes' PNG encodings
  // differed by one byte the verify could never match, so every image would
  // burn the full timeout and then paste anyway, silently and slowly. The type
  // is what prevents it: writeImageAndRecord takes the decoded handle, never a
  // path, so there is nothing in the window that COULD decode.
  test('EXACTLY ONE decode per image, and it is outside the clear→write window', async () => {
    const { trace, decodes, deps } = recorder()
    await handOffImages(deps, ['/pad/a.png', '/pad/b.png'], 'x')

    assert.deepEqual(decodes, ['/pad/a.png', '/pad/b.png'], 'one decode each, no more')
    for (let i = 0; i < trace.length; i++) {
      if (trace[i] === 'clear+record') {
        assert.ok(trace[i - 1].startsWith('prepare('), 'the decode precedes the clear')
        assert.ok(trace[i + 1].startsWith('writeImage('), 'and nothing sits between clear and write')
      }
    }
  })

  test('the bytes VERIFIED are the bytes WRITTEN — one decode measured both', async () => {
    // Two decodes could disagree by a byte and make the verify unmatchable.
    // Same handle, same measurement, by construction.
    const seen: { wrote: string | null; verified: number | null } = { wrote: null, verified: null }
    const { deps } = recorder({
      prepareImage: (p) => ({ image: { from: p }, bytes: 4242 }),
      writeImageAndRecord: (img) => { seen.wrote = img.from },
      verifyServesPNG: async (b) => { seen.verified = b; return true },
    })
    await handOffImages(deps, ['/pad/a.png'], 'x')
    assert.equal(seen.wrote, '/pad/a.png')
    assert.equal(seen.verified, 4242)
  })

  test('the FIRST thing that happens is the settle — never a write', async () => {
    const { trace, deps } = recorder()
    await handOffImages(deps, ['/pad/a.png'], 'x')
    assert.equal(trace[0], `settle(${SETTLE_MS})`, 'the text would be clobbered otherwise')
  })

  test('every write is IMMEDIATELY followed by its own-write record', async () => {
    // The record reads the change counter at CALL time and the watcher polls
    // every 250ms, so an await between the two lets a poll read our own write
    // as a user copy — an insert in the transcript. The deps expose no way to
    // write without recording, which is the point; this asserts the shape
    // survives.
    const { trace, deps } = recorder()
    await handOffImages(deps, ['/pad/a.png', '/pad/b.png'], 'x')
    for (const step of trace) {
      if (step.startsWith('clear') || step.startsWith('write')) {
        assert.ok(step.endsWith('+record'), `${step} must record the write it caused`)
      }
    }
  })

  test('verification happens BEFORE the paste, every time', async () => {
    const { trace, deps } = recorder()
    await handOffImages(deps, ['/pad/a.png', '/pad/b.png'], 'x')
    for (let i = 0; i < trace.length; i++) {
      if (trace[i] === 'paste') {
        assert.ok(trace[i - 1].startsWith('verify('), 'a paste is only ever posted on a verified slot')
      }
    }
  })

  test('a verify that TIMES OUT still pastes — a late image beats no image', async () => {
    const { trace, deps } = recorder({ verifyServesPNG: async () => { trace.push('verify(timeout)'); return false } })
    assert.equal(await handOffImages(deps, ['/pad/a.png'], 'x'), 1)
    assert.ok(trace.includes('paste'))
  })
})

describe('several images go in order, each one isolated from the last', () => {
  test('three images: three clear/write/verify/paste cycles, in the given order', async () => {
    const { trace, deps } = recorder()
    const pasted = await handOffImages(deps, ['/pad/a.png', '/pad/b.png', '/pad/c.png'], 'x')

    assert.equal(pasted, 3)
    assert.deepEqual(
      trace.filter((s) => s.startsWith('writeImage')),
      ['writeImage(/pad/a.png)+record', 'writeImage(/pad/b.png)+record', 'writeImage(/pad/c.png)+record'],
    )
    assert.equal(trace.filter((s) => s === 'clear+record').length, 3, 'each image gets its own pre-clear')
    assert.equal(trace.filter((s) => s === 'paste').length, 3)
    assert.equal(trace.filter((s) => s === 'writeText(x)+record').length, 1, 'the text is restored once, at the end')
  })

  test('two images of IDENTICAL size cannot verify against each other', async () => {
    // Without the pre-clear the second verify would pass instantly against the
    // FIRST image — and the first would be pasted twice. The clear between them
    // is the whole defence, so it is asserted positionally.
    const { trace, deps } = recorder({ prepareImage: (p) => ({ image: { from: p }, bytes: 4096 }) })
    await handOffImages(deps, ['/pad/a.png', '/pad/b.png'], 'x')

    const second = trace.indexOf('writeImage(/pad/b.png)+record')
    const first = trace.indexOf('writeImage(/pad/a.png)+record')
    assert.ok(first < second)
    assert.equal(trace[second - 1], 'clear+record', 'the slot was emptied before the second write')
  })
})

describe('a failing image never costs the text or the others', () => {
  test('an unreadable file is skipped, and the rest still land', async () => {
    const { trace, warnings, deps } = recorder()
    const pasted = await handOffImages(deps, ['/pad/gone.tiff', '/pad/b.png'], 'x')

    assert.equal(pasted, 1)
    assert.deepEqual(trace.filter((s) => s.startsWith('writeImage')), ['writeImage(/pad/b.png)+record'])
    assert.equal(warnings.length, 1)
  })

  test('a THROWING paste is contained — the next image goes, the text is restored', async () => {
    let n = 0
    const { trace, warnings, deps } = recorder({
      paste: async () => { n++; if (n === 1) throw new Error('CGEvent refused'); trace.push('paste') },
    })
    const pasted = await handOffImages(deps, ['/pad/a.png', '/pad/b.png'], 'x')

    assert.equal(pasted, 1, 'the second one still landed')
    assert.equal(trace[trace.length - 1], 'writeText(x)+record', 'and the clipboard is left correct')
    assert.equal(warnings.length, 1)
  })

  test('a throwing prepareImage is contained too', async () => {
    const { warnings, deps } = recorder({ prepareImage: () => { throw new Error('decode blew up') } })
    assert.equal(await handOffImages(deps, ['/pad/a.png'], 'x'), 0)
    assert.equal(warnings.length, 1)
  })

  test('a throwing restore is swallowed — it is the last thing that happens', async () => {
    const { warnings, deps } = recorder({ writeTextAndRecord: () => { throw new Error('pasteboard gone') } })
    assert.equal(await handOffImages(deps, ['/pad/a.png'], 'x'), 1)
    assert.equal(warnings.length, 1)
  })
})
