import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionStore, conversationKey, defaultCachePath } from './store'
import type { SessionRoots } from './scan'

const answer = (over: Record<string, unknown> = {}) => JSON.stringify({
  about: 'Editing the promo video', done: ['cut the intro'], standing: 'mid-edit', touched: ['promo.mp4'], ...over,
})
const okModel = (output = answer()) => async () => ({ ok: true as const, output })
const deadModel = async () => ({ ok: false as const, error: 'no binary' })

const userLine = (text: string, cwd = '/Users/me/repo', sessionId = 'sess-1') =>
  JSON.stringify({ type: 'user', cwd, sessionId, message: { content: text } })
const asstLine = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-store-'))
  const roots: SessionRoots = {
    claudeProjects: join(dir, 'claude', 'projects'),
    codexSessions: join(dir, 'codex', 'sessions'),
    agentRuntime: join(dir, 'appsupport', 'unmute-agent'),
  }
  await fs.mkdir(join(roots.claudeProjects, '-Users-me-repo'), { recursive: true })
  await fs.mkdir(join(roots.codexSessions, '2026'), { recursive: true })
  const file = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
  await fs.writeFile(file, [userLine('cut the intro off the promo video'), asstLine('Trimmed 4 seconds.')].join('\n'))
  const store = new SessionStore({
    cachePath: join(dir, 'sessions', 'record.json'),
    roots,
    windowMs: 5 * 86_400_000,
  })
  return { dir, roots, file, store }
}

test('a refresh summarises what is on disk and survives a restart', async () => {
  const { dir, roots, store } = await fixture()
  try {
    const tally = await store.refresh(okModel(), JSON.parse)
    assert.equal(tally.updated, 1)

    const one = store.all()[0]!
    assert.equal(one.summary.about, 'Editing the promo video')
    assert.deepEqual(one.summary.done, ['cut the intro'])
    assert.equal(one.project, 'repo')
    assert.ok(one.cursor > 0)

    const reopened = new SessionStore({ cachePath: defaultCachePath(dir).replace('record.json', 'record.json'), roots })
    // Point at the same file the first store wrote.
    const again = new SessionStore({ cachePath: join(dir, 'sessions', 'record.json'), roots })
    await again.load()
    assert.equal(again.all().length, 1)
    assert.equal(again.all()[0]!.summary.about, 'Editing the promo video')
    void reopened
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** THE CURSOR CONTRACT: a transcript's bytes are parsed once, ever. */
test('an unchanged transcript costs no second model call', async () => {
  const { dir, store } = await fixture()
  try {
    await store.refresh(okModel(), JSON.parse)
    let calls = 0
    const counting = async () => { calls += 1; return { ok: true as const, output: answer() } }
    const tally = await store.refresh(counting, JSON.parse)
    assert.equal(calls, 0, 'nothing new means nothing summarised')
    assert.equal(tally.unchanged, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('new turns are summarised, and only the new ones', async () => {
  const { dir, file, store } = await fixture()
  try {
    await store.refresh(okModel(), JSON.parse)
    await fs.appendFile(file, `\n${userLine('now add titles')}\n${asstLine('Added titles.')}`)

    let seen = ''
    const capture = async (input: string) => {
      seen = input
      return { ok: true as const, output: answer({ done: ['added the titles'] }) }
    }
    const tally = await store.refresh(capture, JSON.parse)
    assert.equal(tally.updated, 1)
    assert.match(seen, /now add titles/)
    assert.doesNotMatch(seen, /USER: cut the intro off the promo video/, 'the first turns are not re-sent')
    assert.deepEqual(store.all()[0]!.summary.done, ['cut the intro', 'added the titles'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/**
 * A failed call that advanced the cursor would drop those turns forever and
 * leave a permanent hole. A failure must cost a retry and nothing else.
 */
test('a model failure does not advance the cursor', async () => {
  const { dir, store } = await fixture()
  try {
    const failed = await store.refresh(deadModel, JSON.parse)
    assert.equal(failed.failed, 1)
    assert.equal(store.all().length, 0, 'nothing half-written is recorded')

    const recovered = await store.refresh(okModel(), JSON.parse)
    assert.equal(recovered.updated, 1, 'the same turns are read again on the next sweep')
    assert.deepEqual(store.all()[0]!.summary.done, ['cut the intro'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a machine-issued session is skipped without a model call', async () => {
  const { dir, roots, store } = await fixture()
  try {
    await fs.writeFile(
      join(roots.claudeProjects, '-Users-me-repo', 'machine.jsonl'),
      [userLine('You are producing meeting notes from a cleaned transcript.'), asstLine('## Notes')].join('\n'),
    )
    let calls = 0
    await store.refresh(async () => { calls += 1; return { ok: true as const, output: answer() } }, JSON.parse)
    assert.equal(calls, 1, 'only the real session cost a call')
    assert.equal(store.all().length, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** The window governs what is brought up to date, never what is kept. */
test('a session older than the window keeps the summary it already has', async () => {
  const { dir, file, store } = await fixture()
  try {
    await store.refresh(okModel(), JSON.parse)
    const old = new Date(Date.now() - 30 * 86_400_000)
    await fs.utimes(file, old, old)

    let calls = 0
    const tally = await store.refresh(async () => { calls += 1; return { ok: true as const, output: answer() } }, JSON.parse)
    assert.equal(calls, 0, 'outside the window, nothing is regenerated')
    assert.equal(tally.updated, 0)
    assert.equal(store.all().length, 1, 'but it is still there')
    assert.equal(store.all()[0]!.summary.about, 'Editing the promo video')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a corrupt record is a cold start, not an error', async () => {
  const { dir, roots } = await fixture()
  try {
    const cachePath = join(dir, 'sessions', 'record.json')
    await fs.mkdir(dirname_(cachePath), { recursive: true })
    await fs.writeFile(cachePath, '{ not json')
    const store = new SessionStore({ cachePath, roots })
    const tally = await store.refresh(okModel(), JSON.parse)
    assert.equal(tally.updated, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a session is findable by harness id, task id or path', async () => {
  const { dir, store } = await fixture()
  try {
    await store.refresh(okModel(), JSON.parse)
    const one = store.all()[0]!
    assert.ok(store.find(one.sessionId!))
    assert.ok(store.find(one.path))
    assert.equal(store.find('nothing-like-this'), undefined)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a cursor follows the conversation, not the file', () => {
  assert.equal(conversationKey({ path: '/a/b.jsonl' }, 'sess-9'), 'sess-9')
  assert.equal(conversationKey({ path: '/a/b.jsonl' }), '/a/b.jsonl')
})

test('an abort stops a refresh partway', async () => {
  const { dir, roots, store } = await fixture()
  try {
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(
        join(roots.claudeProjects, '-Users-me-repo', `s${i}.jsonl`),
        [userLine(`session ${i}`, '/Users/me/repo', `sess-${i}`), asstLine('ok')].join('\n'),
      )
    }
    const signal = { aborted: false }
    let calls = 0
    const run = async () => { calls += 1; signal.aborted = true; return { ok: true as const, output: answer() } }
    await store.refresh(run, JSON.parse, { signal })
    assert.ok(calls < 7, 'it stopped rather than finishing the sweep')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

function dirname_(p: string): string { return p.slice(0, p.lastIndexOf('/')) }
