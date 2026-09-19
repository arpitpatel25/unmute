import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { AgentSetupError, type AgentProcessDriver, type AgentProcessEvent, type AgentProcessLaunch } from '../provider'
import { clampPosture, learnFromRejection, mergeRequirements, requirementsFrom, type CodexRequirements } from '../../codex/requirements'
import { diagnostic, type DiagnosticSink } from '../../diagnostics'
import { parseModels } from '../../codex/appserver'
import { codexModelUnavailable } from '../modelAvailability'
import { agentModelName, markModelUnavailable, markModelWorking } from '../modelPolicy'

/** The app-server lacks exec's ignore-user-config/ignore-rules loader flags.
 * Give it a private, empty home instead. Only auth and native conversation
 * storage are shared; user config, plugins, hooks and saved rules are absent.
 * The host's cwd is the private Unmute runtime, never a user project. */
export async function isolatedCodexHome(userHome: string, original = join(userHome, '.codex')): Promise<{ path: string; dispose(): Promise<void> }> {
  // Do not guess how to retrieve keychain-only credentials or create a login.
  await fs.access(join(original, 'auth.json')).catch(() => { throw new Error('Persistent Codex requires an existing auth.json login') })
  const path = await fs.mkdtemp(join(tmpdir(), 'unmute-agent-codex-'))
  await fs.chmod(path, 0o700)
  try {
    await fs.symlink(join(original, 'auth.json'), join(path, 'auth.json'))
    for (const name of ['sessions', 'archived_sessions']) {
      const ownedHistory = join(original, name, 'unmute-agent')
      await fs.mkdir(ownedHistory, { recursive: true, mode: 0o700 })
      await fs.symlink(ownedHistory, join(path, name))
    }
  } catch (error) { await fs.rm(path, { recursive: true, force: true }); throw error }
  return { path, dispose: () => fs.rm(path, { recursive: true, force: true }) }
}

/**
 * THE HOME THE AGENT'S CODEX RUNS IN.
 *
 * Isolated when it can be: a private home holding only a link to auth.json
 * (isolatedCodexHome above). A login kept in the Keychain has no auth.json,
 * and Codex files a Keychain login under the exact home folder it belongs to
 * — measured 2026-09-20: a login made in home A reads "Not logged in" from any
 * other home, and logged in through a symlink to A. So no private home can
 * ever see it, and the Agent used to refuse to start on such a Mac.
 *
 * Then the Agent runs in the real ~/.codex, kept apart the ways Codex allows:
 * its thread index goes to a private CODEX_SQLITE_HOME, so Agent threads stay
 * out of the Codex app's list, and each of the user's own MCP servers is
 * switched off by name (`-c mcp_servers={}` does not remove them — measured).
 */
export async function agentCodexHome(userHome: string, original = join(userHome, '.codex')): Promise<{ path: string; args: string[]; env: NodeJS.ProcessEnv; shared: boolean; dispose(): Promise<void> }> {
  const hasAuthFile = await fs.access(join(original, 'auth.json')).then(() => true, () => false)
  if (hasAuthFile) {
    const isolated = await isolatedCodexHome(userHome, original)
    return { ...isolated, args: [], env: {}, shared: false }
  }
  if (!await fs.stat(original).then(s => s.isDirectory(), () => false)) {
    throw new AgentSetupError('Codex is not set up on this Mac. Open Codex and sign in, then try again.', 'no ~/.codex')
  }
  const config = await fs.readFile(join(original, 'config.toml'), 'utf8').catch(() => '')
  const sqlite = await fs.mkdtemp(join(tmpdir(), 'unmute-agent-codex-state-'))
  await fs.chmod(sqlite, 0o700)
  return {
    path: original,
    // Unquoted on purpose: Codex's `-c` does not unquote a dotted key, so
    // `mcp_servers."x".enabled` creates a broken server literally named "x"
    // and the app-server refuses to start (measured). A name that would need
    // quoting cannot be switched off this way and is left as it is.
    args: userMcpServers(config).filter(name => /^[A-Za-z0-9_-]+$/.test(name)).flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]),
    env: { CODEX_SQLITE_HOME: sqlite },
    shared: true,
    dispose: () => fs.rm(sqlite, { recursive: true, force: true }),
  }
}

