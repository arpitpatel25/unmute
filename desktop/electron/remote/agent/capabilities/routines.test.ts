import test from 'node:test'
import assert from 'node:assert/strict'

import { RoutinesCapability, type RoutinesServiceLike } from './routines'
import { CapabilityRegistry } from './registry'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types'
import type { RoutineFields } from '../routines/definition'
import type { RoutineItemView, RoutineRun } from '../routines/types'

const NOW = 10_000
const agent: McpPrincipal = { kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 20_000, provider: 'claude' }
const ctx: CapabilityCallContext = { principal: agent, now: NOW, interaction: { id: 'ix-1', active: true } }

function parse(r: ToolResult): any { return JSON.parse(String(r.content[0]!.text)) }

function item(overrides: Partial<RoutineItemView> = {}): RoutineItemView {
  return {
    id: 'morning-recap', name: 'Morning recap', scheduleLabel: 'Daily at 09:00', kind: 'read-only',
    enabled: true, nextRunAt: 1_000, nextRunLabel: 'Today 09:00', running: false,
    window: 'yesterday-or-last-run', path: '/root/routines/morning-recap.md', ...overrides,
  }
}

function run(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 'run-1', routineId: 'morning-recap', name: 'Morning recap', key: 'k', kind: 'read-only',
    trigger: { type: 'manual' }, status: 'done', firedAt: 1_000, endedAt: 2_000,
    activity: [], posted: true, unread: false, speak: false, resultPreview: 'Shipped X.',
    resultPath: '/root/routines/runs/run-1/result.md', ...overrides,
  }
}

interface FakeService extends RoutinesServiceLike {
  calls: Array<{ method: string; args: unknown[] }>
}

function fakeService(overrides: Partial<RoutinesServiceLike> = {}): FakeService {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string, args: unknown[]) => calls.push({ method, args })
  return {
    calls,
    list: (...args) => { record('list', args); return [item()] },
    create: async (...args) => { record('create', args); return { item: item(), definitionPath: item().path } },
    update: async (...args) => { record('update', args); return item() },
    remove: async (...args) => { record('remove', args) },
    setEnabled: async (...args) => { record('setEnabled', args) },
    runNow: async (...args) => { record('runNow', args); return run({ status: 'queued' }) },
    runs: (...args) => { record('runs', args); return [run()] },
    result: async (...args) => { record('result', args); return 'Full result text.' },
    ...overrides,
  } as FakeService
}

test('exposes exactly the spec tools with the right consequence classes', () => {
  const cap = new RoutinesCapability(fakeService())
  assert.deepEqual(cap.tools.map(t => [t.name, t.consequence]), [
    ['routine_list', 'read'],
    ['routine_runs', 'read'],
    ['routine_create', 'reversible-write'],
    ['routine_update', 'reversible-write'],
    ['routine_pause', 'reversible-write'],
    ['routine_resume', 'reversible-write'],
    ['routine_delete', 'reversible-write'],
    ['routine_run_now', 'reversible-write'],
  ])
  assert.equal(cap.id, 'routines')
  assert.deepEqual(cap.roles, ['unmute-agent'])
})

test('routine_list returns the service view as-is', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_list', {})
  assert.deepEqual(parse(result), [item()])
  assert.equal(service.calls[0]!.method, 'list')
})

test('routine_create validates locally and comes back as isError text, never a throw', async () => {
  const cap = new RoutinesCapability(fakeService())
  const bad = [
    {},
    { name: 'x' },
    { name: 'x', schedule: 's' },
    { name: 5, schedule: 's', prompt: 'p' },
    { name: 'x', schedule: 's', prompt: 'p', kind: 'nope' },
    { name: 'x', schedule: 's', prompt: 'p', maxMinutes: 'ten' },
    { name: 'x', schedule: 's', prompt: 'p', speak: 'yes' },
    { name: 'x', schedule: 's', prompt: 'p', extra: 1 },
  ]
  for (const input of bad) {
    const result = await cap.call(ctx, 'routine_create', input)
    assert.equal(result.isError, true, JSON.stringify(input))
    assert.equal(typeof result.content[0]!.text, 'string')
  }
})

test("a validation error thrown by the service itself is returned as isError text, not thrown", async () => {
  const service = fakeService({
    create: async () => { throw new Error('"weekdys 09:00" is not a schedule; try "weekdays 09:00", "every 4 hours" or "on meeting-notes-ready"') },
  })
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_create', { name: 'Recap', schedule: 'weekdys 09:00', prompt: 'p' })
  assert.equal(result.isError, true)
  assert.equal(result.content[0]!.text, '"weekdys 09:00" is not a schedule; try "weekdays 09:00", "every 4 hours" or "on meeting-notes-ready"')
})

