import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PocketCapability, type PocketAdapters, type PocketTaskEntry } from './pocket.ts'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types.ts'

const NOW = 10_000
const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 20_000, provider: 'claude',
}
const ctx: CapabilityCallContext = {
  principal: agent, now: NOW, interaction: { id: 'ix-1', active: true, transcript: 'end the one where I fixed the mic' },
}
function parse(r: ToolResult): any { return JSON.parse(String(r.content[0]!.text)) }

const MIC: PocketTaskEntry = {
  taskId: 'task-mic', title: 'New conversation', intent: 'the mic cuts out on AirPods, fix it', state: 'processing',
  working: true, live: true, provider: 'claude', updatedAt: 9_000, recentUserTurns: ['try the quiet gate again'],
}

/** A pocket holding exactly the given tasks. Every write refuses anything else. */
function pocket(entries: PocketTaskEntry[] = [MIC]): PocketAdapters & { asked: any[] } {
  const asked: any[] = []
  const held = (taskId: string) => entries.find(entry => entry.taskId === taskId)
  return {
    asked,
    async list() { asked.push({ op: 'list' }); return entries },
    async rename(input) { asked.push({ op: 'rename', ...input }); return held(input.taskId) ? { taskId: input.taskId, name: input.name } : null },
    async stop(input) {
      asked.push({ op: 'stop', ...input })
      const entry = held(input.taskId)
      if (!entry) return null
      return entry.working ? { taskId: input.taskId, stopped: true } : { taskId: input.taskId, stopped: false, message: 'It was not running a turn, so there was nothing to stop.' }
    },
    async end(input) { asked.push({ op: 'end', ...input }); return held(input.taskId) ? { taskId: input.taskId, ended: true } : null },
    async hide(input) { asked.push({ op: 'hide', ...input }); return held(input.taskId) ? { taskId: input.taskId, hidden: true } : null },
  }
}

test('pocket_list returns what a loose description is matched against, in one call', async () => {
  const result = parse(await new PocketCapability(pocket()).call(ctx, 'pocket_list', {}))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, [MIC])
})

test('pocket_list is a read: it needs no active interaction', async () => {
  const idle: CapabilityCallContext = { principal: agent, now: NOW }
  assert.equal((await new PocketCapability(pocket()).call(idle, 'pocket_list', {})).isError, undefined)
})

test('each write acts on a pocket task and reports what it did', async () => {
  const a = pocket()
  const c = new PocketCapability(a)
  assert.deepEqual(parse(await c.call(ctx, 'task_rename', { taskId: 'task-mic', name: '  Mic fix  ' })).result, { taskId: 'task-mic', name: 'Mic fix' })
  assert.deepEqual(parse(await c.call(ctx, 'task_stop', { taskId: 'task-mic' })).result, { taskId: 'task-mic', stopped: true })
  assert.deepEqual(parse(await c.call(ctx, 'task_end', { taskId: 'task-mic' })).result, { taskId: 'task-mic', ended: true })
  assert.deepEqual(parse(await c.call(ctx, 'task_hide', { taskId: 'task-mic' })).result, { taskId: 'task-mic', hidden: true })
  assert.deepEqual(a.asked.map(entry => entry.op), ['rename', 'stop', 'end', 'hide'])
})

test('a rename is cut to the card\'s 48 characters', async () => {
  const a = pocket()
  await new PocketCapability(a).call(ctx, 'task_rename', { taskId: 'task-mic', name: 'x'.repeat(100) })
  assert.equal(a.asked[0].name.length, 48)
})

test('stopping a task that is not working is benign, not an error', async () => {
  const idle = { ...MIC, state: 'done', working: false }
  const result = await new PocketCapability(pocket([idle])).call(ctx, 'task_stop', { taskId: 'task-mic' })
  assert.equal(result.isError, undefined)
  assert.equal(parse(result).result.stopped, false)
  assert.match(parse(result).result.message, /not running/)
})

test('a task that is not in the pocket is refused, and the refusal says not to retry', async () => {
  for (const tool of ['task_rename', 'task_stop', 'task_end', 'task_hide']) {
    const result = parse(await new PocketCapability(pocket()).call(ctx, tool, { taskId: 'task-elsewhere', name: 'x' }))
    assert.equal(result.ok, false, tool)
    assert.equal(result.error.code, 'not-in-pocket', tool)
    assert.match(result.error.message, /No task with that id is in the pocket\. Do not retry; tell the person\./)
  }
})

test('the Agent\'s own slot is not a task, and is refused before the app is asked', async () => {
  for (const tool of ['task_rename', 'task_stop', 'task_end', 'task_hide']) {
    const a = pocket()
    const result = parse(await new PocketCapability(a).call(ctx, tool, { taskId: 'unmute-agent', name: 'x' }))
    assert.equal(result.error.code, 'not-a-task', tool)
    assert.deepEqual(a.asked, [], tool)
  }
})

test('writes need an active interaction and a valid id', async () => {
  const a = pocket()
  const c = new PocketCapability(a)
  const idle: CapabilityCallContext = { principal: agent, now: NOW, interaction: { id: 'ix-1', active: false } }
  assert.equal(parse(await c.call(idle, 'task_end', { taskId: 'task-mic' })).error.code, 'access-denied')
  assert.equal(parse(await c.call(ctx, 'task_end', {})).error.code, 'invalid-input')
  assert.equal(parse(await c.call(ctx, 'task_end', { taskId: 'x'.repeat(129) })).error.code, 'invalid-input')
  assert.equal(parse(await c.call(ctx, 'task_rename', { taskId: 'task-mic', name: '   ' })).error.code, 'invalid-input')
  assert.deepEqual(a.asked, [])
})

test('a failure in the app is reported once, with no retry', async () => {
  const a = pocket()
  a.end = async () => { throw new Error('Could not stop Codex, so the session was not ended.') }
  const result = parse(await new PocketCapability(a).call(ctx, 'task_end', { taskId: 'task-mic' }))
  assert.equal(result.error.code, 'end-failed')
  assert.match(result.error.message, /Do not retry/)
})

test('only the Agent holds the pocket tools, and none of them is destructive', () => {
  const capability = new PocketCapability(pocket())
  assert.deepEqual([...capability.roles], ['unmute-agent'])
  // NOT 'destructive': that needs an intent flag voice never supplies, and
  // nothing here deletes — rename, stop, end and hide all leave the task.
  assert.deepEqual(Object.fromEntries(capability.tools.map(t => [t.name, t.consequence])), {
    pocket_list: 'read',
    task_rename: 'reversible-write',
    task_stop: 'reversible-write',
    task_end: 'reversible-write',
    task_hide: 'reversible-write',
  })
})

test('an expired or non-Agent principal is refused', async () => {
  const expired: CapabilityCallContext = { ...ctx, now: 30_000 }
  assert.equal(parse(await new PocketCapability(pocket()).call(expired, 'pocket_list', {})).error.code, 'access-denied')
})

/**
 * session_close promised "closes the CARD and nothing else" while the app
 * called manager.remove() — the UI's confirmed destructive "Remove…". init.ts
 * pulls in the whole remote stack and cannot be imported by a unit test, so the
 * guard reads the function itself.
 */
test('session_close hides the card and never deletes the task', () => {
  const source = readFileSync(new URL('../../init.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function closeAgentSession(')
  assert.ok(start > 0)
  const body = source.slice(start, source.indexOf('\n}\n', start))
  assert.doesNotMatch(body, /\.remove\(/)
  assert.match(body, /hideFromPocket\(taskId\)/)
})
