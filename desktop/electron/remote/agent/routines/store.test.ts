import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutineStore } from './store'
import { nextFireAt } from './schedule'
import { serializeDefinition, definitionFromFields } from './definition'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'routines-'))
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('create writes the definition file and state with the next fire time', async () => {
  const root = await tempRoot()
  const now = at(2026, 9, 14, 8) // Monday 08:00
  const store = new RoutineStore({ root, now: () => now, watch: false })
  const entry = await store.create({ name: 'Morning recap', schedule: 'weekdays 09:00', prompt: 'Tell me what I worked on.' })
  assert.equal(entry.id, 'morning-recap')
  const text = await readFile(join(root, 'morning-recap.md'), 'utf8')
  assert.match(text, /name: Morning recap/)
  assert.equal(entry.state.enabled, true)
  assert.equal(entry.state.nextFireAt, nextFireAt(entry.definition!.schedule, now))
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.routines['morning-recap'].enabled, true)
  assert.equal(state.routines['morning-recap'].nextFireAt, entry.state.nextFireAt)
})

test('editing the file schedule by hand and loading recomputes nextFireAt', async () => {
  const root = await tempRoot()
  let now = at(2026, 9, 14, 8)
  const store = new RoutineStore({ root, now: () => now, watch: false })
  const entry = await store.create({ name: 'Morning recap', schedule: 'weekdays 09:00', prompt: 'p' })
  const originalNext = entry.state.nextFireAt

  const edited = definitionFromFields('morning-recap', { name: 'Morning recap', schedule: 'daily 10:00', prompt: 'p' })
  await writeFile(join(root, 'morning-recap.md'), serializeDefinition(edited))

  now = at(2026, 9, 14, 8, 30)
  const reloaded = await store.load()
  const updated = reloaded.find(e => e.id === 'morning-recap')!
  assert.equal(updated.definition!.schedule.type, 'clock')
  assert.notEqual(updated.state.nextFireAt, originalNext)
  assert.equal(updated.state.nextFireAt, nextFireAt(edited.schedule, now))
})

test('an invalid file becomes an entry with an error, load does not throw', async () => {
  const root = await tempRoot()
  await writeFile(join(root, 'broken.md'), '---\nname: Broken\n---\n')
  const store = new RoutineStore({ root, watch: false })
  const entries = await store.load()
  const broken = entries.find(e => e.id === 'broken')!
  assert.ok(broken.error)
  assert.equal(broken.definition, undefined)
})

test('remove moves the file into .trash', async () => {
  const root = await tempRoot()
  const store = new RoutineStore({ root, watch: false })
  const entry = await store.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p' })
  await store.remove(entry.id)
  assert.equal(store.get(entry.id), undefined)
  await assert.rejects(readFile(join(root, 'morning-recap.md')))
  const { readdir } = await import('node:fs/promises')
  const trashed = await readdir(join(root, '.trash'))
  assert.equal(trashed.length, 1)
  assert.match(trashed[0]!, /^morning-recap-\d+\.md$/)
})

test('setEnabled persists across a new RoutineStore instance', async () => {
  const root = await tempRoot()
  const store = new RoutineStore({ root, watch: false })
  const entry = await store.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p' })
  await store.setEnabled(entry.id, false)

  const reopened = new RoutineStore({ root, watch: false })
  await reopened.load()
  assert.equal(reopened.get(entry.id)?.state.enabled, false)
})

test('re-enabling a routine whose nextFireAt is stale recomputes it', async () => {
  const root = await tempRoot()
  let now = at(2026, 9, 14, 8)
  const store = new RoutineStore({ root, now: () => now, watch: false })
  const entry = await store.create({ name: 'R', schedule: 'daily 09:00', prompt: 'p' })
  await store.setEnabled(entry.id, false)
  now = at(2026, 9, 20, 8) // well past the stale nextFireAt
  await store.setEnabled(entry.id, true)
  const updated = store.get(entry.id)!
  assert.equal(updated.state.enabled, true)
  assert.ok(updated.state.nextFireAt! > now)
})

