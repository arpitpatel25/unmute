import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexPersistentProcess, CodexRequestRejected, isolatedCodexHome } from './codex-persistent'
import type { AgentProcessEvent, AgentProcessLaunch } from '../provider'

const id = '11111111-1111-4111-8111-111111111111'
const launch: AgentProcessLaunch = {
  provider: 'codex', binary: 'codex', argv: [], cwd: '/private/unmute/runtime', taskId: 'agent',
  environment: { UNMUTE_MCP_ENDPOINT: 'http://127.0.0.1/mcp', UNMUTE_MCP_TOKEN: 'session-token' },
  systemContext: { type: 'file', path: '/private/unmute/runtime/constitution.md' }, session: { kind: 'fresh' },
}

test('an explicit turn/start refusal is known unaccepted, while a transport failure remains uncertain', async () => {
  for (const [error, uncertain] of [[new CodexRequestRejected(-32600, 'request refused'), false], [new Error('Codex transport closed'), true]] as const) {
    const driver = new CodexPersistentProcess({ readSystemPrompt: async () => 'C', connect: async () => ({
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id }, approvalPolicy: 'never', sandbox: { type: 'readOnly' } } as never
        if (method === 'turn/start') throw error
        return {} as never
      }, notify() {}, close: async () => {},
    }) })
    await driver.start(launch)
    await assert.rejects(driver.submitUserTurn('hello'), error)
    assert.equal(driver.hasDispatched, uncertain)
    await driver.close()
  }
})

test('Codex holds one structured connection across turns and filters completion by exact turn', async () => {
  const requests: Array<{ method: string; params: any }> = []
  let connections = 0, closes = 0, turns = 0
  let notification!: (method: string, params: any) => void
  const audit: Array<{ event: string; fields: any }> = []
  const driver = new CodexPersistentProcess({ audit: (event, fields) => audit.push({ event, fields }), readSystemPrompt: async () => 'EXACT CONSTITUTION', connect: async (_launch, notify) => {
    connections++; notification = notify
    return { request: async (method, params: any) => {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id }, model: 'model', approvalPolicy: 'never', sandbox: { type: 'readOnly' } } as any
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } } as any
      return {} as any
    }, notify() {}, close: async () => { closes++ } }
  } })
  const events: AgentProcessEvent[] = []
  const collecting = (async () => { for await (const event of driver.events) events.push(event) })()
  await driver.start(launch)
  await driver.submitUserTurn('one')
  notification('item/started', { threadId: id, turnId: 'turn-1', item: { id: 'tool-1', type: 'mcpToolCall', server: 'unmute', tool: 'sessions_fork', arguments: { token: 'private-input' } } })
  notification('item/completed', { threadId: id, turnId: 'turn-1', item: { id: 'tool-1', type: 'mcpToolCall', server: 'unmute', tool: 'sessions_fork', result: 'private-output' } })
  notification('turn/completed', { threadId: id, turn: { id: 'stale', status: 'completed' } })
  notification('item/completed', { threadId: id, turnId: 'turn-1', item: { type: 'agentMessage', text: 'first answer' } })
  notification('turn/completed', { threadId: id, turn: { id: 'turn-1', status: 'completed' } })
  await driver.submitUserTurn('two')
  await driver.interrupt()
  notification('turn/completed', { threadId: id, turn: { id: 'turn-2', status: 'interrupted' } })
  await driver.close(); await collecting
  assert.equal(connections, 1)
  assert.equal(audit.filter(e => e.event === 'agent-provider-item').length, 3)
  assert.ok(audit.some(e => e.fields.itemId === 'tool-1' && e.fields.phase === 'completed'))
  assert.ok(!JSON.stringify(audit).includes('private-input'))
  assert.ok(!JSON.stringify(audit).includes('private-output'))
  assert.equal(closes, 1)
  assert.deepEqual(events.filter(e => e.type === 'completion'), [
    { type: 'completion', outcome: 'completed', finalText: 'first answer' },
    { type: 'completion', outcome: 'interrupted' },
  ])
  assert.equal(events.filter(e => e.type === 'handle' && e.observed).length, 2)
  const setup = requests.find(r => r.method === 'thread/start')!.params
  assert.equal(setup.developerInstructions, 'EXACT CONSTITUTION')
  assert.equal(setup.approvalPolicy, 'never')
  assert.equal(setup.sandbox, 'read-only')
  assert.deepEqual(Object.keys(setup.config.mcp_servers), ['unmute'])
  assert.equal(setup.config.mcp_servers.unmute.bearer_token_env_var, 'UNMUTE_MCP_TOKEN')
  assert.deepEqual(requests.filter(r => r.method === 'turn/start').map(r => r.params.input[0].text), ['one', 'two'])
  assert.deepEqual(requests.at(-1), { method: 'turn/interrupt', params: { threadId: id, turnId: 'turn-2' } })
})

