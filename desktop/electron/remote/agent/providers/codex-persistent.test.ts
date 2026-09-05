import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexPersistentProcess, isolatedCodexHome } from './codex-persistent'
import type { AgentProcessEvent, AgentProcessLaunch } from '../provider'

const id = '11111111-1111-4111-8111-111111111111'
const launch: AgentProcessLaunch = {
  provider: 'codex', binary: 'codex', argv: [], cwd: '/private/unmute/runtime', taskId: 'agent',
  environment: { UNMUTE_MCP_ENDPOINT: 'http://127.0.0.1/mcp', UNMUTE_MCP_TOKEN: 'session-token' },
  systemContext: { type: 'file', path: '/private/unmute/runtime/constitution.md' }, session: { kind: 'fresh' },
}

test('Codex holds one structured connection across turns and filters completion by exact turn', async () => {
  const requests: Array<{ method: string; params: any }> = []
  let connections = 0, closes = 0, turns = 0
  let notification!: (method: string, params: any) => void
  const driver = new CodexPersistentProcess({ readSystemPrompt: async () => 'EXACT CONSTITUTION', connect: async (_launch, notify) => {
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
  notification('turn/completed', { threadId: id, turn: { id: 'stale', status: 'completed' } })
  notification('item/completed', { threadId: id, turnId: 'turn-1', item: { type: 'agentMessage', text: 'first answer' } })
  notification('turn/completed', { threadId: id, turn: { id: 'turn-1', status: 'completed' } })
  await driver.submitUserTurn('two')
  await driver.interrupt()
  notification('turn/completed', { threadId: id, turn: { id: 'turn-2', status: 'interrupted' } })
  await driver.close(); await collecting
  assert.equal(connections, 1)
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
