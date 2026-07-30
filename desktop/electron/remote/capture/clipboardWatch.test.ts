import { test, describe } from 'node:test'
import assert from 'node:assert'
import { createClipboardWatch, type ClipboardWatchDeps } from './clipboardWatch'
import type { InsertKind } from './types'

function harness(overrides: Partial<ClipboardWatchDeps> = {}) {
  let count = 100
  let now = 1000
  const inserts: { kind: InsertKind; content: string; atMs: number }[] = []
  const deps: ClipboardWatchDeps = {
    changeCount: () => count,
    readText: () => 'https://a.com',
    hasImage: () => false,
    rescueImage: async () => '/staged/shot.png',
    exists: () => false,
    now: () => now,
    onInsert: (i) => { inserts.push(i) },
    ...overrides,
  }
  const w = createClipboardWatch(deps)
  return {
    w, inserts,
    bump: (by = 1) => { count += by },
    setNow: (t: number) => { now = t },
    get count() { return count },
  }
}

describe('arming', () => {
  test('a change BEFORE arming is never observed', async () => {
    const h = harness()
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('arming takes a baseline, so the change that armed it does not fire', async () => {
    const h = harness()
    h.w.arm('/pad')
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a change after arming fires once', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 1)
    assert.equal(h.inserts[0].content, 'https://a.com')
    assert.equal(h.inserts[0].kind, 'url')
  })

  test('the insert timestamp is when the change was SEEN', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.setNow(12_400)
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts[0].atMs, 12_400)
  })

  test('after disarm, nothing is observed', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.w.disarm()
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })
})

describe('our own writes', () => {
  test('a write we announced is skipped', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.bump()
    h.w.noteOwnWrite()   // reads the current count and records it
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a user copy right after our write still lands', async () => {
    const h = harness()
    h.w.arm('/pad')
    h.bump(); h.w.noteOwnWrite()
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 1)
  })
})

describe('content', () => {
  test('an image is rescued to a file and inserted as an image', async () => {
    const h = harness({ hasImage: () => true, readText: () => '' })
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts[0].kind, 'image')
    assert.equal(h.inserts[0].content, '/staged/shot.png')
  })

  test('a failed image rescue produces no insert, and does not throw', async () => {
    const h = harness({
      hasImage: () => true, readText: () => '', rescueImage: async () => null,
    })
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('empty clipboard content produces no insert', async () => {
    const h = harness({ readText: () => '' })
    h.w.arm('/pad')
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a platform that cannot observe (-1) never fires', async () => {
    const h = harness({ changeCount: () => -1 })
    h.w.arm('/pad')
    await h.w.tick()
    assert.equal(h.inserts.length, 0)
  })

  test('a platform that BECOMES unobservable after arming never fires', async () => {
    // Arm while genuinely observable (a positive baseline), then have the
    // count move AND simultaneously the platform report -1. The `c === lastSeen`
    // check alone would let this slip through (c=-1 differs from lastSeen=100);
    // it is the `c < 0` guard that must catch it.
    let observable = true
    let count = 100
    const inserts: { kind: InsertKind; content: string; atMs: number }[] = []
    const deps: ClipboardWatchDeps = {
      changeCount: () => (observable ? count : -1),
      readText: () => 'https://a.com',
      hasImage: () => false,
      rescueImage: async () => '/staged/shot.png',
      exists: () => false,
      now: () => 1000,
      onInsert: (i) => { inserts.push(i) },
    }
    const w = createClipboardWatch(deps)
    w.arm('/pad') // baseline while observable: lastSeen = 100
    count += 1 // 101 — a real change happened
    observable = false // but the platform now reports -1
    await w.tick()
    assert.equal(inserts.length, 0)
  })

  test('a rescue that REJECTS produces no insert, does not throw out of tick(), and releases busy', async () => {
    let shouldReject = true
    const h = harness({
      hasImage: () => true,
      readText: () => '',
      rescueImage: async () => {
        if (shouldReject) throw new Error('spawn failed')
        return '/staged/shot2.png'
      },
    })
    h.w.arm('/pad')
    h.bump()
    await assert.doesNotReject(() => h.w.tick())
    assert.equal(h.inserts.length, 0)

    // busy must have been released in the finally — a later change still fires.
    shouldReject = false
    h.bump()
    await h.w.tick()
    assert.equal(h.inserts.length, 1)
    assert.equal(h.inserts[0].content, '/staged/shot2.png')
  })

  test('disarm while a rescue is in flight drops the insert', async () => {
    let resolveRescue: (v: string | null) => void = () => {}
    const rescuePromise = new Promise<string | null>((resolve) => { resolveRescue = resolve })
    const h = harness({
      hasImage: () => true,
      readText: () => '',
      rescueImage: async () => rescuePromise,
    })
    h.w.arm('/pad')
    h.bump()
    const tickPromise = h.w.tick()
    h.w.disarm()
    resolveRescue('/staged/shot.png')
    await tickPromise
    assert.equal(h.inserts.length, 0)
  })
})

describe('the clipboard is never mutated', () => {
  test('deps expose no clear/write — the surface makes it impossible', () => {
    const h = harness()
    assert.equal('clear' in (h.w as object), false)
    assert.equal('write' in (h.w as object), false)
  })
})
