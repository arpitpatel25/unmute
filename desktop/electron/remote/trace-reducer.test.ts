import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locateTranscript, reduceTranscript } from './trace-reducer.ts'

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

test('reduceTranscript distills tool calls + outcomes from the real fixture', async () => {
  const jsonl = await fs.readFile(new URL('./fixtures/sample-transcript.jsonl', import.meta.url), 'utf8')
  const out = reduceTranscript(jsonl)
  assert.ok(out.length > 0, 'output must be non-empty')
  assert.ok(out.length < jsonl.length, 'output must be shorter than input (compression)')
  assert.doesNotMatch(out, /usage|cache_creation/, 'token metadata must be dropped')
  assert.match(out, /TOOL Bash/, 'must include Bash tool call')
  assert.match(out, /TOOL Read/, 'must include Read tool call')
  assert.match(out, /ERROR/, 'must include ERROR marker from failed Read result')
  assert.match(out, /SAY:.*Done/, 'must include final assistant SAY')
})

test('reduceTranscript tolerates malformed lines', () => {
  const out = reduceTranscript('not json\n{"broken":')
  assert.equal(typeof out, 'string', 'must return a string')
  assert.doesNotMatch(out, /not valid json — the reducer must tolerate this line/, 'malformed line content must not appear in output')
})
