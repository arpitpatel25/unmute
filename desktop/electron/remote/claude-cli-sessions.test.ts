import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { listImportableSessions } from './claude-cli-sessions'

/** A fake ~/.claude/projects plus the real working directories it points at —
 *  both are needed, because a session whose project is gone is not offered. */
async function fixture(): Promise<{ root: string; work: string }> {
  const base = join(tmpdir(), 'unmute-cli-' + randomUUID())
  const root = join(base, 'projects')
  const work = join(base, 'work')
  const now = Date.now()
  // The dashed directory name is DELIBERATELY ambiguous: 'unmute-cloud' has a
  // dash in it, so reconstructing the path from this name gives the wrong
  // directory. Only the transcript's own `cwd` record gets it right.
  const mk = async (dir: string, id: string, title: string | null,
                    cwd: string | null, ageMs: number, size = 4096) => {
    const d = join(root, dir)
    await fs.mkdir(d, { recursive: true })
    const head = title ? JSON.stringify({ type: 'summary', aiTitle: title, sessionId: id }) : '{"type":"x"}'
    // cwd lives on a LATER record, as it does in a real transcript.
    const second = cwd ? JSON.stringify({ type: 'user', cwd }) : '{"type":"user"}'
    const body = head + '\n' + second + '\n'
    await fs.writeFile(join(d, id + '.jsonl'), body + 'x'.repeat(Math.max(0, size - body.length)) + '\n')
    const t = new Date(now - ageMs)
    await fs.utimes(join(d, id + '.jsonl'), t, t)
  }
  const real = join(work, 'unmute-cloud')
  const other = join(work, 'other')
  await fs.mkdir(real, { recursive: true })
  await fs.mkdir(other, { recursive: true })

  await mk('-w-unmute-cloud', 'aaa', 'Fix the notch geometry', real, 10 * 60_000)
  await mk('-w-unmute-cloud', 'bbb', 'Older thread', real, 3 * 60 * 60_000)
  await mk('-w-other', 'ccc', 'Another project', other, 30 * 60_000)
  await mk('-w-unmute-cloud', 'live', 'Still typing in it', real, 5_000)   // alive → skipped
  await mk('-private-tmp-probe3', 'ddd', 'Scratch probe', real, 10 * 60_000)              // temp → skipped
  await mk('-w-unmute-cloud', 'eee', 'Ancient', real, 60 * 24 * 60 * 60_000)         // old → skipped
  await mk('-w-unmute-cloud', 'fff', 'Abandoned', real, 10 * 60_000, 100)                 // tiny → skipped
  await mk('-w-deleted', 'ggg', 'Project deleted', join(work, 'gone'), 10 * 60_000)       // no cwd → skipped
  return { root, work }
}

test('offers real sessions, newest first, titled by Claude Code itself', async () => {
  const { root, work } = await fixture()
  const rows = await listImportableSessions(new Set(), { root })
  assert.deepEqual(rows.map((r) => r.sessionId), ['aaa', 'ccc', 'bbb'], 'sorted by last interaction')
  assert.equal(rows[0].title, 'Fix the notch geometry', 'the aiTitle on line 1, not a guess')
  // THE CWD COMES FROM THE TRANSCRIPT, NOT THE FOLDER NAME — and this is the
  // whole bug. `-w-unmute-cloud` reconstructs to `/w/unmute/cloud`, which does
  // not exist, and `resume()` bails silently on a cwd it cannot access. So an
  // imported session's Resume button did nothing, for every project with a
  // dash in its name.
  assert.equal(rows[0].cwd, join(work, 'unmute-cloud'))
  assert.equal(rows[0].project, 'unmute-cloud', 'and the group label is right as a consequence')
})

test('a session whose project is gone is not offered — Resume could not work', async () => {
  const { root } = await fixture()
  const ids = (await listImportableSessions(new Set(), { root })).map((r) => r.sessionId)
  assert.ok(!ids.includes('ggg'), 'offering it would be offering a button that does nothing')
})

test('a haystack is not a list — temp paths, stale and abandoned sessions are left out', async () => {
  // 745 transcripts on a real machine, of which a couple of dozen are work.
  const { root } = await fixture()
  const ids = (await listImportableSessions(new Set(), { root })).map((r) => r.sessionId)
  assert.ok(!ids.includes('ddd'), '/private/tmp is not a project')
  assert.ok(!ids.includes('eee'), 'older than the window is history')
  assert.ok(!ids.includes('fff'), 'opened and abandoned — a card with nothing behind it')
})

test('what unmute already has is never offered', async () => {
  const { root } = await fixture()
  const rows = await listImportableSessions(new Set(['aaa']), { root })
  assert.ok(!rows.some((r) => r.sessionId === 'aaa'), 'a row whose only job is done must not linger')
})

test('a missing ~/.claude is not an error — it is a machine without Claude Code', async () => {
  assert.deepEqual(await listImportableSessions(new Set(), { root: '/nope/nowhere' }), [])
})

test('a session someone is still typing in is never offered', async () => {
  // The first row this rail ever produced was the conversation the user was
  // having with us at that moment — newest mtime, so it sorted to the top.
  // `--resume` against a live process is not a resume.
  const { root } = await fixture()
  const ids = (await listImportableSessions(new Set(), { root })).map((r) => r.sessionId)
  assert.ok(!ids.includes('live'), 'freshly written means something is still in it')
  // And it is a HEURISTIC, not proof — with the window off, it is offered.
  const all = (await listImportableSessions(new Set(), { root, liveMs: 0 })).map((r) => r.sessionId)
  assert.ok(all.includes('live'))
})
