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
})

describe('the clipboard is never mutated', () => {
  test('deps expose no clear/write — the surface makes it impossible', () => {
    const h = harness()
    assert.equal('clear' in (h.w as object), false)
    assert.equal('write' in (h.w as object), false)
  })
})
