import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { listImportableSessions } from './claude-cli-sessions'

async function fixture(): Promise<string> {
  const root = join(tmpdir(), 'unmute-cli-' + randomUUID())
  const now = Date.now()
  const mk = async (dir: string, id: string, title: string | null, ageMs: number, size = 4096) => {
    const d = join(root, dir)
    await fs.mkdir(d, { recursive: true })
    const head = title ? JSON.stringify({ type: 'summary', aiTitle: title, sessionId: id }) : '{"type":"x"}'
    await fs.writeFile(join(d, id + '.jsonl'), head + '\n' + 'x'.repeat(Math.max(0, size - head.length)))
    const t = new Date(now - ageMs)
    await fs.utimes(join(d, id + '.jsonl'), t, t)
  }
  await mk('-Users-me-code-unmute-cloud', 'aaa', 'Fix the notch geometry', 60_000)
  await mk('-Users-me-code-unmute-cloud', 'bbb', 'Older thread', 3 * 60 * 60_000)
  await mk('-Users-me-code-other', 'ccc', 'Another project', 30 * 60_000)
  await mk('-private-tmp-probe3', 'ddd', 'Scratch probe', 60_000)          // temp → skipped
  await mk('-Users-me-code-unmute-cloud', 'eee', 'Ancient', 60 * 24 * 60 * 60_000) // old → skipped
  await mk('-Users-me-code-unmute-cloud', 'fff', 'Abandoned', 60_000, 100) // tiny → skipped
  return root
}

test('offers real sessions, newest first, titled by Claude Code itself', async () => {
  const root = await fixture()
  const rows = await listImportableSessions(new Set(), { root })
  assert.deepEqual(rows.map((r) => r.sessionId), ['aaa', 'ccc', 'bbb'], 'sorted by last interaction')
  assert.equal(rows[0].title, 'Fix the notch geometry', 'the aiTitle on line 1, not a guess')
  // THE PATH ENCODING IS LOSSY and this pins it rather than pretending
  // otherwise: ~/.claude/projects replaces every slash with a dash, so a
  // directory that legitimately contains a dash — `unmute-cloud` — is
  // indistinguishable from a separator and comes back as `unmute/cloud`.
  // The project label is therefore 'cloud', not 'unmute-cloud'. It is wrong
  // and it is the best available, because the information is gone before we
  // see it. Worth knowing if the grouping ever looks odd.
  assert.equal(rows[0].cwd, '/Users/me/code/unmute/cloud')
  assert.equal(rows[0].project, 'cloud')
})

test('a haystack is not a list — temp paths, stale and abandoned sessions are left out', async () => {
  // 745 transcripts on a real machine, of which a couple of dozen are work.
  const root = await fixture()
  const ids = (await listImportableSessions(new Set(), { root })).map((r) => r.sessionId)
  assert.ok(!ids.includes('ddd'), '/private/tmp is not a project')
  assert.ok(!ids.includes('eee'), 'older than the window is history')
  assert.ok(!ids.includes('fff'), 'opened and abandoned — a card with nothing behind it')
})

test('what unmute already has is never offered', async () => {
  const root = await fixture()
  const rows = await listImportableSessions(new Set(['aaa']), { root })
  assert.ok(!rows.some((r) => r.sessionId === 'aaa'), 'a row whose only job is done must not linger')
})

test('a missing ~/.claude is not an error — it is a machine without Claude Code', async () => {
  assert.deepEqual(await listImportableSessions(new Set(), { root: '/nope/nowhere' }), [])
})