test('private Codex home shares only login and native history, leaving user config and rules untouched', async () => {
  const originalHome = await fs.mkdtemp(join(tmpdir(), 'codex-home-test-'))
  let isolated: Awaited<ReturnType<typeof isolatedCodexHome>> | undefined
  try {
    await fs.mkdir(join(originalHome, '.codex'))
    await assert.rejects(isolatedCodexHome(originalHome), /auth.json/)
    await fs.writeFile(join(originalHome, '.codex/auth.json'), '{}')
    await fs.writeFile(join(originalHome, '.codex/config.toml'), 'unrelated = true')
    isolated = await isolatedCodexHome(originalHome)
    assert.deepEqual((await fs.readdir(isolated.path)).sort(), ['archived_sessions', 'auth.json', 'sessions'])
    assert.equal(await fs.readlink(join(isolated.path, 'auth.json')), join(originalHome, '.codex/auth.json'))
    assert.equal(await fs.readlink(join(isolated.path, 'sessions')), join(originalHome, '.codex/sessions/unmute-agent'))
    assert.equal(await fs.readFile(join(originalHome, '.codex/config.toml'), 'utf8'), 'unrelated = true')
  } finally { await isolated?.dispose(); await fs.rm(originalHome, { recursive: true, force: true }) }
})

function fallbackDriver(opts: { available?: string[]; failFor?: Record<string, { codexErrorInfo: unknown; message: string }> }) {
  const requests: Array<{ method: string; params: any }> = []
  let notification!: (method: string, params: any) => void
  let turns = 0
  const driver = new CodexPersistentProcess({ readSystemPrompt: async () => 'C', connect: async (_launch, notify) => {
    notification = notify
    return { request: async (method, params: any) => {
      requests.push({ method, params })
      if (method === 'model/list') return { data: (opts.available ?? []).map(id => ({ id, model: id, displayName: id })) } as any
      if (method === 'thread/start') return { thread: { id }, model: params.model, approvalPolicy: 'never', sandbox: { type: 'readOnly' } } as any
      if (method === 'turn/start') {
        const turnId = `turn-${++turns}`
        const model = params.model ?? requests.find(r => r.method === 'thread/start')!.params.model
        const failure = opts.failFor?.[model]
        queueMicrotask(() => failure
          ? notification('turn/completed', { threadId: id, turn: { id: turnId, status: 'failed', error: failure } })
          : (notification('item/completed', { threadId: id, turnId, item: { type: 'agentMessage', text: `answer from ${model}` } }),
             notification('turn/completed', { threadId: id, turn: { id: turnId, status: 'completed' } })))
        return { turn: { id: turnId } } as any
      }
      return {} as any
    }, notify() {}, close: async () => {} }
  } })
  return { driver, requests }
}

async function oneTurn(driver: CodexPersistentProcess, l: AgentProcessLaunch) {
  const events: AgentProcessEvent[] = []
  await driver.start(l)
  const collecting = (async () => { for await (const e of driver.events) { events.push(e); if (e.type === 'completion') break } })()
  await driver.submitUserTurn('hello')
  await collecting; await driver.close()
  return events
}

test('an unavailable model is answered by the next one on the same thread, and the answer says so', async () => {
  const f = fallbackDriver({ failFor: { 'gpt-5.6-sol': { codexErrorInfo: 'usageLimitExceeded', message: 'You have hit your usage limit' } } })
  const events = await oneTurn(f.driver, { ...launch, model: 'gpt-5.6-sol', fallbackModels: ['gpt-6-astra', 'gpt-5.5'] })
  const done = events.find(e => e.type === 'completion') as Extract<AgentProcessEvent, { type: 'completion' }>
  assert.equal(done.outcome, 'completed')
  assert.equal(done.finalText, 'answer from gpt-6-astra')
  assert.match(done.notice ?? '', /GPT-5\.6 Sol was unavailable \(usage limit reached\), so this answer is from GPT-6 Astra/)
  const turnStarts = f.requests.filter(r => r.method === 'turn/start')
  assert.deepEqual(turnStarts.map(r => r.params.model), [undefined, 'gpt-6-astra'])
  assert.equal(new Set(turnStarts.map(r => r.params.threadId)).size, 1, 'same thread')
})

test('a default the account cannot use is swapped before the first turn', async () => {
  const f = fallbackDriver({ available: ['gpt-6-astra', 'gpt-5.5'] })
  const events = await oneTurn(f.driver, { ...launch, model: 'gpt-5.6-sol', fallbackModels: ['gpt-5.5', 'gpt-6-astra'] })
  assert.equal(f.requests.find(r => r.method === 'thread/start')!.params.model, 'gpt-5.5', 'first fallback the account has')
  const done = events.find(e => e.type === 'completion') as Extract<AgentProcessEvent, { type: 'completion' }>
  assert.match(done.notice ?? '', /not available on this account/)
})

test('when every model is unavailable the failure is marked, so the Agent can switch provider', async () => {
  const limit = { codexErrorInfo: 'usageLimitExceeded', message: 'limit' }
  const f = fallbackDriver({ failFor: { 'gpt-5.6-sol': limit, 'gpt-5.5': limit } })
  const events = await oneTurn(f.driver, { ...launch, model: 'gpt-5.6-sol', fallbackModels: ['gpt-5.5'] })
  const done = events.find(e => e.type === 'completion') as Extract<AgentProcessEvent, { type: 'completion' }>
  assert.equal(done.outcome, 'failed')
  assert.equal(done.failure?.kind, 'model-unavailable')
})

test('a failure no model would fix is not retried', async () => {
  const f = fallbackDriver({ failFor: { 'gpt-5.6-sol': { codexErrorInfo: 'unauthorized', message: 'log in' } } })
  const events = await oneTurn(f.driver, { ...launch, model: 'gpt-5.6-sol', fallbackModels: ['gpt-5.5'] })
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1)
  const done = events.find(e => e.type === 'completion') as Extract<AgentProcessEvent, { type: 'completion' }>
  assert.equal(done.failure?.kind, undefined)
})
