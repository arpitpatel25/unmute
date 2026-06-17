import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  scaffoldStatusFile,
  readStatus,
  isStale,
  statusMtimeMs,
  CURRENT_SCHEMA_VERSION,
} from './status-file.ts'

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-st-'))
  return path.join(dir, 'sub', 'status.json') // 'sub' ensures scaffold mkdir works
}

test('scaffold creates a processing file Unmute owns (PRD §6.1)', async () => {
  const f = await tmpFile()
  await scaffoldStatusFile(f)
  const s = await readStatus(f)
  assert.equal(s?.state, 'processing')
  assert.equal(s?.schema_version, CURRENT_SCHEMA_VERSION)
})

test('reader returns null on a half-written file (PRD #2 tolerant)', async () => {
  const f = await tmpFile()
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, '{ "state": "proce') // truncated mid-write
  assert.equal(await readStatus(f), null)
})

test('reader returns null when state missing/invalid', async () => {
  const f = await tmpFile()
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, JSON.stringify({ step: 'no state field here' }))
  assert.equal(await readStatus(f), null)
})

test('reader parses a done payload with inline result (PRD §13.4 #3)', async () => {
  const f = await tmpFile()
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, JSON.stringify({
    schema_version: 1,
    state: 'done',
    result: { summary: 'Extracted 12 files', artifacts: [{ type: 'path', value: '~/Downloads/report/' }] },
  }))
  const s = await readStatus(f)
  assert.equal(s?.state, 'done')
  assert.equal(s?.result?.summary, 'Extracted 12 files')
  assert.equal(s?.result?.artifacts?.[0].value, '~/Downloads/report/')
})

test('reader parses a needs-user question payload (PRD §7)', async () => {
  const f = await tmpFile()
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, JSON.stringify({
    state: 'needs-user',
    question: { text: 'Which Rishi?', kind: 'choice', choices: ['A', 'B'] },
  }))
  const s = await readStatus(f)
  assert.equal(s?.state, 'needs-user')
  assert.equal(s?.question?.text, 'Which Rishi?')
  assert.equal(s?.question?.choices?.length, 2)
})

test('isStale: ONLY processing can go stuck; needs-user/terminal never (PRD §6.3)', () => {
  const now = 1_000_000
  const FIVE_MIN = 5 * 60_000
  // processing + no heartbeat past threshold ⇒ stuck
  assert.equal(isStale({ state: 'processing' }, now - 6 * 60_000, now, FIVE_MIN), true)
  // processing but fresh ⇒ not stuck
  assert.equal(isStale({ state: 'processing' }, now - 2 * 60_000, now, FIVE_MIN), false)
  // needs-user is legitimately waiting on the human ⇒ NEVER stuck (the bug fix)
  assert.equal(isStale({ state: 'needs-user' }, now - 6 * 60_000, now, FIVE_MIN), false)
  assert.equal(isStale({ state: 'needs-user' }, now - 99 * 60_000, now, FIVE_MIN), false)
  // terminal states ⇒ never stuck
  assert.equal(isStale({ state: 'done' }, now - 99 * 60_000, now, FIVE_MIN), false)
  assert.equal(isStale({ state: 'failed' }, now - 99 * 60_000, now, FIVE_MIN), false)
})

test('statusMtimeMs returns a number for an existing file, null otherwise', async () => {
  const f = await tmpFile()
  await scaffoldStatusFile(f)
  assert.equal(typeof (await statusMtimeMs(f)), 'number')
  assert.equal(await statusMtimeMs(f + '.nope'), null)
})
