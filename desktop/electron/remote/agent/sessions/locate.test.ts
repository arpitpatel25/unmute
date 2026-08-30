import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { defaultRoots, locateSession, type SessionRoots } from './locate.ts'

/**
 * The real layouts, which is the whole point of this module:
 *   claude  ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<sessionId>.jsonl
 */
async function roots(): Promise<SessionRoots & { dir: string }> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'agent-locate-'))
  const claudeProjects = join(dir, '.claude', 'projects')
  const codexSessions = join(dir, '.codex', 'sessions')
  await fs.mkdir(claudeProjects, { recursive: true })
  await fs.mkdir(codexSessions, { recursive: true })
  return { dir, claudeProjects, codexSessions }
}

async function writeClaude(r: SessionRoots, project: string, sessionId: string, body: string) {
  const dir = join(r.claudeProjects, project)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `${sessionId}.jsonl`), body)
}

async function writeCodex(r: SessionRoots, day: string, sessionId: string, body: string) {
  const dir = join(r.codexSessions, day)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `rollout-2026-08-30T10-13-29-${sessionId}.jsonl`), body)
}

test('a Claude session is found by the id its transcript is named after', async () => {
  const r = await roots()
  await writeClaude(r, '-Users-me-work', 'aaaaaaaa-1111-2222-3333-444444444444',
    '{"type":"user","sessionId":"aaaaaaaa-1111-2222-3333-444444444444","cwd":"/Users/me/work"}\n')

  const found = await locateSession('aaaaaaaa-1111-2222-3333-444444444444', r)

  assert.equal(found?.harness, 'claude')
  assert.equal(found?.sessionId, 'aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(found?.cwd, '/Users/me/work')
})

test('a Codex rollout is found by the id its filename ends with', async () => {
  const r = await roots()
  await writeCodex(r, '2026/08/30', '019f2123-9c04-73a1-919a-eaecdff9067f',
    '{"type":"session_meta","payload":{"session_id":"019f2123-9c04-73a1-919a-eaecdff9067f","cwd":"/Users/me/repo"}}\n')

  const found = await locateSession('019f2123-9c04-73a1-919a-eaecdff9067f', r)

  assert.equal(found?.harness, 'codex')
  assert.equal(found?.cwd, '/Users/me/repo')
})

/**
 * `cwd` is thousands of bytes into a Claude transcript and can be 20 MB into a
 * Codex one. The reader takes a prefix; it must be big enough to be useful and
 * must not read the whole file.
 */
test('cwd is recovered even when it is well past the first line', async () => {
  const r = await roots()
  const padding = `{"type":"noise","filler":"${'x'.repeat(20_000)}"}\n`
  await writeClaude(r, '-Users-me-work', 'bbbbbbbb-1111-2222-3333-444444444444',
    padding + '{"type":"user","cwd":"/Users/me/late"}\n')

  const found = await locateSession('bbbbbbbb-1111-2222-3333-444444444444', r)

  assert.equal(found?.cwd, '/Users/me/late')
})

/** A transcript that never states a cwd still locates — the caller decides. */
test('a session with no recoverable cwd is still found, without one', async () => {
  const r = await roots()
  await writeClaude(r, '-Users-me-work', 'cccccccc-1111-2222-3333-444444444444',
    '{"type":"mode","mode":"normal"}\n')

  const found = await locateSession('cccccccc-1111-2222-3333-444444444444', r)

  assert.equal(found?.harness, 'claude')
  assert.equal(found?.cwd, undefined)
})

test('an id that is on neither root is not found', async () => {
  const r = await roots()
  assert.equal(await locateSession('dddddddd-1111-2222-3333-444444444444', r), null)
})

/**
 * The id comes out of a transcript the Agent read, so a truncated or
 * hand-copied one is a real possibility. Resolving it to a NEIGHBOURING
 * session would resume the wrong conversation, which is worse than failing.
 */
test('a partial id does not resolve to the session it is a prefix of', async () => {
  const r = await roots()
  await writeClaude(r, '-Users-me-work', 'eeeeeeee-1111-2222-3333-444444444444', '{}\n')

  assert.equal(await locateSession('eeeeeeee-1111', r), null)
})

test('the roots are the two harnesses, under the given home', () => {
  const r = defaultRoots('/Users/me')
  assert.equal(r.claudeProjects, '/Users/me/.claude/projects')
  assert.equal(r.codexSessions, '/Users/me/.codex/sessions')
})

/**
 * The bound is the point: `readFile` here would pull a 26 GB tree through
 * memory one 21 MB rollout at a time. This pins the trade-off rather than the
 * number — a cwd stated beyond the prefix is given up on, deliberately.
 */
test('the read is bounded, so a cwd past the prefix is given up rather than chased', async () => {
  const r = await roots()
  const padding = `{"type":"noise","filler":"${'x'.repeat(80_000)}"}\n`
  await writeClaude(r, '-Users-me-work', 'ffffffff-1111-2222-3333-444444444444',
    padding + '{"type":"user","cwd":"/Users/me/far"}\n')

  const found = await locateSession('ffffffff-1111-2222-3333-444444444444', r)

  assert.equal(found?.harness, 'claude', 'the session is still located')
  assert.equal(found?.cwd, undefined, 'but the whole file was not read to find its cwd')
})
