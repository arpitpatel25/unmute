// STOP MUST BE OFFERED WHILE WORK IS VISIBLY HAPPENING, AND MUST WORK WHEN IT IS.
//
// Field report: cards streaming output with no Stop button. The gate read the
// task's state and `alive`, both of which lag the runtime — a reattach that
// lost the turn-start, a disconnect that latched failed, a Codex error that
// did not actually end the turn. And kill() refused to interrupt Claude when
// its local projection read "not busy", marking the card failed while the
// daemon's turn ran on.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import { CodexHub } from './codex/hub'
import { ClaudeTaskChannel } from './claude/task-channel'
import { CLAUDE_RUNTIME_RELEASED } from './runtime/claude-service'
import { canStopTask, type TaskLite } from './notch/notch-controller'

const tick = () => new Promise(r => setTimeout(r, 5))

async function claudeManager(driver: Record<string, unknown>) {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-stop-'))
  const manager = new TaskManager({
    baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: () => ({ alive: true, followupBlocked: false, followupUnavailable: false,
      async start() {}, async send() { return { submissionId: 's', sessionId: 'x' } }, close() {}, detach() {}, ...driver } as never),
  })
  const id = await manager.dispatch('long running work', { agent: 'claude' })
  return { manager, id }
}

test('Claude Stop interrupts the runtime even when the local projection reads idle', async () => {
  let interrupts = 0
  const { manager, id } = await claudeManager({ busy: false, async interrupt() { interrupts++ } })
  assert.equal(manager.get(id)?.state, 'processing')
  manager.kill(id)
  await tick()
  assert.equal(interrupts, 1, 'the daemon is asked; its interrupt is a no-op when idle')
  // Nothing was running by the runtime's account: settle, never "failed".
  assert.equal(manager.get(id)?.state, 'done')
  assert.equal(manager.get(id)?.turnOutcome, 'cancelled')
  assert.equal(manager.get(id)?.codexActivity, undefined)
  manager.shutdown()
})

test('Claude Stop on a busy turn leaves settling to the result event', async () => {
  let interrupts = 0
  const { manager, id } = await claudeManager({ busy: true, async interrupt() { interrupts++ } })
  assert.equal(manager.turnActive(id), true)
  manager.kill(id)
  await tick()
  assert.equal(interrupts, 1)
  assert.equal(manager.get(id)?.state, 'processing')
  assert.equal(manager.get(id)?.codexActivity?.label, 'Cancelling')
  manager.shutdown()
})

test('Claude Stop with no daemon session falls back to marking the task stopped', async () => {
  const { manager, id } = await claudeManager({ busy: false, async interrupt() { throw new Error(CLAUDE_RUNTIME_RELEASED) } })
  manager.kill(id)
  await tick()
  assert.equal(manager.get(id)?.state, 'failed')
  assert.equal(manager.get(id)?.error?.reason, 'Stopped before the session connected')
  manager.shutdown()
})

test('Claude Stop surfaces an interrupt failure instead of pretending', async () => {
  const { manager, id } = await claudeManager({ busy: true, async interrupt() { throw new Error('socket closed') } })
  manager.kill(id)
  await tick()
  assert.match(manager.get(id)?.deliveryError ?? '', /Could not stop Claude: socket closed/)
  manager.shutdown()
})

test('a Claude reattach that finds the runtime busy re-presents the turn as working', async () => {
  const { manager, id } = await claudeManager({ busy: true, async interrupt() {} })
  // A stale channel state, as a disconnect leaves it.
  manager.applyHubPatch({ taskId: id, state: 'failed', errorReason: 'Background runtime connection lost' })
  assert.equal(manager.get(id)?.state, 'failed')
  ;(manager as any).claudeTasks.get(id).driver.alive = false
  assert.equal(await manager.resume(id), true)
  assert.equal(manager.get(id)?.state, 'processing')
  assert.equal(manager.get(id)?.error, undefined)
  manager.shutdown()
})

test('Claude channel: output after a transport error un-latches the ended turn', () => {
  const patches: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p))
  channel.event({ type: 'turn-start', submissionId: 'a' } as any)
  channel.event({ type: 'error', message: 'Background runtime connection lost; reconnect before sending again.' })
  assert.equal(patches.filter(p => p.state).at(-1).state, 'failed')
  channel.event({ type: 'message', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'still going' } } } } as any)
  assert.equal(patches.filter(p => p.state).at(-1).state, 'processing')
})

