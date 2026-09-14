import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'

test('writes the content, sets mode 0o600, and leaves no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routines-'))
  const path = join(dir, 'file.json')
  await writeFileAtomic(path, '{"a":1}')
  assert.equal(await readFile(path, 'utf8'), '{"a":1}')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ['file.json'])
})

test('replaces existing content instead of merging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routines-'))
  const path = join(dir, 'file.json')
  await writeFileAtomic(path, 'first')
  await writeFileAtomic(path, 'second')
  assert.equal(await readFile(path, 'utf8'), 'second')
  assert.deepEqual(await readdir(dir), ['file.json'])
})
