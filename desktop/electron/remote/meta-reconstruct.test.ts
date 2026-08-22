import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  findCodexSessionByCwd,
  findClaudeSessionByCwd,
  readStatusSnapshot,
  reconstructTaskMeta,
  sniffLiveAgent,
  __readBoundedPrefix,
} from './meta-reconstruct'

async function home(): Promise<string> {
  const h = join(tmpdir(), 'meta-reconstruct-home-' + randomUUID())
  await fs.mkdir(join(h, '.codex', 'sessions', '2026', '08', '22'), { recursive: true })
  await fs.mkdir(join(h, '.codex', 'archived_sessions'), { recursive: true })
  await fs.mkdir(join(h, '.claude', 'projects'), { recursive: true })
  return h
}

const codexMeta = (cwd: string, sessionId: string) =>
  JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId, cwd, originator: 'Codex CLI' } })
const codexUserMsg = (text: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } })

// ── readStatusSnapshot ──────────────────────────────────────────────────────

test('readStatusSnapshot reads state + result summary from status.json', async () => {
  const dir = join(tmpdir(), 'status-' + randomUUID())
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'status.json'), JSON.stringify({
    state: 'done', updated_at: '2026-08-22T07:06:19.935Z',
    result: { summary: 'the answer', detail: 'the full answer' },
  }))
  const snap = await readStatusSnapshot(dir)
  assert.deepEqual(snap, { state: 'done', updatedAt: '2026-08-22T07:06:19.935Z', summary: 'the answer' })
})

test('readStatusSnapshot returns null when status.json is missing or empty', async () => {
  const dir = join(tmpdir(), 'status-missing-' + randomUUID())
  await fs.mkdir(dir, { recursive: true })
  assert.equal(await readStatusSnapshot(dir), null)
  await fs.writeFile(join(dir, 'status.json'), '')
  assert.equal(await readStatusSnapshot(dir), null)
})

// ── findCodexSessionByCwd ────────────────────────────────────────────────────

test('finds the codex rollout whose session_meta.cwd matches, and recovers the first user message as intent', async () => {
  const h = await home()
  const cwd = join(h, '.unmute', 'remote', 'local', 'some-task-id')
  const p = join(h, '.codex/sessions/2026/08/22', `rollout-2026-08-22T10-00-00-${randomUUID()}.jsonl`)
  await fs.writeFile(p, [
    codexMeta(cwd, '01a0284a-24c1-7090-8354-705bb12b7b28'),
    codexUserMsg('understand the note taking app granola'),
  ].join('\n') + '\n')

  const result = await findCodexSessionByCwd(cwd, h)
  assert.deepEqual(result, {
    agent: 'codex',
    sessionId: '01a0284a-24c1-7090-8354-705bb12b7b28',
    intent: 'understand the note taking app granola',
  })
})

test('ignores a rollout whose cwd does not match', async () => {
  const h = await home()
  const p = join(h, '.codex/sessions/2026/08/22', `rollout-2026-08-22T10-00-00-${randomUUID()}.jsonl`)
  await fs.writeFile(p, codexMeta('/some/other/project', randomUUID()) + '\n')
  assert.equal(await findCodexSessionByCwd('/the/task/we/actually/want', h), null)
})

test('checks archived_sessions too, not just live sessions', async () => {
  const h = await home()
  const cwd = join(h, '.unmute', 'remote', 'local', 'archived-task')
  const p = join(h, '.codex/archived_sessions', `rollout-2026-08-21T09-00-00-${randomUUID()}.jsonl`)
  await fs.writeFile(p, codexMeta(cwd, 'archived-id') + '\n')
  const result = await findCodexSessionByCwd(cwd, h)
  assert.equal(result?.sessionId, 'archived-id')
})

// THE HAZARD THIS EXISTS FOR. A live rollout keeps growing for as long as the
// session runs — one was seen at 26GB on this real machine. Reconstruction
// runs unconditionally on every app launch, so it must never read a whole
// rollout file into memory: session_meta is always near the top, and reading
// only a bounded prefix must still find it.
test('__readBoundedPrefix never reads past its cap, even on a huge file', async () => {
  const dir = join(tmpdir(), 'bounded-' + randomUUID())
  await fs.mkdir(dir, { recursive: true })
  const p = join(dir, 'huge.jsonl')
  const real = codexMeta('/repo', 'the-real-id')
  // Padding pushes the real content past a small cap — reading with that cap
  // must NOT see it.
  await fs.writeFile(p, 'x'.repeat(1000) + '\n' + real + '\n')
  const smallCap = await __readBoundedPrefix(p, 100)
  assert.ok(smallCap && !smallCap.includes('the-real-id'), 'capped read must not reach content past the cap')
  const bigCap = await __readBoundedPrefix(p, 1_000_000)
  assert.ok(bigCap?.includes('the-real-id'), 'a cap larger than the file must still read the real content')
})

// ── findClaudeSessionByCwd ───────────────────────────────────────────────────