test('routine_create returns the parsed preview, with window taken verbatim from the item the service returns', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_create', { name: 'Morning recap', schedule: 'daily 09:00', prompt: 'Tell me what I did.' })
  assert.deepEqual(parse(result), {
    id: 'morning-recap', name: 'Morning recap', schedule: 'Daily at 09:00',
    window: 'yesterday-or-last-run', kind: 'read-only', nextRun: 'Today 09:00', file: item().path,
  })
  const [fields] = service.calls[0]!.args as [RoutineFields]
  assert.equal(fields.name, 'Morning recap')
  assert.equal(fields.schedule, 'daily 09:00')
})

test('routine_create never recomputes the window — it reports whatever RoutineItemView.window the service resolved', async () => {
  const service = fakeService({
    create: async () => ({
      item: item({ window: 'none', scheduleLabel: 'When meeting notes are ready', nextRunLabel: 'After your next meeting' }),
      definitionPath: item().path,
    }),
  })
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_create', { name: 'Recap', schedule: 'on meeting-notes-ready', prompt: 'p' })
  assert.equal(parse(result).window, 'none')

  const cap2 = new RoutinesCapability(fakeService({ create: async () => ({ item: item({ window: 'last 3 days' }), definitionPath: item().path }) }))
  const explicit = await cap2.call(ctx, 'routine_create', { name: 'Recap', schedule: 'daily 09:00', prompt: 'p', window: 'last 3 days' })
  assert.equal(parse(explicit).window, 'last 3 days')
})

test('routine_update sends only the id and the given fields, and reports the new preview', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_update', { id: 'morning-recap', schedule: 'daily 10:30' })
  assert.deepEqual(parse(result), {
    id: 'morning-recap', name: 'Morning recap', schedule: 'Daily at 09:00',
    window: 'yesterday-or-last-run', kind: 'read-only', nextRun: 'Today 09:00', file: item().path,
  })
  assert.deepEqual(service.calls[0]!.args, ['morning-recap', { schedule: 'daily 10:30' }])
})

// Fix for task-8 review round 1: a rename-only update used to report a RECOMPUTED default window
// ('yesterday-or-last-run') instead of the routine's actual persisted one, because the capability
// had no way to see it. RoutineItemView.window now carries the service's own canonical text, and
// the capability just relays it — so a rename that touches neither window nor schedule still shows
// the true, previously-set 'last 3 days'.
test('routine_update that only renames still reports the actual persisted window, never a recomputed default', async () => {
  const updateCalls: unknown[] = []
  const service = fakeService({
    update: async (...args: unknown[]) => { updateCalls.push(args); return item({ name: 'Morning recap v2', window: 'last 3 days' }) },
  })
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_update', { id: 'morning-recap', name: 'Morning recap v2' })
  assert.equal(parse(result).window, 'last 3 days')
  assert.deepEqual(updateCalls[0], ['morning-recap', { name: 'Morning recap v2' }])
})

test('an unknown id on any id-based tool is refused with the exact required sentence', async () => {
  const notFound = () => { throw new Error('Routine "ghost" was not found') }
  const service = fakeService({ update: notFound, setEnabled: notFound, remove: notFound, runNow: notFound })
  const cap = new RoutinesCapability(service)
  for (const [tool, input] of [
    ['routine_update', { id: 'ghost', name: 'x' }],
    ['routine_pause', { id: 'ghost' }],
    ['routine_resume', { id: 'ghost' }],
    ['routine_delete', { id: 'ghost' }],
    ['routine_run_now', { id: 'ghost' }],
  ] as const) {
    const result = await cap.call(ctx, tool, input)
    assert.equal(result.isError, true, tool)
    assert.equal(result.content[0]!.text, 'No routine with id "ghost". Use routine_list.', tool)
  }
})

test('routine_pause and routine_resume call setEnabled with the right flag', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  const paused = await cap.call(ctx, 'routine_pause', { id: 'morning-recap' })
  assert.deepEqual(parse(paused), { id: 'morning-recap', enabled: false })
  assert.deepEqual(service.calls[0]!.args, ['morning-recap', false])

  const resumed = await cap.call(ctx, 'routine_resume', { id: 'morning-recap' })
  assert.deepEqual(parse(resumed), { id: 'morning-recap', enabled: true })
  assert.deepEqual(service.calls[1]!.args, ['morning-recap', true])
})

test('routine_delete moves the routine to trash and reports it', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_delete', { id: 'morning-recap' })
  assert.deepEqual(parse(result), { id: 'morning-recap', status: 'deleted' })
  assert.deepEqual(service.calls[0]!.args, ['morning-recap'])
})

