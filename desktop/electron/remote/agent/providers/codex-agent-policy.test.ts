import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexPersistentProcess, CodexRequestRejected, agentCodexHome, agentRequestResponse, userMcpServers } from './codex-persistent'
import { AgentProviderError, AgentSetupError, type AgentProcessEvent, type AgentProcessLaunch } from '../provider'

const id = '22222222-2222-4222-8222-222222222222'
const launch: AgentProcessLaunch = {
  provider: 'codex', binary: 'codex', argv: [], cwd: '/private/unmute/runtime', taskId: 'agent',
  environment: { UNMUTE_MCP_ENDPOINT: 'http://127.0.0.1/mcp', UNMUTE_MCP_TOKEN: 't' },
  systemContext: { type: 'file', path: '/c.md' }, session: { kind: 'fresh' },
}

/** A Codex that enforces a policy: `refuse` rejects thread/start the first time
 *  with the given message; `applied` is what it reports applying. */
function codex(opts: { requirements?: unknown; refuse?: string; turnRefuse?: string; applied?: { approvalPolicy: string; sandbox: string }; account?: unknown }) {
  const requests: Array<{ method: string; params: any }> = []
  let refused = false
  let notify!: (m: string, p: any) => void
  const driver = new CodexPersistentProcess({ readSystemPrompt: async () => 'C', connect: async (_l, n) => {
    notify = n
    return { request: async (method, params: any) => {
      requests.push({ method, params })
      if (method === 'configRequirements/read') return { requirements: opts.requirements ?? null } as any
      if (method === 'account/read') return (opts.account ?? { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }) as any
      if (method === 'thread/start') {
        if (opts.refuse && !refused) { refused = true; throw new Error(`-32600: ${opts.refuse}`) }
        const a = opts.applied ?? { approvalPolicy: params.approvalPolicy, sandbox: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' }
        return { thread: { id }, model: 'm', approvalPolicy: a.approvalPolicy, sandbox: { type: a.sandbox } } as any
      }
      if (method === 'turn/start') {
        if (opts.turnRefuse) throw new CodexRequestRejected(-32600, opts.turnRefuse)
        queueMicrotask(() => { notify('item/completed', { threadId: id, turnId: 't1', item: { type: 'agentMessage', text: 'ok' } }); notify('turn/completed', { threadId: id, turn: { id: 't1', status: 'completed' } }) }); return { turn: { id: 't1' } } as any
      }
      return {} as any
    }, notify() {}, close: async () => {} }
  } })
  return { driver, requests }
}

async function turn(driver: CodexPersistentProcess) {
  await driver.start(launch)
  const events: AgentProcessEvent[] = []
  const done = (async () => { for await (const e of driver.events) { events.push(e); if (e.type === 'completion') break } })()
  await driver.submitUserTurn('hi'); await done; await driver.close()
  return events
}

test('a policy that forbids "never" gets the highest allowed approval, and Codex applying it is accepted', async () => {
  const c = codex({ requirements: { allowedApprovalPolicies: ['untrusted', 'on-request'], allowedSandboxModes: ['read-only', 'workspace-write'] } })
  const events = await turn(c.driver)
  const start = c.requests.find(r => r.method === 'thread/start')!.params
  assert.deepEqual([start.approvalPolicy, start.sandbox], ['on-request', 'read-only'])
  assert.equal((events.find(e => e.type === 'completion') as any).outcome, 'completed')
})

test('Codex silently applying "untrusted" (measured) no longer kills the Agent', async () => {
  const c = codex({ applied: { approvalPolicy: 'untrusted', sandbox: 'readOnly' } })
  assert.equal((( await turn(c.driver)).find(e => e.type === 'completion') as any).outcome, 'completed')
})

test('a refusal the up-front query missed is learned from and retried', async () => {
  const c = codex({ refuse: 'invalid value for `approval_policy`: `Never` is not in the allowed set [UnlessTrusted, OnRequest] (set by cloud requirements)' })
  await turn(c.driver)
  const starts = c.requests.filter(r => r.method === 'thread/start').map(r => r.params.approvalPolicy)
  assert.deepEqual(starts, ['never', 'on-request'])
})

test('broader access than the Agent needs is refused, with a reason written for the user', async () => {
  const c = codex({ applied: { approvalPolicy: 'never', sandbox: 'dangerFullAccess' } })
  await c.driver.start(launch)
  await assert.rejects(c.driver.submitUserTurn('hi'), (e: unknown) => e instanceof AgentSetupError && /broader access/.test(e.userMessage))
})

test('no login is said as such, not as "provider unavailable"', async () => {
  const c = codex({ account: { account: null, requiresOpenaiAuth: true } })
  await c.driver.start(launch)
  await assert.rejects(c.driver.submitUserTurn('hi'), (e: unknown) => e instanceof AgentSetupError && /not signed in/.test(e.userMessage))
  assert.match(new AgentProviderError('provider-unavailable', 'd', 'Codex is not signed in on this Mac.').message, /unavailable\. Codex is not signed in/)
})

test('a managed turn refusal gives a policy reason without claiming acceptance', async () => {
  const c = codex({ turnRefuse: 'blocked by organization policy' })
  await c.driver.start(launch)
  await assert.rejects(c.driver.submitUserTurn('hi'), (e: unknown) => e instanceof AgentSetupError && /Codex policy/.test(e.userMessage))
  assert.equal(c.driver.hasDispatched, false)
})

test('approvals: only the Agent\'s own Unmute tool calls are accepted; everything else is declined in Codex\'s shape', () => {
  assert.deepEqual(agentRequestResponse('mcpServer/elicitation/request', { serverName: 'unmute', _meta: { codex_approval_kind: 'mcp_tool_call' } }), { result: { action: 'accept', content: {} } })
  assert.deepEqual(agentRequestResponse('mcpServer/elicitation/request', { serverName: 'other', _meta: { codex_approval_kind: 'mcp_tool_call' } }), { result: { action: 'decline' } })
  assert.deepEqual(agentRequestResponse('mcpServer/elicitation/request', { serverName: 'unmute', mode: 'form' }), { result: { action: 'decline' } }, 'a form, not a tool approval')
  assert.deepEqual(agentRequestResponse('item/commandExecution/requestApproval', {}), { result: { decision: 'decline' } })
  assert.deepEqual(agentRequestResponse('item/fileChange/requestApproval', {}), { result: { decision: 'decline' } })
  assert.deepEqual(agentRequestResponse('item/permissions/requestApproval', { permissions: { network: {} } }), { result: { permissions: {}, scope: 'turn' } })
  assert.equal(agentRequestResponse('account/chatgptAuthTokens/refresh', {}), undefined)
})

test('the user\'s own MCP servers are found in their config', () => {
  const toml = '[mcp_servers.personal]\ncommand = "x"\n[mcp_servers."with space"]\nurl = "u"\nmcp_servers.inline = { command = "y" }\n[mcp_servers.unmute]\nurl = "z"\n'
  assert.deepEqual(userMcpServers(toml).sort(), ['inline', 'personal', 'with space'])
})

test('the Agent home: isolated with auth.json, the real one (kept apart) with a Keychain login, a clear error with neither', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agent-home-'))
  try {
    await assert.rejects(agentCodexHome(root), (e: unknown) => e instanceof AgentSetupError && /not set up/.test(e.userMessage))
    await fs.mkdir(join(root, '.codex'))
    await fs.writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.personal]\ncommand = "x"\n[mcp_servers."needs quotes"]\ncommand = "y"\n')
    const shared = await agentCodexHome(root)
    assert.equal(shared.shared, true)
    assert.equal(shared.path, join(root, '.codex'))
    assert.deepEqual(shared.args, ['-c', 'mcp_servers.personal.enabled=false'], 'unquoted, and never a key Codex would misparse')
    assert.ok(shared.env.CODEX_SQLITE_HOME && !shared.env.CODEX_SQLITE_HOME.startsWith(join(root, '.codex')))
    await shared.dispose()
    await fs.writeFile(join(root, '.codex', 'auth.json'), '{}')
    const isolated = await agentCodexHome(root)
    assert.equal(isolated.shared, false)
    assert.notEqual(isolated.path, join(root, '.codex'))
    await isolated.dispose()
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