test('update merges fields, validates, and rewrites the same file', async () => {
  const root = await tempRoot()
  const store = new RoutineStore({ root, watch: false })
  const entry = await store.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p', maxMinutes: 5 })
  const updated = await store.update(entry.id, { prompt: 'New prompt' })
  assert.equal(updated.id, entry.id)
  assert.equal(updated.path, entry.path)
  assert.equal(updated.definition!.prompt, 'New prompt')
  assert.equal(updated.definition!.maxMinutes, 5) // untouched fields are preserved
  await assert.rejects(store.update(entry.id, { maxMinutes: 999 }), /1 and 30/)
})

test('a filename that is not a valid routine id surfaces as an error entry, not a throw', async () => {
  const root = await tempRoot()
  await writeFile(join(root, 'UPPERCASE.md'), '---\nname: X\nschedule: daily 09:00\nprompt: p\n---\nHello\n')
  const store = new RoutineStore({ root, watch: false })
  const entries = await store.load()
  const bad = entries.find(e => e.id === 'UPPERCASE')!
  assert.equal(bad.error, 'File name must be lowercase letters, numbers and dashes')
  assert.equal(bad.definition, undefined)
})

test('a corrupt state.json falls back to a clean default instead of throwing', async () => {
  const root = await tempRoot()
  await writeFile(join(root, 'state.json'), 'not json at all')
  const store = new RoutineStore({ root, watch: false })
  const entries = await store.load()
  assert.deepEqual(entries, [])

  // load() also repairs state.json in place: the next write is valid JSON again.
  const entry = await store.create({ name: 'A', schedule: 'daily 09:00', prompt: 'p' })
  assert.equal(entry.state.enabled, true)
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.version, 1)
})

test('a load failure triggered by the watcher is reported to onError, not thrown into the void', async () => {
  const root = await tempRoot()
  const errors: unknown[] = []
  const store = new RoutineStore({ root, watch: true, onError: error => { errors.push(error) } })
  await store.load()

  // Force the NEXT load() (triggered by the watcher below) to fail: replace
  // state.json with a directory, so writeState()'s rename onto it throws
  // EISDIR — deterministic on both macOS and Linux, no permission trickery.
  const { rm, mkdir } = await import('node:fs/promises')
  await rm(join(root, 'state.json'), { force: true })
  await mkdir(join(root, 'state.json'))

  store.onChange(() => {}) // starts the watcher; a failing reload never calls this listener
  await writeFile(join(root, 'b.md'), '---\nname: B\nschedule: daily 09:00\nprompt: p\n---\nx\n')

  await new Promise(resolve => setTimeout(resolve, 400)) // past the 200ms debounce
  assert.ok(errors.length > 0, 'onError should have been called at least once')
  store.close()
})

test('onChange fires after a file changes on disk, and close stops the watcher', async () => {
  const root = await tempRoot()
  const store = new RoutineStore({ root, watch: true })
  await store.load()
  const changed = new Promise<void>(resolve => {
    const off = store.onChange(() => { off(); resolve() })
  })
  await store.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p' })
  await changed
  store.close()
})

test('writes to runs.json, runs/ and agent-journal/ do not reload the store', async () => {
  const root = await tempRoot()
  const store = new RoutineStore({ root, watch: true })
  await store.load()
  await store.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p' })
  await new Promise(r => setTimeout(r, 400)) // let the create's own events drain
  let changes = 0
  store.onChange(() => { changes++ })
  const { mkdir } = await import('node:fs/promises')
  await writeFile(join(root, 'runs.json'), '[]')
  await mkdir(join(root, 'runs', 'run-1'), { recursive: true })
  await writeFile(join(root, 'runs', 'run-1', 'result.md'), 'r')
  await mkdir(join(root, 'agent-journal'), { recursive: true })
  await writeFile(join(root, 'agent-journal', 'j.json'), '{}')
  await new Promise(r => setTimeout(r, 400))
  assert.equal(changes, 0)
  store.close()
})

test('a reload racing a state write never restores the older state', async () => {
  const root = await tempRoot()
  const store = new RoutineStore({ root, watch: false })
  const entry = await store.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p' })
  const later = entry.state.nextFireAt! + 86_400_000
  await Promise.all([store.setNextFireAt(entry.id, later), store.load()])
  assert.equal(store.get(entry.id)!.state.nextFireAt, later)
  const reopened = new RoutineStore({ root, watch: false })
  await reopened.load()
  assert.equal(reopened.get(entry.id)!.state.nextFireAt, later)
})
