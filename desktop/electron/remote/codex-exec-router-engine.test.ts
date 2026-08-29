import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexExecRouterEngine } from './codex-exec-router-engine.ts'

import { EventEmitter } from 'node:events'

/** Stands in for `codex exec`: records argv + stdio, and writes whatever the
 *  test wants into the -o file, which is how the real CLI returns its answer. */
function fakeCodex(write: unknown | null) {
  const seen: { args: string[]; stdio: unknown }[] = []
  const fn = ((_cmd: string, args: string[], opts: { stdio?: unknown }) => {
    seen.push({ args, stdio: opts?.stdio })
    const child = new EventEmitter() as EventEmitter & { kill: () => void }
    child.kill = () => child.emit('exit', 143)
    const i = args.indexOf('-o')
    const out = args[i + 1]
    setTimeout(() => {
      if (write === null) { child.emit('exit', 1); return }
      void fs.writeFile(out, JSON.stringify(write)).then(() => child.emit('exit', 0))
    }, 5)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { fn, seen }
}

async function engine(write: unknown | null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-exec-router-'))
  const { fn, seen } = fakeCodex(write)
  return { eng: new CodexExecRouterEngine({ dir, spawnFn: fn }), seen, dir }
}

test('warm writes the schema Codex will enforce', async () => {
  const { eng, dir } = await engine({})
  await eng.warm()
  const s = JSON.parse(await fs.readFile(path.join(dir, 'decision.schema.json'), 'utf8')) as Record<string, unknown>
  assert.equal(s.additionalProperties, false)
  // Strict mode: every property must also be required, or the API 400s.
  assert.deepEqual(new Set(s.required as string[]), new Set(Object.keys(s.properties as object)))
})

test('runs headless, read-only, with the schema bound to the response', async () => {
  const { eng, seen } = await engine({ action: 'new', intent: 'x' })
  await eng.decide('route this')
  const a = seen[0].args.join(' ')
  assert.match(a, /^exec /)
  assert.match(a, /--output-schema /)
  assert.match(a, /--sandbox read-only/)      // the router reads and writes nothing
  assert.match(a, /--skip-git-repo-check/)
  eng.dispose()
})

test('the decision comes back compacted, with strict-mode nulls stripped', async () => {
  const { eng } = await engine({
    action: 'new', intent: 'plan reddit marketing', name: 'Reddit marketing plan',
    group: 'unmute marketing', kind: 'session',
    targetTaskId: null, dir: null, surface: null, alternate: null, contextTaskId: null, ops: null,
  })
  const raw = await eng.decide('route this')
  const d = JSON.parse(raw!) as Record<string, unknown>
  assert.equal(d.group, 'unmute marketing')
  assert.ok(!('targetTaskId' in d))
  eng.dispose()
})

test('a failed exec returns null rather than throwing into the router', async () => {
  const { eng } = await engine(null)
  assert.equal(await eng.decide('route this'), null)
  eng.dispose()
})

test('each route gets its own output file — two can never cross', async () => {
  const { eng, seen } = await engine({ action: 'new', intent: 'x' })
  await eng.decide('one')
  await eng.decide('two')
  const outs = seen.map((s) => s.args[s.args.indexOf('-o') + 1])
  assert.notEqual(outs[0], outs[1])
})

test('the output file is cleaned up, success or failure', async () => {
  const { eng, seen, dir } = await engine({ action: 'new', intent: 'x' })
  await eng.decide('one')
  const out = seen[0].args[seen[0].args.indexOf('-o') + 1]
  assert.ok(!(await fs.readdir(dir)).includes(path.basename(out)))
})

test('stdin is CLOSED, or codex waits on it forever', () => {
  // Observed live (28 Aug): with an open stdin pipe, codex prints "Reading
  // additional input from stdin..." and blocks until the timeout, because the
  // prompt is already in argv and EOF never arrives. The whole Codex lane
  // silently produced nothing until this was found.
  return engine({ action: 'new', intent: 'x' }).then(async ({ eng, seen }) => {
    await eng.decide('route this')
    assert.deepEqual(seen[0].stdio, ['ignore', 'ignore', 'pipe'])
    eng.dispose()
  })
})
