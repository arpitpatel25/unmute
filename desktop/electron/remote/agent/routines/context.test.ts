import test from 'node:test'
import assert from 'node:assert/strict'
import { definitionFromFields, parseDefinition, parseRoutineContext, serializeDefinition } from './definition'
import { sessionInContext, contextCatalog } from './manifest'
import { referenceContext } from './context'
import { routineToolSelected } from './executor'
import { routineEditorFields } from './editor'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('context survives definition round-trip, including empty input selection and punctuation in paths', () => {
  const d = definitionFromFields('x', { name: 'X', prompt: 'Review', schedule: 'daily 09:00', inputs: [],
    context: parseRoutineContext({ folders: ['/work/a, b'], files: ['/notes/a: b.md'], sessionIds: ['s'] }) })
  assert.deepEqual(parseDefinition('x', serializeDefinition(d)), d)
  assert.throws(() => parseRoutineContext({ folders: ['relative'] }), /absolute/)
  assert.throws(() => parseRoutineContext({ files: ['/a\n/b'] }), /single-line/)
  assert.throws(() => parseRoutineContext({ mystery: [] }), /Unknown/)
})

test('reference snapshots report missing files, bound large files and respect symlink exclusions', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'routine-context-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.mkdir(join(dir, 'private'))
  await fs.writeFile(join(dir, 'large.md'), 'a'.repeat(40_000))
  await fs.writeFile(join(dir, 'private', 'secret.md'), 'DO NOT INCLUDE')
  await fs.symlink(join(dir, 'private', 'secret.md'), join(dir, 'alias.md'))
  const d = definitionFromFields('x', { name: 'X', schedule: 'daily 09:00', prompt: 'p',
    context: parseRoutineContext({ files: [join(dir, 'large.md'), join(dir, 'missing'), join(dir, 'alias.md')], excludedFolders: [join(dir, 'private')] }) })
  const text = await referenceContext(d)
  assert.match(text, /"truncated":true/)
  assert.match(text, /missing or unreadable/)
  assert.match(text, /"status":"excluded"/)
  assert.doesNotMatch(text, /DO NOT INCLUDE/)
  assert.ok(text.length < 34_000)
})

test('editor decodes native fields and rejects malformed inputs; retrieval categories follow selection', () => {
  const fields = routineEditorFields({ name: 'X', schedule: 'daily 09:00', window: 'today', kind: 'read-only', prompt: 'p',
    inputs: '["meetings"]', context: '{"meetingIds":["m1"]}' })
  const d = definitionFromFields('x', fields)
  assert.deepEqual(d.context?.meetingIds, ['m1'])
  assert.equal(routineToolSelected('notetaker_read', d), true)
  assert.equal(routineToolSelected('memory_search', d), false)
  assert.equal(routineToolSelected('index_search', d), false)
  assert.equal(routineToolSelected('unmute_history_search', d), false)
  assert.throws(() => routineEditorFields({ name: 'X', schedule: 'daily 09:00', window: 'today', kind: 'read-only', prompt: 'p', inputs: '"sessions"' }), /array/)
})

test('folder and explicit session selections form a union, exclusions win and folder boundaries matter', () => {
  const c = parseRoutineContext({ folders: ['/repo/a'], sessionIds: ['chosen', 'blocked'],
    excludedFolders: ['/repo/a/private'], excludedSessionIds: ['blocked'] })
  assert.equal(sessionInContext('s', '/repo/a/sub', c), true)
  assert.equal(sessionInContext('s', '/repo/ab', c), false)
  assert.equal(sessionInContext('chosen', '/elsewhere', c), true)
  assert.equal(sessionInContext('chosen', '/repo/a/private/sub', c), false)
  assert.equal(sessionInContext('blocked', '/repo/a', c), false)
  assert.equal(sessionInContext('s', undefined, c), false)
  assert.equal(sessionInContext('s', undefined), true)
})

test('context catalog lists projects and recent sessions while excluding routine provenance', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'routine-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(join(dir, 'sessions.jsonl'), [
    { id: 'old', cwd: '/repo/a', lastAt: 1 }, { id: 'new', cwd: '/repo/a', lastAt: 2 },
    { id: 'routine', cwd: '/routine', lastAt: 3, provenance: 'routine' },
  ].map(s => JSON.stringify(s)).join('\n'))
  const catalog = await contextCatalog(dir)
  assert.deepEqual(catalog.folders, ['/repo/a'])
  assert.deepEqual(catalog.sessions.map(s => s.id), ['new', 'old'])
})
