import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeDesktopDriver } from './driver'
import { encodeProjectDir } from './sessions'

/** A store with one task and, optionally, its transcript. */
async function store(opts: { cwd?: string; transcript?: string; meta?: Record<string, unknown> } = {}) {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'cd-sess-'))
  const projectsDir = await mkdtemp(join(tmpdir(), 'cd-proj-'))
  const cwd = opts.cwd ?? '/Users/z/proj'
  const leaf = join(sessionsDir, 'aa', 'bb')
  await mkdir(leaf, { recursive: true })
  await writeFile(join(leaf, 'local_s1.json'), JSON.stringify({
    sessionId: 'local_s1', cliSessionId: 'cli1', cwd, title: 'A task',
    lastActivityAt: 10, ...opts.meta,
  }))
  let tPath: string | null = null
  if (opts.transcript !== undefined) {
    const d = join(projectsDir, encodeProjectDir(cwd))
    await mkdir(d, { recursive: true })
    tPath = join(d, 'cli1.jsonl')
    await writeFile(tPath, opts.transcript)
  }
  const driver = new ClaudeDesktopDriver({
    sessionsDir, projectsDir, appInstalled: async () => true,
  })
  return { driver, sessionsDir, projectsDir, tPath }
}

const userRow = (t: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: t } })

test('availability is installed-only — reading works with the app CLOSED', async () => {
  const { driver } = await store()
  assert.deepEqual(await driver.availability(), { ok: true })
})

test('not installed is reported as such, not as a generic failure', async () => {
  const d = new ClaudeDesktopDriver({ appInstalled: async () => false })
  assert.deepEqual(await d.availability(), { ok: false, reason: 'not-installed' })
})

test('list enumerates the user EXISTING conversations, not just ones we created', async () => {
  const { driver } = await store()
  const all = await driver.list()
  assert.deepEqual(all.map((t) => t.sessionId), ['local_s1'])
})

test('snapshot pairs the task with its conversation', async () => {
  const { driver } = await store({ transcript: userRow('hello') })
  const view = await driver.snapshot('local_s1')
  assert.equal(view?.task.title, 'A task')
  assert.deepEqual(view?.snapshot.turns, [{ role: 'user', text: 'hello' }])
})

test('a task with no transcript yet still yields a card, with an empty conversation', async () => {
  // 8 of 33 tasks on a real store are in exactly this state. It must not read
  // as an error, or a third of the list renders as broken.
  const { driver } = await store()
  const view = await driver.snapshot('local_s1')
  assert.ok(view)
  assert.deepEqual(view.snapshot.turns, [])
  assert.equal(view.snapshot.lastAgentMessage, null)
})

test('an unknown sessionId is null, not a throw', async () => {
  const { driver } = await store()
  assert.equal(await driver.snapshot('local_nope'), null)
})

test('watch fires when the transcript grows', async () => {
  const { driver, tPath } = await store({ transcript: userRow('one') })
  const fired = await new Promise<boolean>((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false) } }, 3000)
    void driver.watch('local_s1', () => {
      if (done) return
      done = true; clearTimeout(timer); resolve(true)
    }).then(async (stop) => {
      await appendFile(tPath!, `\n${userRow('two')}`)
      setTimeout(stop, 2500)
    })
  })
  assert.equal(fired, true)
})

test('watching a task with no transcript returns a disposer, not an error', async () => {
  // The caller must not have to special-case a task that has not started.
  const { driver } = await store()
  const stop = await driver.watch('local_s1', () => {})
  assert.equal(typeof stop, 'function')
  stop()
})

test('watching an unknown task is also a safe no-op', async () => {
  const { driver } = await store()
  const stop = await driver.watch('nope', () => {})
  assert.equal(typeof stop, 'function')
  stop()
})
