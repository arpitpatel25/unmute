import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionIndex } from './store'
import type { SessionRoots } from './scan'

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-store-'))
  const roots: SessionRoots = {
    claudeProjects: join(dir, 'claude', 'projects'),
    codexSessions: join(dir, 'codex', 'sessions'),
    agentRuntime: join(dir, 'agent'),
  }
  await fs.mkdir(join(roots.claudeProjects, '-Users-me-repo'), { recursive: true })
  return { dir, roots, cachePath: join(dir, 'cache', 'index.json') }
}

const transcript = (opening: string, id = 'sess-1') => [
  JSON.stringify({ type: 'last-prompt', sessionId: id }),
  JSON.stringify({ type: 'user', cwd: '/Users/me/repo', message: { content: [{ type: 'text', text: opening }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Finished.' }] } }),
].join('\n')

test('a refresh indexes what is on disk and survives a restart', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    await fs.writeFile(join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl'), transcript('Audit billing'))
    const first = new SessionIndex({ cachePath, roots })
    assert.equal((await first.refresh()).length, 1)

    // A second index shares nothing but the file on disk.
    const second = new SessionIndex({ cachePath, roots })
    await second.refresh()
    assert.equal(second.all()[0]!.opening, 'Audit billing')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** Read once per change: that is what makes a cold start affordable. */
test('an unchanged transcript is not read a second time', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    const path = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    await fs.writeFile(path, transcript('Audit billing'))
    const index = new SessionIndex({ cachePath, roots })
    await index.refresh()

    // Rewrite the CONTENT without moving mtime: a cached record must win.
    const stat = await fs.stat(path)
    await fs.writeFile(path, transcript('completely different words'))
    await fs.utimes(path, stat.atime, stat.mtime)
    await index.refresh()
    assert.equal(index.all()[0]!.opening, 'Audit billing')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a touched transcript is re-read', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    const path = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    await fs.writeFile(path, transcript('Audit billing'))
    const index = new SessionIndex({ cachePath, roots })
    await index.refresh()

    await fs.writeFile(path, transcript('Now the rollback plan'))
    await fs.utimes(path, new Date(), new Date(Date.now() + 1000))
    await index.refresh()
    assert.equal(index.all()[0]!.opening, 'Now the rollback plan')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a deleted transcript leaves the index', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    const path = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    await fs.writeFile(path, transcript('Audit billing'))
    const index = new SessionIndex({ cachePath, roots })
    await index.refresh()
    await fs.rm(path)
    assert.deepEqual(await index.refresh(), [])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** A corrupt cache must cost a rescan, never a crash — that is why it is not
 *  in the encrypted store, where a failure is not this cheap. */
test('a corrupt cache is a cold start, not an error', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    await fs.mkdir(join(dir, 'cache'), { recursive: true })
    await fs.writeFile(cachePath, 'not json at all')
    await fs.writeFile(join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl'), transcript('Audit billing'))
    const index = new SessionIndex({ cachePath, roots })
    assert.equal((await index.refresh()).length, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a session is findable by harness id or by task id', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    await fs.writeFile(join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl'), transcript('Audit billing', 'known-id'))
    const index = new SessionIndex({ cachePath, roots })
    await index.refresh()
    assert.ok(index.find('known-id'))
    assert.equal(index.find('nope'), undefined)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('reading a session in full is separate from indexing it', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    await fs.writeFile(join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl'), transcript('Audit billing', 'known-id'))
    const index = new SessionIndex({ cachePath, roots })
    await index.refresh()
    const full = await index.readFull('known-id')
    assert.match(String(full), /Audit billing/)
    assert.equal(await index.readFull('missing'), null)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** `within` bounds what is READ, never what is known. */
test('an old session already cached stays queryable', async () => {
  const { dir, roots, cachePath } = await fixture()
  try {
    const path = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    await fs.writeFile(path, transcript('Audit billing'))
    const index = new SessionIndex({ cachePath, roots })
    await index.refresh()
    // Refresh with a window that excludes it from re-reading.
    assert.equal((await index.refresh(1)).length, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
