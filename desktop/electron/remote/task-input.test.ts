import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { draftInput } from './task-input'

test('ordered image and collapsed paste preserve all text and whitespace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-input-'))
  try {
    const path = join(dir, 'paste.txt'), pasted = '\n  exact\ttext 😀\n\n'
    await writeFile(path, pasted)
    const input = await draftInput({ text: 'beforeafter', attachments: [
      { id: 'image', path: join(dir, 'image.png'), name: 'Screenshot.png', mimeType: 'image/png', offset: 6 },
      { id: 'paste', path, name: 'Pasted text', mimeType: 'text/x-unmute-paste', offset: 6 },
    ] })
    assert.deepEqual(input.map(p => p.type === 'text' ? p.text : p.name), ['before', 'Screenshot.png', pasted, 'after'])
    assert.equal(input[1].type, 'image')
    await rm(path)
    await assert.rejects(draftInput({ text: 'keep me', attachments: [{ id: 'missing', path, name: 'Paste', mimeType: 'text/x-unmute-paste' }] }), /ENOENT/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
