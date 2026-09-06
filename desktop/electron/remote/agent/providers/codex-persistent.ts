import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { AgentProcessDriver, AgentProcessEvent, AgentProcessLaunch } from '../provider'
import { diagnostic, type DiagnosticSink } from '../../diagnostics'

/** The app-server lacks exec's ignore-user-config/ignore-rules loader flags.
 * Give it a private, empty home instead. Only auth and native conversation
 * storage are shared; user config, plugins, hooks and saved rules are absent.
 * The host's cwd is the private Unmute runtime, never a user project. */
export async function isolatedCodexHome(userHome: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const original = join(userHome, '.codex')
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

  constructor(private readonly options: Options = {}) {}
  async start(launch: AgentProcessLaunch): Promise<void> { this.launch = launch }

  async submitUserTurn(text: string): Promise<void> {
    if (!this.launch || this.closed || this.turnId || this.startingTurn) throw new Error('Codex session unavailable')
    this.hasDispatched = false
    if (!this.connection) await this.initialize()
    this.startingTurn = true
    this.finalText = ''
    this.hasDispatched = true
    try {
      const response = await this.connection!.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], effort: 'medium',
      })
      if (!response.turn?.id) throw new Error('Missing accepted turn')
      this.turnId = response.turn.id
      this.queue.emit({ type: 'handle', sessionId: this.threadId!, observed: true, model: this.model })
    } finally { this.startingTurn = false }
    for (const { method, params } of this.buffered.splice(0)) this.notification(method, params)
  }

  private async initialize(): Promise<void> {
    const launch = this.launch!
    const prompt = await (this.options.readSystemPrompt ?? (path => fs.readFile(path, 'utf8')))(launch.systemContext.path)
    this.connection = await (this.options.connect ?? connectStdio)(launch, (method, params) => this.notification(method, params), () => {
      if (!this.closed) { this.queue.emit({ type: 'exit', exitCode: 1 }); this.queue.end() }
    })
    await this.connection.request('initialize', { clientInfo: { name: 'unmute-agent', version: '1' } })
    this.connection.notify('initialized', {})
    const resumePath = launch.session.id && launch.environment.HOME
      ? await (this.options.resolveResumePath ?? findResumePath)(launch.session.id, launch.environment.HOME) : undefined
    const response = await this.connection.request('thread/' + (launch.session.kind === 'resume' ? 'resume' : 'start'), {
      ...(launch.session.id ? { threadId: launch.session.id } : {}),
      ...(resumePath ? { path: resumePath } : {}),
      cwd: launch.cwd, ...(launch.model ? { model: launch.model } : {}),
      approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: prompt,
      config: {
        model_reasoning_effort: 'medium',
        mcp_servers: { unmute: {
          url: launch.environment.UNMUTE_MCP_ENDPOINT,
          bearer_token_env_var: 'UNMUTE_MCP_TOKEN', enabled: true, required: true,
          default_tools_approval_mode: 'approve',
        } },
      },
    })
    if (!response.thread?.id || (launch.session.id && response.thread.id !== launch.session.id)
      || response.approvalPolicy !== 'never' || response.sandbox?.type !== 'readOnly') throw new Error('Codex session posture mismatch')
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
    if (method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
      this.finalText = item.text
      this.queue.emit({ type: 'activity', kind: 'message', summary: item.text })
    } else if (method === 'item/started' && item?.type === 'mcpToolCall') {
      this.queue.emit({ type: 'activity', kind: 'tool', summary: `using ${item.server}.${item.tool}` })
    } else if (method === 'turn/completed') {
      const status = params.turn.status
      this.turnId = undefined
      this.queue.emit({ type: 'completion', outcome: status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed',
        ...(this.finalText ? { finalText: this.finalText } : {}) })
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
  if (!launch.environment.HOME) throw new Error('Codex login home is unavailable')
  const isolated = await isolatedCodexHome(launch.environment.HOME)
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(launch.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: launch.cwd, env: { ...launch.environment, CODEX_HOME: isolated.path }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
  } catch (error) { await isolated.dispose(); throw error }
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
        // The Agent has no approval escalation rail: never grant a server request.
        send({ id: message.id, error: { code: -32601, message: 'Agent server requests are not authorized' } })
      } else notify(message.method, message.params)
    } else if (typeof message.id === 'number') {
      const waiting = pending.get(message.id)
      if (!waiting) return
      clearTimeout(waiting.timer); pending.delete(message.id)
      if (message.error) waiting.reject(new Error('Codex request failed')); else waiting.resolve(message.result)
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

async function findResumePath(id: string, home: string): Promise<string | undefined> {
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
  await walk(join(home, '.codex', 'sessions'), 0)
  await walk(join(home, '.codex', 'archived_sessions'), 0)
  if (candidates.length > 1) throw new Error('Ambiguous Codex rollout identity')
  return candidates[0]
}
