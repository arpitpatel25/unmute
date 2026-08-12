import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureHistoryStore } from './history-store'

test('unsaved capture history expires with its owned attachments after 24 hours', () => {
  const root = mkdtempSync(join(tmpdir(), 'unmute-history-'))
  const image = join(root, 'capture.png')
  writeFileSync(image, 'image')
  const store = new CaptureHistoryStore(root)
  store.record({ id: 'old', kind: 'scratchpad', createdAt: 1, finalizedAt: 1, text: 'important', destination: 'cursor', attachments: [image] })
  store.record({ id: 'saved', kind: 'scratchpad', createdAt: 1, finalizedAt: 1, text: 'keep', destination: 'cursor', attachments: [], saved: true })

  store.cleanup(24 * 60 * 60 * 1000 + 2)

  assert.deepEqual(store.list().map((entry) => entry.id), ['saved'])
  assert.equal(existsSync(image), false)
})

test('saving an entry makes it exempt until the user un-saves it', () => {
  const root = mkdtempSync(join(tmpdir(), 'unmute-history-'))
  const store = new CaptureHistoryStore(root)
  store.record({ id: 'entry', kind: 'scratchpad', createdAt: 1, finalizedAt: 1, text: 'keep me', destination: 'task', attachments: [] })

  assert.equal(store.setSaved('entry', true), true)
  store.cleanup(24 * 60 * 60 * 1000 + 1)
  assert.equal(store.list()[0]?.id, 'entry')
  store.setSaved('entry', false)
  store.cleanup(24 * 60 * 60 * 1000 + 2)
  assert.deepEqual(store.list(), [])
})

test('archiving snapshots an image and never deletes the source screenshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'unmute-history-'))
  const sourceRoot = mkdtempSync(join(tmpdir(), 'unmute-screenshot-'))
  const source = join(sourceRoot, 'screen.png')
  writeFileSync(source, 'image')
  const store = new CaptureHistoryStore(root)

  const entry = store.archive({ id: 'snapshot', kind: 'dictation', createdAt: 1, finalizedAt: 1, text: 'with image', destination: 'cursor', attachments: [source] })
  store.cleanup(24 * 60 * 60 * 1000 + 2)

  assert.equal(existsSync(source), true)
  assert.equal(existsSync(entry.attachments[0]), false)
})