test('Claude channel: a result-ended turn is NOT resurrected by a late frame', () => {
  const patches: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p))
  channel.event({ type: 'turn-start', submissionId: 'a' } as any)
  channel.event({ type: 'result', submissionId: 'a', message: { is_error: false, result: 'ok' } } as any)
  channel.event({ type: 'message', message: { type: 'assistant', uuid: 'late', message: { content: [{ type: 'text', text: 'late' }] } } } as any)
  assert.equal(patches.filter(p => p.state).at(-1).state, 'done')
})

function codexFixture() {
  return (async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'unmute-stop-codex-'))
    let notify!: (m: any) => void, manager!: TaskManager
    const requests: string[] = []
    const server = {
      running: true, url: '', start: async () => {}, stop() { this.running = false },
      on(_name: string, h: any) { notify = h }, onRequest() {},
      request: async (method: string): Promise<any> => {
        requests.push(method)
        if (method === 'turn/start') return { turn: { id: 'turn-1' } }
        return { thread: { id: 'thread', turns: [] } }
      },
    }
    const hub = new CodexHub({ resolveBin: async () => 'fake', onPatch: p => manager.applyHubPatch(p), makeServer: () => server as any })
    manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, codexHub: hub })
    const id = await manager.createChat({ provider: 'codex' })
    await manager.deliverDraft(id, 'first', [])
    return { manager, hub, id, requests, notify: (m: any) => notify(m) }
  })()
}

test('Codex: a non-retry error mid-turn is un-latched when the turn keeps working', async () => {
  const h = await codexFixture()
  h.notify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn-1' } } })
  h.notify({ method: 'error', params: { threadId: 'thread', message: 'stream hiccup', willRetry: false } })
  assert.equal(h.manager.get(h.id)?.state, 'failed')
  assert.equal(h.manager.turnActive(h.id), true, 'Stop stays offered: the turn is still live')
  h.notify({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn-1', item: { type: 'commandExecution', id: 'c', command: 'ls' } } })
  assert.equal(h.manager.get(h.id)?.state, 'processing')
  h.notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
  assert.equal(h.manager.get(h.id)?.state, 'done')
  assert.equal(h.manager.turnActive(h.id), false)
  h.manager.shutdown()
})

test('Codex Stop interrupts a live turn', async () => {
  const h = await codexFixture()
  h.notify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn-1' } } })
  h.manager.kill(h.id)
  await tick()
  assert.ok(h.requests.includes('turn/interrupt'))
  assert.equal(h.manager.get(h.id)?.deliveryError, undefined)
  h.manager.shutdown()
})

test('Codex Stop with no turn to interrupt settles a stale working card instead of erroring', async () => {
  const h = await codexFixture()
  h.notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
  h.manager.applyHubPatch({ taskId: h.id, state: 'processing' }) // stale, as a missed event leaves it
  h.manager.kill(h.id)
  await tick()
  assert.ok(!h.requests.includes('turn/interrupt'))
  assert.equal(h.manager.get(h.id)?.state, 'done')
  assert.equal(h.manager.get(h.id)?.deliveryError, undefined)
  h.manager.shutdown()
})

test('canStopTask: offered whenever work is in flight on a task that is ours', () => {
  const base: TaskLite = { id: 't', intent: 'x', agent: 'claude', state: 'done' }
  assert.equal(canStopTask(base), false)
  assert.equal(canStopTask({ ...base, state: 'processing' }), true)
  assert.equal(canStopTask({ ...base, state: 'needs-user' }), true)
  // The bug: runtime busy while state reads failed/ready, alive false.
  assert.equal(canStopTask({ ...base, state: 'failed', turnActive: true, alive: false }), true)
  assert.equal(canStopTask({ ...base, agent: 'codex', state: 'ready', turnActive: true }), true)
  // Not ours to stop.
  assert.equal(canStopTask({ ...base, state: 'processing', chatOwned: false }), false)
  assert.equal(canStopTask({ ...base, agent: 'codex-desktop', state: 'processing' }), false)
  // The Agent's own chat keeps its own interrupt; cards it opened keep Stop.
  assert.equal(canStopTask({ ...base, id: 'unmute-agent', state: 'processing' }), false)
  assert.equal(canStopTask({ ...base, origin: 'unmute-agent', state: 'processing' }), true)
})
