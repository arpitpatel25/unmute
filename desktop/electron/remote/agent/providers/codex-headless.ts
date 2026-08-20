import { spawn as spawnProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { AgentProcessDriver, AgentProcessEvent, AgentProcessLaunch } from '../provider'

const EXIT_DRAIN_CAP_MS = 2_000
const liveTurns = new Set<{ kill(signal: NodeJS.Signals): void }>()

export function reapCodexHeadlessTurns(): void {
  for (const child of [...liveTurns]) {
    try { child.kill('SIGKILL') } catch { /* it may already be gone */ }
    liveTurns.delete(child)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

/** Build an isolated, unattended Codex turn with only Unmute's MCP available. */
export function codexHeadlessArgv(launch: AgentProcessLaunch, systemPrompt: string): string[] {
  const endpoint = launch.environment.UNMUTE_MCP_ENDPOINT
  if (!endpoint) throw new Error('UNMUTE_MCP_ENDPOINT is required')
  return [
    '-a', 'never',
    '-s', 'read-only',
    '-C', launch.cwd,
    '-c', `developer_instructions=${JSON.stringify(systemPrompt)}`,
    // CLI overrides have the highest precedence. Clear every inherited MCP
    // table (including managed/project layers), then add back only Unmute.
    '-c', 'mcp_servers={}',
    '-c', `mcp_servers.unmute.url=${JSON.stringify(endpoint)}`,
    '-c', 'mcp_servers.unmute.bearer_token_env_var="UNMUTE_MCP_TOKEN"',
    '-c', 'mcp_servers.unmute.enabled=true',
    '-c', 'mcp_servers.unmute.required=true',
    // This process receives an interaction-scoped bearer token and only this
    // MCP server. Approve its role-filtered capability set without trying to
    // open an approval UI that a headless Agent cannot answer.
    '-c', 'mcp_servers.unmute.default_tools_approval_mode="approve"',
    'exec',
    ...launch.argv,
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    '-',
  ]
}

/** Stateful because Codex sends the final answer before the turn completion. */
export class CodexHeadlessEventParser {
  private finalText = ''

  events(value: unknown): AgentProcessEvent[] {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    if (record.type === 'thread.started') {
      return typeof record.thread_id === 'string'
        ? [{ type: 'handle', sessionId: record.thread_id }]
        : []
    }
    if (record.type === 'item.started') {
      const item = asRecord(record.item)
      if (item?.type !== 'mcp_tool_call') return []
      const server = typeof item.server === 'string' ? item.server : 'mcp'
      const tool = typeof item.tool === 'string'
        ? item.tool
        : typeof item.name === 'string' ? item.name : 'tool'
      return [{ type: 'activity', kind: 'tool', summary: `using ${server}.${tool}` }]
    }
    if (record.type === 'item.completed') {
      const item = asRecord(record.item)
      if (item?.type !== 'agent_message' || typeof item.text !== 'string' || !item.text.trim()) return []
      this.finalText = item.text
      return [{ type: 'activity', kind: 'message', summary: item.text }]
    }
    if (record.type === 'turn.completed') {
      return [{
        type: 'completion',
        outcome: 'completed',
        ...(this.finalText ? { finalText: this.finalText } : {}),
      }]
    }
    if (record.type === 'turn.failed' || record.type === 'error') {
      return [{ type: 'completion', outcome: 'failed' }]
    }
    return []
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export interface CodexHeadlessChild {
  readonly stdout: AsyncIterable<string | Buffer>
  readonly stderr?: AsyncIterable<string | Buffer>
  writePrompt(text: string): void
  kill(signal: NodeJS.Signals): void
  onExit(cb: (code: number | null) => void): void
}

export type CodexHeadlessSpawner = (
  argv: string[],
  opts: { binary: string; cwd: string; env: NodeJS.ProcessEnv },
) => CodexHeadlessChild

export interface CodexHeadlessProcessOptions {
  spawn?: CodexHeadlessSpawner
  readSystemPrompt?: (path: string) => Promise<string>
}

class EventQueue implements AsyncIterable<AgentProcessEvent> {
  private readonly values: AgentProcessEvent[] = []
  private readonly waiters: Array<(value: IteratorResult<AgentProcessEvent>) => void> = []
  private ended = false

  emit(event: AgentProcessEvent): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.values.push(event)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentProcessEvent> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

export class CodexHeadlessProcess implements AgentProcessDriver {
  private readonly queue = new EventQueue()
  readonly events: AsyncIterable<AgentProcessEvent> = this.queue
  private readonly spawn: CodexHeadlessSpawner
  private readonly readSystemPrompt: (path: string) => Promise<string>
  private pending: AgentProcessLaunch | null = null
  private child: CodexHeadlessChild | null = null
  private drained: Promise<void> = Promise.resolve()
  private interrupted = false
  private completed = false
  private closed = false

  constructor(options: CodexHeadlessProcessOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawner
    this.readSystemPrompt = options.readSystemPrompt ?? ((path) => fs.readFile(path, 'utf8'))
  }

  async start(launch: AgentProcessLaunch): Promise<void> {
    this.pending = launch
  }

  async submitUserTurn(text: string): Promise<void> {
    const launch = this.pending
    if (!launch) throw new Error('not started')
    if (this.closed) throw new Error('closed')
    const systemPrompt = await this.readSystemPrompt(launch.systemContext.path)
    const child = this.spawn(
      codexHeadlessArgv(launch, systemPrompt),
      { binary: launch.binary, cwd: launch.cwd, env: launch.environment },
    )
    this.child = child
    liveTurns.add(child)
    this.drained = this.readStdout(child)
    child.onExit((code) => { void this.onExit(code) })
    void this.readStderr(child)
    child.writePrompt(text)
  }

  async interrupt(): Promise<void> {
    if (!this.child || this.closed) return
    this.interrupted = true
    try { this.child.kill('SIGINT') } catch { /* it may already be gone */ }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.child) liveTurns.delete(this.child)
    try { this.child?.kill('SIGKILL') } catch { /* process may already have exited */ }
    this.queue.end()
  }

  private async readStdout(child: CodexHeadlessChild): Promise<void> {
    const parser = new CodexHeadlessEventParser()
    try {
      for await (const line of lines(child.stdout)) {
        if (this.closed) return
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        for (const event of parser.events(parsed)) {
          if (event.type === 'completion') this.completed = true
          this.queue.emit(event)
        }
      }
    } catch { /* exit is the authoritative backstop */ }
  }

  private async readStderr(child: CodexHeadlessChild): Promise<void> {
    if (!child.stderr) return
    try {
      for await (const chunk of child.stderr) {
        if (this.closed) return
        this.queue.emit({ type: 'terminal-output', chunk: chunk.toString() })
      }
    } catch { /* diagnostic only */ }
  }

  private async onExit(code: number | null): Promise<void> {
    if (this.child) liveTurns.delete(this.child)
    await Promise.race([this.drained, delay(EXIT_DRAIN_CAP_MS)])
    if (this.closed) return
    if (this.interrupted && !this.completed) {
      this.completed = true
      this.queue.emit({ type: 'completion', outcome: 'interrupted' })
    }
    this.queue.emit({ type: 'exit', exitCode: code ?? 0 })
    this.queue.end()
  }
}

async function* lines(source: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  for await (const chunk of source) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) yield line
      index = buffer.indexOf('\n')
    }
  }
  buffer += decoder.end()
  const rest = buffer.trim()
  if (rest) yield rest
}

const defaultSpawner: CodexHeadlessSpawner = (argv, { binary, cwd, env }) => {
  const child = spawnProcess(binary, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    writePrompt(text) {
      child.stdin.write(text)
      child.stdin.end()
    },
    kill(signal) { child.kill(signal) },
    onExit(cb) {
      child.on('close', (code) => cb(code))
      child.on('error', () => cb(null))
    },
  }
}