test('routine_run_now returns the runId and status from the new run', async () => {
  const service = fakeService({ runNow: async () => run({ id: 'run-42', status: 'queued' }) })
  const cap = new RoutinesCapability(service)
  const result = await cap.call(ctx, 'routine_run_now', { id: 'morning-recap' })
  assert.deepEqual(parse(result), { runId: 'run-42', status: 'queued' })
})

test('routine_runs shapes each run and attaches full result text only for the newest min(limit,5) done runs', async () => {
  const runs = [
    run({ id: 'r7', status: 'done', firedAt: 7_000, endedAt: 7_100, resultPreview: 'seven' }),
    run({ id: 'r6', status: 'done', firedAt: 6_000, endedAt: 6_100, resultPreview: 'six' }),
    run({ id: 'r5', status: 'done', firedAt: 5_000, endedAt: 5_100, resultPreview: 'five' }),
    run({ id: 'r4', status: 'failed', firedAt: 4_000, endedAt: 4_100, resultPreview: undefined, resultPath: undefined, error: 'boom' }),
    run({ id: 'r3', status: 'done', firedAt: 3_000, endedAt: 3_100, resultPreview: 'three' }),
    run({ id: 'r2', status: 'done', firedAt: 2_000, endedAt: 2_100, resultPreview: 'two' }),
    run({ id: 'r1', status: 'done', firedAt: 1_000, endedAt: 1_100, resultPreview: 'one' }),
  ]
  // All seven would resolve to text if asked; the cap must stop the lookup itself at 5, not rely on missing stubs.
  const resultTexts: Record<string, string> = Object.fromEntries(runs.map(r => [r.id, `RESULT ${r.id}`]))
  const resultCalls: string[] = []
  const service = fakeService({
    runs: () => runs,
    result: async (runId: string) => { resultCalls.push(runId); return resultTexts[runId] ?? null },
  })
  const cap = new RoutinesCapability(service)
  const parsed = parse(await cap.call(ctx, 'routine_runs', {}))

  assert.equal(parsed.length, 7)
  assert.deepEqual(parsed[0], {
    runId: 'r7', routine: 'Morning recap', status: 'done',
    firedAt: new Date(7_000).toISOString(), endedAt: new Date(7_100).toISOString(),
    preview: 'seven', resultPath: run().resultPath, result: 'RESULT r7',
  })
  // r4 is done-ineligible (failed), so it never gets a `result` key regardless of the cap.
  assert.equal(parsed[3].runId, 'r4')
  assert.equal('result' in parsed[3], false)
  // r7,r6,r5,r3,r2 are the 5 newest DONE runs (r4 does not count) — all get full text.
  for (const id of ['r7', 'r6', 'r5', 'r3', 'r2']) {
    const entry = parsed.find((p: any) => p.runId === id)
    assert.equal(entry.result, `RESULT ${id}`, id)
  }
  // r1 is the 6th-newest done run, outside min(limit,5)=5 — the lookup is never made for it.
  const oldest = parsed.find((p: any) => p.runId === 'r1')
  assert.equal('result' in oldest, false)
  assert.deepEqual([...resultCalls].sort(), ['r2', 'r3', 'r5', 'r6', 'r7'])
})

test('routine_runs respects an explicit id filter and a limit between 1 and 20', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  await cap.call(ctx, 'routine_runs', { id: 'morning-recap', limit: 3 })
  assert.deepEqual(service.calls[0]!.args, [{ routineId: 'morning-recap', limit: 3 }])

  for (const limit of [0, 21, 1.5, 'ten']) {
    const result = await cap.call(ctx, 'routine_runs', { limit })
    assert.equal(result.isError, true, String(limit))
  }
})

test('an expired or non-agent principal is refused before any service call', async () => {
  const service = fakeService()
  const cap = new RoutinesCapability(service)
  const expired: CapabilityCallContext = { principal: { ...agent, expiresAt: 0 }, now: NOW }
  const result = await cap.call(expired, 'routine_list', {})
  assert.equal(result.isError, true)
  assert.equal(service.calls.length, 0)
})

test('through a real CapabilityRegistry, routine_create needs an active interaction but routine_list does not', async () => {
  const registry = new CapabilityRegistry([new RoutinesCapability(fakeService())])
  await assert.rejects(
    registry.call(agent, 'routine_create', { name: 'x', schedule: 'daily 09:00', prompt: 'p' }, { now: NOW }),
    /active explicit interaction/,
  )
  const listed = await registry.call(agent, 'routine_list', {}, { now: NOW })
  assert.equal(listed.isError, undefined)
  assert.deepEqual(parse(listed), [item()])
})