/** The MCP server names a Codex config.toml declares. */
export function userMcpServers(config: string): string[] {
  const names = new Set<string>()
  for (const m of config.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))/gm)) names.add(m[1] ?? m[2])
  for (const m of config.matchAll(/^\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*[.=]/gm)) names.add(m[1] ?? m[2])
  names.delete('unmute')
  return [...names]
}

/**
 * WHAT THE AGENT ANSWERS WHEN CODEX ASKS. Where a company policy forbids
 * "never ask", Codex runs the Agent with approvals on and asks. The Agent is
 * read-only and nobody watches it, so: its own tool calls to Unmute's server
 * are approved (that is the Agent's whole job, and the server is token-scoped
 * to this conversation); everything else — commands, file changes, extra
 * permissions, other servers' forms — is declined in the shape Codex expects
 * (same shapes as codex/hub.ts), so the turn carries on instead of stalling.
 */
export function agentRequestResponse(method: string, params: any): { result: unknown } | undefined {
  switch (method) {
    case 'mcpServer/elicitation/request': {
      const ours = params?.serverName === 'unmute' && params?._meta?.codex_approval_kind === 'mcp_tool_call'
      return { result: ours ? { action: 'accept', content: {} } : { action: 'decline' } }
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return { result: { decision: 'decline' } }
    case 'item/permissions/requestApproval': return { result: { permissions: {}, scope: 'turn' } }
    case 'item/tool/requestUserInput': return { result: { answers: {} } }
    case 'execCommandApproval':
    case 'applyPatchApproval': return { result: { decision: 'denied' } }
    default: return undefined
  }
}

export interface CodexAgentConnection {
  request<T = any>(method: string, params: unknown): Promise<T>
  notify(method: string, params: unknown): void
  close(): Promise<void>
}
interface Options {
  audit?: DiagnosticSink
  resolveResumePath?(id: string, home: string): Promise<string | undefined>
  readSystemPrompt?(path: string): Promise<string>
  connect?(launch: AgentProcessLaunch, onNotification: (method: string, params: any) => void, onExit: () => void): Promise<CodexAgentConnection>
}

class EventQueue implements AsyncIterable<AgentProcessEvent> {
  private values: AgentProcessEvent[] = []
  private waiters: Array<(value: IteratorResult<AgentProcessEvent>) => void> = []
  private ended = false
  emit(value: AgentProcessEvent): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value }); else this.values.push(value)
  }
  end(): void { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }) }
  [Symbol.asyncIterator](): AsyncIterator<AgentProcessEvent> {
    return { next: async () => {
      const value = this.values.shift()
      if (value) return { done: false, value }
      if (this.ended) return { done: true, value: undefined }
      return new Promise(resolve => this.waiters.push(resolve))
    } }
  }
}

/** One app-server process and one structured thread for the conversation. */
export class CodexPersistentProcess implements AgentProcessDriver {
  readonly persistent = true
  hasDispatched = false
  private readonly queue = new EventQueue()
  readonly events = this.queue
  private launch?: AgentProcessLaunch
  private connection?: CodexAgentConnection
  private threadId?: string
  private turnId?: string
  private model?: string
  private finalText = ''
  private startingTurn = false
  private buffered: Array<{ method: string; params: any }> = []
  private closed = false
  /** What the current turn said, kept so an unavailable model can be retried. */
  private lastText = ''
  /** Models this turn has already tried. */
  private tried = new Set<string>()
  /** The last terminal error Codex reported for this turn. */
  private turnError?: { codexErrorInfo?: unknown; message?: string }
  /** Told to the user with this turn's answer. */
  private turnNotice?: string
  /** Learned before the first turn (the default was not on this account). */
  private pendingNotice?: string

  constructor(private readonly options: Options = {}) {}
  async start(launch: AgentProcessLaunch): Promise<void> { this.launch = launch }

  async submitUserTurn(text: string): Promise<void> {
    if (!this.launch || this.closed || this.turnId || this.startingTurn) throw new Error('Codex session unavailable')
    this.hasDispatched = false
    if (!this.connection) await this.initialize()
    this.lastText = text
    this.tried = new Set(this.model ? [this.model] : [])
    this.turnNotice = this.pendingNotice
    this.pendingNotice = undefined
    this.hasDispatched = true
    await this.startTurn(text)
    this.queue.emit({ type: 'handle', sessionId: this.threadId!, observed: true, model: this.model })
    for (const { method, params } of this.buffered.splice(0)) this.notification(method, params)
  }

