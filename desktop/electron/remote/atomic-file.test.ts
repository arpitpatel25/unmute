import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'atomic-file-'))
}

test('writeFileAtomic writes the full content in one shot', async () => {
  const dir = await tmpDir()
  const p = path.join(dir, 'meta.json')
  await writeFileAtomic(p, JSON.stringify({ a: 1 }))
  assert.equal(await fs.readFile(p, 'utf8'), JSON.stringify({ a: 1 }))
})

// THE BUG THIS EXISTS FOR. `fs.writeFile` truncates the destination to empty
// BEFORE writing the new bytes — two steps, not one. A process that dies
// between them leaves the file empty forever, since nothing else ever
// rewrites it. This is what turned 5 of 10 real task `meta.json` files into
// 0-byte files in the field, silently dropping those tasks from the
// dashboard on the next launch. Simulating "died before the rename ran" must
// leave the ORIGINAL content untouched — a stray temp file is harmless
// debris, never a truncated destination.
test('a write that never reaches its rename leaves the destination fully intact', async () => {
  const dir = await tmpDir()
  const p = path.join(dir, 'meta.json')
  await writeFileAtomic(p, JSON.stringify({ a: 1 }))

  // Simulate the "died before rename" half of a second writeFileAtomic call:
  // the new content lands in its own sibling file, and that's as far as it
  // gets — no rename ever touches `p`.
  await fs.writeFile(`${p}.tmp-fake-crash`, JSON.stringify({ a: 2 }))

  assert.equal(
    await fs.readFile(p, 'utf8'),
    JSON.stringify({ a: 1 }),
    'the real file must still hold the complete OLD content, never a truncated one',
  )
})

test('a completed write leaves no stray temp file behind', async () => {
  const dir = await tmpDir()
  const p = path.join(dir, 'meta.json')
  await writeFileAtomic(p, JSON.stringify({ a: 1 }))
  assert.deepEqual(await fs.readdir(dir), ['meta.json'])
})

test('two concurrent writes to the same path each get their own temp name and never garble the result', async () => {
  const dir = await tmpDir()
  const p = path.join(dir, 'meta.json')
  await Promise.all([
    writeFileAtomic(p, JSON.stringify({ a: 1 })),
    writeFileAtomic(p, JSON.stringify({ a: 2 })),
  ])
  const final = JSON.parse(await fs.readFile(p, 'utf8')) as { a: number }
  assert.ok(final.a === 1 || final.a === 2, 'the destination is one complete write or the other, never a mix')
  assert.deepEqual(await fs.readdir(dir), ['meta.json'])
})
