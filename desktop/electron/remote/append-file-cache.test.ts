import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppendFileCache } from './append-file-cache'

async function fixture(initial: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'append-cache-'))
  const file = path.join(dir, 'events.jsonl')
  await fs.writeFile(file, initial)
  return file
}

test('reads the complete file once, then performs zero-byte work while unchanged', async () => {
  const file = await fixture('{"n":1}\n')
  const cache = new AppendFileCache()
  const first = await cache.read(file)
  assert.equal(first.text, '{"n":1}\n')
  assert.equal(first.bytesRead, 8)
  assert.equal(first.changed, true)
  assert.equal(first.recovered, true)

  const second = await cache.read(file)
  assert.equal(second.text, first.text)
  assert.equal(second.bytesRead, 0)
  assert.equal(second.changed, false)
  assert.equal(second.recovered, false)
})

test('reads only appended bytes and preserves a partial trailing JSONL row', async () => {
  const file = await fixture('{"n":1}\n{"n"')
  const cache = new AppendFileCache()
  await cache.read(file)
  await fs.appendFile(file, ':2}\n')

  const next = await cache.read(file)
  assert.equal(next.bytesRead, 4)
  assert.equal(next.text, '{"n":1}\n{"n":2}\n')
  assert.equal(next.recovered, false)
})

test('truncation and inode replacement perform one complete recovery read', async () => {
  const file = await fixture('before\nmore\n')
  const cache = new AppendFileCache()
  await cache.read(file)

  await fs.truncate(file, 0)
  await fs.writeFile(file, 'new\n')
  const truncated = await cache.read(file)
  assert.equal(truncated.text, 'new\n')
  assert.equal(truncated.bytesRead, 4)
  assert.equal(truncated.recovered, true)

  const replacement = `${file}.replacement`
  await fs.writeFile(replacement, 'rotated\n')
  await fs.rename(replacement, file)
  const rotated = await cache.read(file)
  assert.equal(rotated.text, 'rotated\n')
  assert.equal(rotated.bytesRead, 8)
  assert.equal(rotated.recovered, true)
})

test('missing files do not retain stale cached content', async () => {
  const file = await fixture('present\n')
  const cache = new AppendFileCache()
  await cache.read(file)
  await fs.unlink(file)
  const missing = await cache.read(file)
  assert.equal(missing.text, '')
  assert.equal(missing.missing, true)
  assert.equal(missing.changed, true)
})

test('bounds retained transcript bytes and evicts the least-recently-used file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'append-cache-bound-'))
  const paths = ['a.jsonl', 'b.jsonl', 'c.jsonl'].map((name) => path.join(root, name))
  await Promise.all(paths.map((path, index) => fs.writeFile(path, `${index}\n`)))
  const cache = new AppendFileCache(2)
  try {
    await cache.read(paths[0]!)
    await cache.read(paths[1]!)
    await cache.read(paths[0]!) // a is now the most-recently-used entry
    await cache.read(paths[2]!) // b is evicted
    const reread = await cache.read(paths[1]!)
    assert.equal(reread.bytesRead, 2)
    assert.equal(reread.changed, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