  /** One `turn/start`. A `model` override sticks to the thread for later turns. */
  private async startTurn(text: string, model?: string): Promise<void> {
    this.startingTurn = true
    this.finalText = ''
    this.turnError = undefined
    try {
      const response = await this.connection!.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], effort: 'medium',
        ...(model ? { model } : {}),
      })
      if (!response.turn?.id) throw new Error('Missing accepted turn')
      this.turnId = response.turn.id
    } finally { this.startingTurn = false }
  }

  /**
   * THE CHOSEN MODEL IS UNAVAILABLE — answer with the next one instead of
   * blocking the chat. Same thread, so the conversation is intact; Codex keeps
   * the override for later turns, and the next session tries the default again
   * once its cooldown lapses.
   */
  private async retryOn(next: string, failed: string, reason: string): Promise<void> {
    this.tried.add(next)
    this.queue.emit({ type: 'activity', kind: 'progress', summary: `${agentModelName('codex', failed)} is unavailable (${reason}); trying ${agentModelName('codex', next)}` })
    const original = this.launch?.model ?? failed
    this.turnNotice = `${agentModelName('codex', original)} was unavailable (${reason}), so this answer is from ${agentModelName('codex', next)}.`
    this.model = next
    try { await this.startTurn(this.lastText, next) }
    catch (error) {
      this.queue.emit({ type: 'completion', outcome: 'failed', failure: { kind: 'model-unavailable', reason, message: (error as Error).message } })
      return
    }
    for (const { method, params } of this.buffered.splice(0)) this.notification(method, params)
  }

  /** Models this account can use, from Codex itself; empty if it cannot say. */
  private async availableModels(): Promise<string[]> {
    try {
      const result = await this.connection!.request<{ data?: unknown[] }>('model/list', {})
      return parseModels((result?.data ?? []) as Parameters<typeof parseModels>[0]).map(m => m.id)
    } catch { return [] }
  }

  private async initialize(): Promise<void> {
    const launch = this.launch!
    const prompt = await (this.options.readSystemPrompt ?? (path => fs.readFile(path, 'utf8')))(launch.systemContext.path)
    this.connection = await (this.options.connect ?? connectStdio)(launch, (method, params) => this.notification(method, params), () => {
      if (!this.closed) { this.queue.emit({ type: 'exit', exitCode: 1 }); this.queue.end() }
    })
    await this.connection.request('initialize', { clientInfo: { name: 'unmute-agent', version: '1' } })
    this.connection.notify('initialized', {})
    // SAY IT WHEN THERE IS NO LOGIN, instead of failing later as "unavailable".
    const account = await this.connection.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>('account/read', {}).catch(() => null)
    if (account && !account.account && account.requiresOpenaiAuth) {
      throw new AgentSetupError('Codex is not signed in on this Mac. Open Codex and sign in, then try again.', 'account/read: no account')
    }
    // CHECK BEFORE ASKING. A default this account cannot use (not on the plan,
    // retired) fails every turn; the model list says so up front.
    let model = launch.model
    if (model) {
      const available = await this.availableModels()
      if (available.length && !available.includes(model)) {
        const next = (launch.fallbackModels ?? []).find(m => available.includes(m)) ?? available[0]
        markModelUnavailable('codex', model)
        this.pendingNotice = `${agentModelName('codex', model)} is not available on this account, so this answer is from ${agentModelName('codex', next)}.`
        model = next
      }
    }
    const resumePath = launch.session.id && launch.environment.HOME
      ? await (this.options.resolveResumePath ?? ((id: string, home: string) => findResumePath(id, home, codexHomeOf(launch.environment))))(launch.session.id, launch.environment.HOME) : undefined
    // THE MOST THIS MACHINE ALLOWS (codex/requirements.ts, as for tasks). The
    // Agent wants read-only and never to be asked; a company policy may forbid
    // "never" (Codex then silently applies "untrusted" — measured) or refuse it
    // outright. Ask for what the policy permits, learn from a refusal, and
    // accept any stricter approval Codex applies: approvals are answered by
    // agentRequestResponse, so they cannot stall the Agent.
    const read = requirementsFrom(await this.connection.request('configRequirements/read', {}).catch(() => null))
    let learned: CodexRequirements | null = null
    const asked = { approvalPolicy: 'never', sandbox: 'read-only' }
    let response: any
    for (let attempt = 0; ; attempt++) {
      const posture = clampPosture(asked, mergeRequirements(read, learned))
      try {
        response = await this.connection.request('thread/' + (launch.session.kind === 'resume' ? 'resume' : 'start'), {
          ...(launch.session.id ? { threadId: launch.session.id } : {}),
          ...(resumePath ? { path: resumePath } : {}),
          cwd: launch.cwd, ...(model ? { model } : {}),
          approvalPolicy: posture.approvalPolicy, sandbox: posture.sandbox, developerInstructions: prompt,
          config: {
            model_reasoning_effort: 'medium',
            mcp_servers: { unmute: {
              url: launch.environment.UNMUTE_MCP_ENDPOINT,
              bearer_token_env_var: 'UNMUTE_MCP_TOKEN', enabled: true, required: true,
              default_tools_approval_mode: 'approve',
            } },
          },
        })
        break
      } catch (error) {
        const message = (error as Error).message ?? ''
        const taught: CodexRequirements | null = attempt < 2 ? learnFromRejection(message, learned) : null
        if (taught && JSON.stringify(clampPosture(asked, mergeRequirements(read, taught))) !== JSON.stringify(posture)) { learned = taught; continue }
        if (learnFromRejection(message, null)) {
          throw new AgentSetupError(`This Mac's Codex policy refused the Agent's session (${message.replace(/^-?\d+:\s*/, '').slice(0, 200)}).`, message)
        }
        throw error
      }
    }
    if (!response.thread?.id || (launch.session.id && response.thread.id !== launch.session.id)) throw new Error('Codex session identity mismatch')
    // Never MORE access than the Agent needs. Workspace-write is tolerated only
    // because a policy may not allow read-only, and the cwd is the Agent's own
    // private runtime folder, never a project.
    if (response.sandbox?.type !== 'readOnly' && response.sandbox?.type !== 'workspaceWrite') {
      throw new AgentSetupError('Codex applied broader access than the Unmute Agent allows, so the Agent did not start.', `sandbox ${response.sandbox?.type}`)
    }
    if (response.approvalPolicy !== 'never' || response.sandbox?.type !== 'readOnly') {
      (this.options.audit ?? diagnostic)('agent-codex-posture', { asked, applied: { approvalPolicy: response.approvalPolicy, sandbox: response.sandbox?.type } })
    }
    this.threadId = response.thread.id
    this.model = response.model
    // Identity alone is not acceptance of the next user turn.
    this.queue.emit({ type: 'handle', sessionId: this.threadId! })
  }

  private notification(method: string, params: any): void {
    if (this.closed || params?.threadId !== this.threadId) return
    if (this.startingTurn) {
      if (this.buffered.length >= 4096) { this.queue.emit({ type: 'observer-failure' }); return }
      this.buffered.push({ method, params }); return
    }
    if (!this.turnId || (params.turnId ?? params.turn?.id) !== this.turnId) return
    const item = params.item
    if (method === 'item/started' || method === 'item/completed') {
      (this.options.audit ?? diagnostic)('agent-provider-item', { provider: 'codex', taskId: this.launch?.taskId,
        sessionId: this.threadId, turnId: this.turnId, phase: method.slice(5), itemId: item?.id,
        itemType: item?.type, server: item?.server, tool: item?.tool, status: item?.status,
        isError: !!item?.error })
    }
    if (method === 'error' && params.willRetry !== true) this.turnError = params.error
    if (method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
      this.finalText = item.text
      this.queue.emit({ type: 'activity', kind: 'message', summary: item.text })
    } else if (method === 'item/started' && item?.type === 'mcpToolCall') {
      this.queue.emit({ type: 'activity', kind: 'tool', summary: `using ${item.server}.${item.tool}` })
    } else if (method === 'turn/completed') {
      const status = params.turn.status
      this.turnId = undefined
      const model = this.model ?? this.launch?.model
      if (status === 'failed') {
        const error = params.turn.error ?? this.turnError
        const reason = codexModelUnavailable(error)
        if (reason && !this.finalText) {
          if (model) { markModelUnavailable('codex', model); this.tried.add(model) }
          const next = (this.launch?.fallbackModels ?? []).find(m => !this.tried.has(m))
          if (next && model) { void this.retryOn(next, model, reason); return }
        }
        this.queue.emit({ type: 'completion', outcome: 'failed', failure: {
          ...(reason ? { kind: 'model-unavailable' as const, reason } : {}),
          ...(typeof error?.message === 'string' ? { message: error.message.slice(0, 600) } : {}),
          ...(error?.codexErrorInfo ? { subtype: typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : Object.keys(error.codexErrorInfo)[0] } : {}),
        } })
        return
      }
      if (status === 'completed' && model) markModelWorking('codex', model)
      this.queue.emit({ type: 'completion', outcome: status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed',
        ...(this.finalText ? { finalText: this.finalText } : {}),
        ...(status === 'completed' && this.turnNotice ? { notice: this.turnNotice } : {}) })
    }
  }

  async interrupt(): Promise<void> {
    if (this.turnId) await this.connection?.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.connection?.close()
    this.queue.end()
  }
}

