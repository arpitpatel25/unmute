import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RoutineAgentExecutor, type RoutineRunPair } from './executor'
import { definitionFromFields } from './definition'
import { routineConstitutionSection } from './prompt'
import type { RoutineDefinition } from './definition'
import type { RoutineRun } from './types'
import type { AgentInteractionInput, AgentInteractionResult, AgentSubmissionContext } from '../controller'

const readOnly: RoutineDefinition = definitionFromFields('daily-digest', {
  name: 'Daily digest',
  schedule: 'daily 09:00',
  prompt: 'Summarize yesterday.',
})
const takesActions: RoutineDefinition = definitionFromFields('reply-triage', {
  name: 'Reply triage',
  schedule: 'daily 09:00',
  prompt: 'Triage replies.',
  kind: 'takes-actions',
  provider: 'claude',
})

function fakeRun(definition: RoutineDefinition): RoutineRun {
  return {
    id: 'run-1', routineId: definition.id, name: definition.name, key: `${definition.id}@k`,
    kind: definition.kind, trigger: { type: 'manual' }, status: 'running', firedAt: 0,
    activity: [], posted: false, unread: false, speak: definition.speak,
  }
}

type SubmitFn = (input: AgentInteractionInput, context?: AgentSubmissionContext) => Promise<AgentInteractionResult>

function fakePair(submit?: SubmitFn, interrupt?: (id: string) => Promise<void>, closeRun?: (id: string) => Promise<void>) {
  const submitCalls: Array<{ input: AgentInteractionInput; context?: AgentSubmissionContext }> = []
  const interruptedRuns: string[] = []
  const closedRuns: string[] = []
  const pair: RoutineRunPair = {
    controller: {
      submit: async (input, context) => {
        submitCalls.push({ input, context })
        return (submit ?? defaultSubmit)(input, context)
      },
    },
    supervisor: {
      interrupt: async (runId) => {
        interruptedRuns.push(runId)
        if (interrupt) await interrupt(runId)
      },
      closeRun: async (runId) => {
        closedRuns.push(runId)
        if (closeRun) await closeRun(runId)
      },
    },
  }
  return { pair, submitCalls, interruptedRuns, closedRuns }
}

const defaultSubmit: SubmitFn = async (_input, context) => ({
  interactionId: context!.interactionId,
  agentRunId: context!.runId,
  provider: 'claude',
  source: 'provider',
  outcome: 'completed',
  presentation: 'transient',
  text: 'Shipped: nothing. In flight: nothing. Ideas: none.',
})

async function tmpRunDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'routines-'))
}

