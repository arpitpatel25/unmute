import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locateTranscript } from './trace-reducer.ts'

test('locateTranscript finds the jsonl whose project dir encodes the taskId', async () => {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'))
  const taskId = '11111111-2222-3333-4444-555555555555'
  const encoded = `-Users-x--unmute-remote-local-${taskId}`
  await fs.mkdir(path.join(projects, encoded), { recursive: true })
  await fs.writeFile(path.join(projects, encoded, 'sess.jsonl'), '{}')
  const taskCwd = `/Users/x/.unmute/remote/local/${taskId}`
  const found = await locateTranscript(taskCwd, { projectsDir: projects })
  assert.equal(found, path.join(projects, encoded, 'sess.jsonl'))
})

test('locateTranscript returns null when absent', async () => {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'))
  const found = await locateTranscript('/Users/x/.unmute/remote/local/nope', { projectsDir: projects })
  assert.equal(found, null)
})