/** Private stdio prevents another local client attaching to the Agent server. */
async function connectStdio(launch: AgentProcessLaunch, notify: (method: string, params: any) => void, exited: () => void): Promise<CodexAgentConnection> {
  if (!launch.environment.HOME) throw new AgentSetupError('Unmute could not find your home folder to start Codex.', 'no HOME')
  const isolated = await agentCodexHome(launch.environment.HOME, codexHomeOf(launch.environment))
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(launch.binary, ['app-server', ...isolated.args, '--listen', 'stdio://'], {
      cwd: launch.cwd, env: { ...launch.environment, ...isolated.env, CODEX_HOME: isolated.path }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
  } catch (error) {
    await isolated.dispose()
    throw new AgentSetupError('Codex could not be started. Check that the Codex CLI is installed.', (error as Error).message)
  }
  let serial = 0
  let closed = false
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  const send = (value: unknown) => { if (closed || !child.stdin.writable) throw new Error('Codex transport closed'); child.stdin.write(JSON.stringify(value) + '\n') }
  const cleanup = () => {
    if (closed) return
    closed = true
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('Codex transport closed')) }
    pending.clear()
    void isolated.dispose()
    exited()
  }
  child.once('close', cleanup)
  child.once('error', cleanup)
  child.stderr.resume() // Never log credentials or provider transport diagnostics.
  const reader = createInterface({ input: child.stdout })
  reader.on('line', line => {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (message.method) {
      if (message.id !== undefined) {
        const answer = agentRequestResponse(message.method, message.params)
        diagnostic('agent-codex-request', { method: message.method, answered: answer ? JSON.stringify(answer.result).slice(0, 60) : 'refused',
          server: typeof message.params?.serverName === 'string' ? message.params.serverName : undefined })
        if (answer) send({ id: message.id, result: answer.result })
        else send({ id: message.id, error: { code: -32601, message: 'Agent server requests are not authorized' } })
      } else notify(message.method, message.params)
    } else if (typeof message.id === 'number') {
      const waiting = pending.get(message.id)
      if (!waiting) return
      clearTimeout(waiting.timer); pending.delete(message.id)
      // Keep Codex's own words: a policy refusal names what is allowed, which
      // is exactly what the retry above learns from.
      if (message.error) waiting.reject(new Error(`${message.error.code ?? ''}: ${message.error.message ?? 'Codex request failed'}`.replace(/^: /, '')))
      else waiting.resolve(message.result)
    }
  })
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = ++serial
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} request timed out`)) }, 20_000)
      pending.set(id, { resolve, reject, timer })
      try { send({ id, method, params }) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    }),
    notify: (method, params) => send({ method, params }),
    close: async () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already exited */ }
      reader.close(); cleanup(); await isolated.dispose()
    },
  }
}

/** The user's Codex home: CODEX_HOME when they set one, else ~/.codex. */
function codexHomeOf(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME || join(environment.HOME ?? '', '.codex')
}

async function findResumePath(id: string, home: string, codexDir = join(home, '.codex')): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Codex identity')
  const candidates: string[] = []
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8) return
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1)
      else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`)) candidates.push(join(directory, entry.name))
    }
  }
  await walk(join(codexDir, 'sessions'), 0)
  await walk(join(codexDir, 'archived_sessions'), 0)
  if (candidates.length > 1) throw new Error('Ambiguous Codex rollout identity')
  return candidates[0]
}
