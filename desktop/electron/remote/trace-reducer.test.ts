import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locateTranscript, transcriptPathFor, resolveTranscriptById, reduceTranscript } from './trace-reducer.ts'

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

test('transcriptPathFor: deterministic <projectsDir>/<cwd-slug>/<sessionId>.jsonl', () => {
  const cwd = '/Users/x/repos/my_proj'
  const p = transcriptPathFor(cwd, 'sess-abc', { projectsDir: '/PROJ' })
  // slug replaces every run of non-alphanumerics with '-', so the same cwd maps
  // to the same folder regardless of which session id is appended.
  assert.equal(p, path.join('/PROJ', '-Users-x-repos-my-proj', 'sess-abc.jsonl'))
  const q = transcriptPathFor(cwd, 'sess-def', { projectsDir: '/PROJ' })
  assert.equal(path.dirname(p), path.dirname(q))     // same folder…
  assert.notEqual(p, q)                              // …DIFFERENT file per conversation (no collapse)
})

test('resolveTranscriptById: returns the path when the file exists, null when it does not', async () => {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'))
  const cwd = '/Users/x/shared-repo'
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-')
  await fs.mkdir(path.join(projects, slug), { recursive: true })
  // Two sessions in the SAME cwd → two distinct files; each resolves to its OWN.
  await fs.writeFile(path.join(projects, slug, 'sA.jsonl'), '{}')
  await fs.writeFile(path.join(projects, slug, 'sB.jsonl'), '{}')
  assert.equal(await resolveTranscriptById(cwd, 'sA', { projectsDir: projects }), path.join(projects, slug, 'sA.jsonl'))
  assert.equal(await resolveTranscriptById(cwd, 'sB', { projectsDir: projects }), path.join(projects, slug, 'sB.jsonl'))
  assert.equal(await resolveTranscriptById(cwd, 'sMissing', { projectsDir: projects }), null)   // not written yet
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

test('reduceTranscript distills GUI/browser actions to semantics — drops pixel coordinates', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'n1', name: 'mcp__claude-in-chrome__navigate', input: { tabId: 3, url: 'https://x.com/compose/post' } },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'c1', name: 'mcp__claude-in-chrome__computer', input: { action: 'left_click', tabId: 3, coordinate: [834, 221] } },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'c2', name: 'mcp__claude-in-chrome__computer', input: { action: 'left_click', tabId: 3, coordinate: [410, 980] } },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'c3', name: 'mcp__claude-in-chrome__computer', input: { action: 'type', tabId: 3, text: 'hello world' } },
    ] } }),
  ].join('\n')
  const out = reduceTranscript(jsonl)
  // pixel coordinates must NOT survive — they are brittle and useless to the librarian
  assert.doesNotMatch(out, /834|221|410|980|coordinate/, 'raw coordinates must be stripped')
  // the SEMANTIC signal must survive: the entry URL and the action verbs
  assert.match(out, /NAV https:\/\/x\.com\/compose\/post/, 'navigation URL is the semantic entry point')
  assert.match(out, /UI left_click/, 'click actions kept as semantic verbs')
  assert.match(out, /UI type.*hello world/, 'typed text kept, coordinates not')
  // consecutive identical UI actions collapse so clicks do not drown the trace
  assert.match(out, /UI left_click \(x2\)/, 'repeated identical UI actions collapse with a count')
})

test('reduceTranscript tolerates malformed lines', () => {
  const out = reduceTranscript('not json\n{"broken":')
  assert.equal(typeof out, 'string', 'must return a string')
  assert.doesNotMatch(out, /not valid json — the reducer must tolerate this line/, 'malformed line content must not appear in output')
})