test('finds the newest Claude transcript in the cwd-matching project slug, verifying cwd on the record itself', async () => {
  const h = await home()
  const cwd = '/Users/zodpatel/tools'
  const slugDir = join(h, '.claude', 'projects', '-Users-zodpatel-tools')
  await fs.mkdir(slugDir, { recursive: true })
  const sessionId = randomUUID()
  await fs.writeFile(join(slugDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'mode', sessionId }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'how many repos do we have' }, cwd, sessionId }),
  ].join('\n') + '\n')

  const result = await findClaudeSessionByCwd(cwd, h)
  assert.deepEqual(result, { agent: 'claude', sessionId, intent: 'how many repos do we have' })
})

test('rejects a slug-directory match whose actual recorded cwd differs (lossy slug collision)', async () => {
  const h = await home()
  // "/a/b-c" and "/a/b/c" collide under the lossy slug transform.
  const slugDir = join(h, '.claude', 'projects', '-a-b-c')
  await fs.mkdir(slugDir, { recursive: true })
  const sessionId = randomUUID()
  await fs.writeFile(join(slugDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'wrong project' }, cwd: '/a/b-c', sessionId }),
  ].join('\n') + '\n')

  assert.equal(await findClaudeSessionByCwd('/a/b/c', h), null)
})

test('handles Claude content as an array of text blocks, not just a plain string', async () => {
  const h = await home()
  const cwd = '/Users/zodpatel/tools/proj'
  const slugDir = join(h, '.claude', 'projects', '-Users-zodpatel-tools-proj')
  await fs.mkdir(slugDir, { recursive: true })
  const sessionId = randomUUID()
  await fs.writeFile(join(slugDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'array-shaped ask' }] }, cwd, sessionId }),
  ].join('\n') + '\n')

  const result = await findClaudeSessionByCwd(cwd, h)
  assert.equal(result?.intent, 'array-shaped ask')
})

// ── reconstructTaskMeta (orchestration) ─────────────────────────────────────

test('a home===cwd codex task fully recovers: agent, sessionId, intent, and is not degraded', async () => {
  const h = await home()
  const dir = join(h, '.unmute', 'remote', 'local', 'the-task')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'status.json'), JSON.stringify({ state: 'done', updated_at: 'x' }))
  const p = join(h, '.codex/sessions/2026/08/22', `rollout-${randomUUID()}.jsonl`)
  await fs.writeFile(p, [codexMeta(dir, 'sess-1'), codexUserMsg('the real question')].join('\n') + '\n')

  const result = await reconstructTaskMeta(dir, h)
  assert.deepEqual(result, { intent: 'the real question', agent: 'codex', sessionId: 'sess-1', state: 'done', degraded: false })
})

test('with no matching rollout/transcript, falls back to a DEGRADED record built from status.json alone', async () => {
  const h = await home()
  const dir = join(h, '.unmute', 'remote', 'local', 'orphaned-task')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'status.json'), JSON.stringify({
    state: 'done', updated_at: 'x', result: { summary: 'here is what I found' },
  }))

  const result = await reconstructTaskMeta(dir, h)
  assert.deepEqual(result, { intent: 'here is what I found', state: 'done', degraded: true })
})

test('with nothing recoverable anywhere — no rollout, no transcript, no status.json — returns null', async () => {
  const h = await home()
  const dir = join(h, '.unmute', 'remote', 'local', 'truly-gone')
  await fs.mkdir(dir, { recursive: true })
  assert.equal(await reconstructTaskMeta(dir, h, async () => null), null)
})

// ── sniffLiveAgent ───────────────────────────────────────────────────────────
// THE BUG THIS EXISTS FOR. Without this, a degraded reconstruction leaves
// `agent` unset, and the generic rehydrate path defaults a missing agent to
// 'claude' — mislabeling a task that is provably, right now, running Codex,
// because its tmux runtime survived and is still live. That runtime is the
// one fully-certain signal left once meta.json is gone.

test('sniffLiveAgent identifies codex from the live pane start command', async () => {
  const result = await sniffLiveAgent('task-1', async (_bin, args) => {
    assert.ok(args.includes('unmute-task-1'), 'must query the exact session for this task')
    return 'codex resume 01a027b9-37f4-72a3-8108-6aeb18843445 -c \'model="gpt-5.6-terra"\'\n'
  })
  assert.equal(result, 'codex')
})

test('sniffLiveAgent identifies claude from the live pane start command', async () => {
  const result = await sniffLiveAgent('task-1', async () => 'claude --model default --chrome\n')
  assert.equal(result, 'claude')
})

test('sniffLiveAgent returns null when there is no live session for this task', async () => {
  assert.equal(await sniffLiveAgent('task-1', async () => ''), null)
})

// ── reconstructTaskMeta: live agent as the last resort before degrading fully ──

test('reconstructTaskMeta correctly labels a still-running task even with no cwd match — a live Codex task must never come back mislabeled Claude', async () => {
  const h = await home()
  const dir = join(h, '.unmute', 'remote', 'local', 'still-alive-task')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'status.json'), JSON.stringify({ state: 'processing', updated_at: 'x' }))

  const result = await reconstructTaskMeta(dir, h, async () => 'codex')
  assert.deepEqual(result, { intent: 'Recovered task', agent: 'codex', state: 'processing', degraded: true })
})
