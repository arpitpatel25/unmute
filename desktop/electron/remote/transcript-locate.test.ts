import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { findTranscriptById } from './transcript-locate'

/**
 * THE FIELD FAILURE THIS EXISTS FOR (2026-08-30).
 *
 * Task 87083840 was dispatched with `--session-id 1f9cd2d0…` and cwd
 * `/Users/zodpatel/tools/unmute/unmute-cloud`. Claude wrote the transcript
 * there, Unmute resolved it, and the card was correct for 77 blocks.
 *
 * Then the session entered a git worktree. Claude files a transcript under the
 * project folder for its CURRENT cwd, so it MOVED the file to
 * `…unmute-cloud--claude-worktrees-session-record-rebuild/`. The id never
 * changed; the folder did.
 *
 * On the next app relaunch the derived path resolved to nothing, the caller
 * fell back to "newest .jsonl in the folder", and bound the card to a
 * different, live session — 5.4 MB of someone else's conversation, tracked
 * live because the watcher followed it too.
 *
 * The filename is the id and the id is unique. Searching for it is the fix.
 */

async function projects(): Promise<string> {
  return fs.mkdtemp(join(os.tmpdir(), 'transcript-locate-'))
}

async function write(root: string, slug: string, sessionId: string, body = '{}\n') {
  const dir = join(root, slug)
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(path, body)
  return path
}

const CWD = '/Users/me/work/repo'
const SLUG = '-Users-me-work-repo'
const WORKTREE_SLUG = '-Users-me-work-repo--claude-worktrees-feature'

test('finds the transcript in the folder the cwd points at', async () => {
  const root = await projects()
  const expected = await write(root, SLUG, 'aaaa1111')

  assert.equal(await findTranscriptById(CWD, 'aaaa1111', { projectsDir: root }), expected)
})

/** The whole point: the session moved, the id did not. */
test('finds it after the session moved into a worktree', async () => {
  const root = await projects()
  await fs.mkdir(join(root, SLUG), { recursive: true })
  const moved = await write(root, WORKTREE_SLUG, 'bbbb2222')

  assert.equal(await findTranscriptById(CWD, 'bbbb2222', { projectsDir: root }), moved)
})

/**
 * NEVER ANOTHER SESSION'S FILE. A sibling in the same folder — the exact shape
 * that put one card on another card's conversation — must not be returned.
 */
test('returns nothing rather than a neighbour when the id is absent', async () => {
  const root = await projects()
  await write(root, SLUG, 'someone-elses-live-session', '{"lots":"of content"}\n')

  assert.equal(await findTranscriptById(CWD, 'cccc3333', { projectsDir: root }), null)
})

test('an id present in no project folder resolves to nothing', async () => {
  const root = await projects()
  assert.equal(await findTranscriptById(CWD, 'dddd4444', { projectsDir: root }), null)
})

/** A truncated or partial id must not match the session it is a prefix of. */
test('a partial id does not match the session it prefixes', async () => {
  const root = await projects()
  await write(root, SLUG, 'eeee5555-full-identifier')

  assert.equal(await findTranscriptById(CWD, 'eeee5555', { projectsDir: root }), null)
})

/**
 * The derived path is checked first and must WIN, so the ordinary case stays
 * one stat rather than a directory walk.
 */
test('prefers the cwd folder when the same id somehow exists in two', async () => {
  const root = await projects()
  const home = await write(root, SLUG, 'ffff6666', '{"which":"home"}\n')
  await write(root, WORKTREE_SLUG, 'ffff6666', '{"which":"worktree"}\n')

  assert.equal(await findTranscriptById(CWD, 'ffff6666', { projectsDir: root }), home)
})

test('a missing projects directory is not an error', async () => {
  assert.equal(
    await findTranscriptById(CWD, 'aaaa1111', { projectsDir: '/nope/not/here' }),
    null,
  )
})

/** The default root must actually resolve — the tests above all pass an
 *  explicit projectsDir, so nothing else exercises the import. */
test('the default projects directory is the real one', async () => {
  const { defaultProjectsDir } = await import('./trace-reducer')
  assert.equal(typeof defaultProjectsDir, 'function')
  assert.match(defaultProjectsDir(), /\.claude\/projects$/)
})