/** A promise plus its own resolver, for synchronizing on "submit was called"
 *  without polling the event loop — which is flaky under the full suite's
 *  concurrency, where fs I/O ahead of the call has no bounded latency. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function baseOptions(overrides: Partial<{
  reader: RoutineRunPair
  actor: RoutineRunPair
  environment: NodeJS.ProcessEnv
  readTools: () => readonly { name: string; description: string }[]
}> = {}) {
  const { pair } = fakePair()
  return {
    reader: overrides.reader ?? pair,
    actor: overrides.actor,
    baseConstitution: async () => 'BASE CONSTITUTION',
    readTools: overrides.readTools ?? (() => [{ name: 'routine_runs', description: 'recent runs' }]),
    mcp: () => ({ endpoint: 'http://127.0.0.1/mcp', config: '{"mcpServers":{}}' }),
    environment: overrides.environment ?? { PATH: '/usr/bin' },
  }
}

// ── the constitution file ───────────────────────────────────────────────

test('start writes <runDir>/constitution.md as the base constitution plus the routine section, mode 0o600', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair()
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({
    run: fakeRun(readOnly), definition: readOnly, transcript: 'go', runDir, provider: 'claude', onActivity: () => {},
  })
  const outcome = await handle.completion
  assert.equal(outcome.outcome, 'completed')

  const written = await fs.readFile(join(runDir, 'constitution.md'), 'utf8')
  assert.equal(written, `BASE CONSTITUTION\n\n${routineConstitutionSection(readOnly)}`)

  const stat = await fs.stat(join(runDir, 'constitution.md'))
  assert.equal(stat.mode & 0o777, 0o600)
})

test('reference snapshots stay in a private run file, not an oversized controller submission', async () => {
  const runDir = await tmpRunDir()
  const file = join(runDir, 'reference.md')
  await fs.writeFile(file, 'reference text '.repeat(10_000))
  const d = definitionFromFields('reference', { name: 'Reference', schedule: 'daily 09:00', prompt: 'Review', inputs: [],
    context: { folders: [], sessionIds: [], files: [file], excludedFolders: [], excludedSessionIds: [] } })
  const p = fakePair()
  const executor = new RoutineAgentExecutor(baseOptions({ reader: p.pair }))
  const outcome = await executor.start({ run: fakeRun(d), definition: d, transcript: 'Review', runDir, provider: 'claude', onActivity() {} }).completion
  assert.equal(outcome.outcome, 'completed')
  assert.match(p.submitCalls[0]!.input.transcript, /references.jsonl/)
  assert.ok(p.submitCalls[0]!.input.transcript.length < 1000)
  const snapshot = join(runDir, 'references.jsonl')
  assert.match(await fs.readFile(snapshot, 'utf8'), /reference text/)
  assert.equal((await fs.stat(snapshot)).mode & 0o777, 0o600)
})

// ── the submit context ──────────────────────────────────────────────────

test('the submit context carries the run dir as cwd/constitutionPath and the read-only capability list', async () => {
  const runDir = await tmpRunDir()
  const { pair, submitCalls } = fakePair()
  const executor = new RoutineAgentExecutor(baseOptions({
    reader: pair,
    environment: { PATH: '/usr/bin', UNMUTE_MCP_TOKEN: 'tok' },
    readTools: () => [{ name: 'routine_runs', description: 'recent runs' }, { name: 'routine_list', description: 'every routine' }],
  }))
  const handle = executor.start({
    run: fakeRun(readOnly), definition: readOnly, transcript: 'Summarize.', runDir, provider: 'claude', onActivity: () => {},
  })
  await handle.completion

  assert.equal(submitCalls.length, 1)
  const { input, context } = submitCalls[0]!
  assert.equal(input.transcript, 'Summarize.')
  assert.equal(context?.runId, handle.agentRunId)
  assert.equal(context?.provider, 'claude')
  assert.equal(context?.runtime?.cwd, runDir)
  assert.equal(context?.runtime?.constitutionPath, join(runDir, 'constitution.md'))
  assert.deepEqual(context?.runtime?.environment, { PATH: '/usr/bin', UNMUTE_MCP_TOKEN: 'tok' })
  assert.deepEqual(context?.capabilities, [
    { name: 'routine_runs', description: 'recent runs' },
    { name: 'routine_list', description: 'every routine' },
  ])
})

// ── outcome mapping ─────────────────────────────────────────────────────

test('completed + text maps to an outcome of completed carrying the text', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(async (_i, context) => ({
    interactionId: context!.interactionId, agentRunId: context!.runId, provider: 'claude',
    source: 'provider', outcome: 'completed', presentation: 'transient', text: 'Done for today.',
    providerSessionId: 'sess-1',
  }))
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.deepEqual(outcome, {
    outcome: 'completed', text: 'Done for today.', agentRunId: handle.agentRunId, providerSessionId: 'sess-1',
  })
})

test('an interrupted controller outcome maps straight through as interrupted', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(async (_i, context) => ({
    interactionId: context!.interactionId, agentRunId: context!.runId, source: 'provider',
    outcome: 'interrupted', presentation: 'transient',
  }))
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.deepEqual(outcome, { outcome: 'interrupted', agentRunId: handle.agentRunId })
})

test('a controller failure result maps to failed, carrying the error message', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(async (_i, context) => ({
    interactionId: context!.interactionId, agentRunId: context!.runId, source: 'provider',
    outcome: 'failed', presentation: 'transient', error: { code: 'provider-crashed', message: 'The Agent provider stopped unexpectedly.' },
  }))
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.deepEqual(outcome, {
    outcome: 'failed', error: 'The Agent provider stopped unexpectedly.', agentRunId: handle.agentRunId,
  })
})

test('a completed result with no error and no text still falls to failed, with the fallback message', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(async (_i, context) => ({
    interactionId: context!.interactionId, agentRunId: context!.runId, source: 'provider',
    outcome: 'completed', presentation: 'transient',
  }))
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.deepEqual(outcome, { outcome: 'failed', error: 'The routine did not complete.', agentRunId: handle.agentRunId })
})

test('a thrown submit maps to failed, carrying the thrown message', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(async () => { throw new Error('spawn ENOENT') })
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.deepEqual(outcome, { outcome: 'failed', error: 'spawn ENOENT', agentRunId: handle.agentRunId })
})

// ── cancel ──────────────────────────────────────────────────────────────

test('cancel calls supervisor.interrupt with the agentRunId, and the eventual settle reports interrupted', async () => {
  const runDir = await tmpRunDir()
  const started = deferred<void>()
  let release: ((result: AgentInteractionResult) => void) | undefined
  const { pair, interruptedRuns } = fakePair((_i, context) => new Promise((resolve) => {
    release = () => resolve({
      interactionId: context!.interactionId, agentRunId: context!.runId, source: 'provider',
      outcome: 'interrupted', presentation: 'transient',
    })
    started.resolve()
  }))
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  await started.promise // let start()'s async work reach the submit call before cancelling it
  await handle.cancel()
  assert.deepEqual(interruptedRuns, [handle.agentRunId])
  release!({} as AgentInteractionResult)
  const outcome = await handle.completion
  assert.equal(outcome.outcome, 'interrupted')
})

test('cancel never throws, even when interrupt rejects because the run was never accepted', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(defaultSubmit, async () => { throw new Error('run-not-found') })
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  await assert.doesNotReject(handle.cancel())
  const outcome = await handle.completion
  // The submit itself completed successfully, but the cancel intent was
  // recorded because interrupt could not reach a live run — the settle must
  // still be reported as interrupted, not as a stray completion.
  assert.equal(outcome.outcome, 'interrupted')
})

// ── closeRun ────────────────────────────────────────────────────────────

test('closeRun is called with the agentRunId once the run settles', async () => {
  const runDir = await tmpRunDir()
  const { pair, closedRuns } = fakePair()
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  await handle.completion
  await new Promise((r) => setImmediate(r)) // closeRun is fire-and-forget after settle
  assert.deepEqual(closedRuns, [handle.agentRunId])
})

test('a closeRun failure after settle is swallowed and never changes the outcome', async () => {
  const runDir = await tmpRunDir()
  const { pair } = fakePair(defaultSubmit, undefined, async () => { throw new Error('journal unavailable') })
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.equal(outcome.outcome, 'completed')
})

// ── reader vs. actor ────────────────────────────────────────────────────

test('a takes-actions routine runs through the actor pair, never the reader', async () => {
  const runDir = await tmpRunDir()
  const { pair: reader } = fakePair(async () => { throw new Error('the reader must never be used for takes-actions') })
  const { pair: actor, submitCalls } = fakePair()
  const executor = new RoutineAgentExecutor(baseOptions({ reader, actor }))
  const handle = executor.start({ run: fakeRun(takesActions), definition: takesActions, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.equal(outcome.outcome, 'completed')
  assert.equal(submitCalls.length, 1)
})

test('a read-only routine runs through the reader pair, never the actor', async () => {
  const runDir = await tmpRunDir()
  const { pair: actor } = fakePair(async () => { throw new Error('the actor must never be used for read-only') })
  const { pair: reader, submitCalls } = fakePair()
  const executor = new RoutineAgentExecutor(baseOptions({ reader, actor }))
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.equal(outcome.outcome, 'completed')
  assert.equal(submitCalls.length, 1)
})

test('a takes-actions routine with no actor pair fails fast, without touching the reader or the filesystem', async () => {
  const runDir = await tmpRunDir()
  const { pair: reader } = fakePair(async () => { throw new Error('the reader must never run a takes-actions routine') })
  const executor = new RoutineAgentExecutor(baseOptions({ reader }))
  const handle = executor.start({ run: fakeRun(takesActions), definition: takesActions, transcript: 't', runDir, provider: 'claude', onActivity: () => {} })
  const outcome = await handle.completion
  assert.deepEqual(outcome, { outcome: 'failed', error: 'Takes-actions routines need Claude', agentRunId: handle.agentRunId })
  await assert.rejects(fs.stat(join(runDir, 'constitution.md')))
})

// ── activity routing ────────────────────────────────────────────────────

test('routeActivity dispatches to the onActivity callback registered for that agentRunId, and only that one', async () => {
  const runDir = await tmpRunDir()
  const started = deferred<void>()
  let release: ((result: AgentInteractionResult) => void) | undefined
  const { pair } = fakePair((_i, context) => new Promise((resolve) => {
    release = () => resolve({
      interactionId: context!.interactionId, agentRunId: context!.runId, source: 'provider',
      outcome: 'completed', presentation: 'transient', text: 'ok',
    })
    started.resolve()
  }))
  const executor = new RoutineAgentExecutor(baseOptions({ reader: pair }))
  const seen: string[] = []
  const handle = executor.start({ run: fakeRun(readOnly), definition: readOnly, transcript: 't', runDir, provider: 'claude', onActivity: (text) => seen.push(text) })
  await started.promise

  executor.routeActivity({ interactionId: 'i1', agentRunId: handle.agentRunId, kind: 'tool', summary: 'Reading a file' })
  executor.routeActivity({ interactionId: 'i2', agentRunId: 'some-other-run', kind: 'tool', summary: 'must not appear' })
  assert.deepEqual(seen, ['Reading a file'])

  release!({} as AgentInteractionResult)
  await handle.completion
  // Deregistered once settled: routing to it again is a silent no-op.
  executor.routeActivity({ interactionId: 'i3', agentRunId: handle.agentRunId, kind: 'tool', summary: 'after settle' })
  assert.deepEqual(seen, ['Reading a file'])
})
