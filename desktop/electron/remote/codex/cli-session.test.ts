import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { findRollout, readRolloutEvents, discoverSessionId, listImportableCodexSessions } from './cli-session'

const UUID_A = '019fccd9-d64b-7142-bf79-f721387b9e97'
const UUID_B = '019fccd9-aaaa-7142-bf79-f721387b9e98'

async function home(): Promise<string> {
  const h = join(tmpdir(), 'codex-home-' + randomUUID())
  await fs.mkdir(join(h, '.codex', 'sessions', '2026', '08', '09'), { recursive: true })
  await fs.mkdir(join(h, '.codex', 'archived_sessions'), { recursive: true })
  return h
}
const meta = (cwd: string, id: string, ts: string) =>
  JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { session_id: id, cwd, timestamp: ts, originator: 'Codex CLI' } })

test('finds a rollout whether it is live or archived', async () => {
  const h = await home()
  const live = join(h, '.codex/sessions/2026/08/09', `rollout-2026-08-09T10-00-00-${UUID_A}.jsonl`)
  const arch = join(h, '.codex/archived_sessions', `rollout-2026-08-09T09-00-00-${UUID_B}.jsonl`)
  await fs.writeFile(live, meta('/repo', UUID_A, '2026-08-09T10:00:00.000Z') + '\n')
  await fs.writeFile(arch, meta('/repo', UUID_B, '2026-08-09T09:00:00.000Z') + '\n')
  assert.equal(await findRollout(UUID_A, h), live)
  // Archived MID-TASK must stay readable, or the card freezes on its last
  // known state with nothing logged.
  assert.equal(await findRollout(UUID_B, h), arch)
})

test('a half-written trailing line is normal, not a parse failure', async () => {
  // Codex is appending to this file while we read it.
  const h = await home()
  const p = join(h, '.codex/sessions/2026/08/09', `rollout-x-${UUID_A}.jsonl`)
  await fs.writeFile(p, meta('/repo', UUID_A, '2026-08-09T10:00:00.000Z') + '\n{"type":"event_msg","pay')
  const events = await readRolloutEvents(p)
  assert.equal(events.length, 1, 'the good line survives; the fragment is dropped')
})

test('discovery needs BOTH the cwd and a start after our spawn', async () => {
  // cwd alone would adopt whatever conversation the user already had open in
  // that repo — someone else's session, silently, reported as our task.
  const h = await home()
  const dir = join(h, '.codex/sessions/2026/08/09')
  const theirs = join(dir, `rollout-old-${UUID_B}.jsonl`)
  await fs.writeFile(theirs, meta('/repo', UUID_B, '2026-08-09T09:00:00.000Z') + '\n')
  await fs.utimes(theirs, new Date('2026-08-09T09:00:00Z'), new Date('2026-08-09T09:00:00Z'))

  const spawnedAt = Date.parse('2026-08-09T10:00:00.000Z')
  assert.equal(await discoverSessionId('/repo', spawnedAt, h), null, 'a pre-existing session is not ours')

  const ours = join(dir, `rollout-new-${UUID_A}.jsonl`)
  await fs.writeFile(ours, meta('/repo', UUID_A, '2026-08-09T10:00:05.000Z') + '\n')
  assert.equal(await discoverSessionId('/repo', spawnedAt, h), UUID_A)
})

test('a session in a DIFFERENT directory is never adopted', async () => {
  const h = await home()
  const p = join(h, '.codex/sessions/2026/08/09', `rollout-new-${UUID_A}.jsonl`)
  await fs.writeFile(p, meta('/somewhere/else', UUID_A, '2026-08-09T10:00:05.000Z') + '\n')
  assert.equal(await discoverSessionId('/repo', Date.parse('2026-08-09T10:00:00.000Z'), h), null)
})

test('no ~/.codex at all is not an error', async () => {
  assert.equal(await findRollout(UUID_A, '/nope/nowhere'), null)
  assert.equal(await discoverSessionId('/repo', Date.now(), '/nope/nowhere'), null)
})

test('the import list offers Codex sessions, titled by what you actually asked', async () => {
  // Claude writes an aiTitle; Codex writes none. The first user_message is the
  // honest stand-in — it is what the person asked for, which beats anything we
  // would invent and costs no model.
  const h = await home()
  const cwd = join(h, 'project')
  await fs.mkdir(cwd, { recursive: true })
  const p = join(h, '.codex/sessions/2026/08/09', `rollout-old-${UUID_A}.jsonl`)
  await fs.writeFile(p, [
    meta(cwd, UUID_A, '2026-08-09T09:00:00.000Z'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'refactor the notch geometry' } }),
  ].join('\n') + '\n')
  const old = new Date(Date.now() - 60 * 60_000)
  await fs.utimes(p, old, old)

  const rows = await listImportableCodexSessions(new Set(), { home: h })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'refactor the notch geometry')
  assert.equal(rows[0].cwd, cwd, 'authoritative, from session_meta — nothing reconstructed')
  assert.equal(rows[0].project, 'project')
})

test('already-imported, still-live, and vanished-project sessions are not offered', async () => {
  const h = await home()
  const cwd = join(h, 'project')
  await fs.mkdir(cwd, { recursive: true })
  const dir = join(h, '.codex/sessions/2026/08/09')
  const write = async (id: string, at: number, where = cwd) => {
    const p = join(dir, `rollout-x-${id}.jsonl`)
    await fs.writeFile(p, meta(where, id, '2026-08-09T09:00:00.000Z') + '\n')
    await fs.utimes(p, new Date(at), new Date(at))
    return p
  }
  const hour = Date.now() - 60 * 60_000
  await write(UUID_A, hour)
  await write(UUID_B, Date.now())                                  // live
  await write('019fccd9-cccc-7142-bf79-f721387b9e99', hour, join(h, 'gone'))  // no cwd

  const ids = (await listImportableCodexSessions(new Set([UUID_A]), { home: h })).map((r) => r.sessionId)
  assert.deepEqual(ids, [], 'known, live and cwd-less are all excluded')
})
