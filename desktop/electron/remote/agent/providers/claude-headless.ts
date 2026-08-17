import { spawn as spawnProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type {
  AgentProcessDriver,
  AgentProcessEvent,
  AgentProcessLaunch,
} from '../provider'

/**
 * Headless Claude driver — the Agent as one thing, not as a session.
 *
 * The PTY driver runs a REPL and learns what happened from a SIDE CHANNEL: a
 * hook POST back to a local server. In the field that channel produced zero
 * events, and because nothing times out, the Agent said "Thinking" for 38
 * minutes over an idle process. Two more failure modes come free with a TUI:
 * a multi-line paste can land one Enter short of submitting, and a permission
 * prompt can open with nobody there to answer it.
 *
 * Here the turn IS a process. Its stdout is the transcript, its exit is the
 * backstop, and neither can fail to arrive. The cost is a fresh spawn per turn
 * (~4s measured) where a warm REPL pays nothing — a predictable few seconds in
 * place of an unbounded hang.
 *
 * Reverting is one environment variable: UNMUTE_AGENT_RUNTIME=repl restores
 * ExecutorBackedAgentProcess untouched. Both satisfy AgentProcessDriver, so the
 * provider contract suite runs against either.
 */

export type AgentRuntimeMode = 'headless' | 'repl'

/**
 * The revert switch. `UNMUTE_AGENT_RUNTIME=repl` puts the Agent back on the
 * PTY driver with no code change and no rebuild — set it, relaunch, done.
 * Anything unrecognised keeps the default, so a typo cannot silently drop you
 * onto the path that hangs.
 */
export function agentRuntimeMode(env: NodeJS.ProcessEnv = process.env): AgentRuntimeMode {
  return env.UNMUTE_AGENT_RUNTIME?.trim().toLowerCase() === 'repl' ? 'repl' : 'headless'
}

/** The Unmute intercom, which is where every Agent capability lives. */
const AGENT_TOOL_ALLOWLIST = 'mcp__unmute'

/** How long exit waits for stdout to finish before speaking anyway. */
const EXIT_DRAIN_CAP_MS = 2_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

/**
 * Print mode, streamed as JSON. `--verbose` is not optional: print mode
 * rejects stream-json without it and exits immediately, which would fail every
 * turn at spawn.
 */
export function headlessArgv(
  launch: AgentProcessLaunch,
  systemPrompt: string,
  allowedTools: string = AGENT_TOOL_ALLOWLIST,
): string[] {
  // Confine the Agent to its own intercom. Without --strict-mcp-config the
  // flag ADDS to whatever the user has registered at user scope — which in the
  // field was 166 tools across 11 servers, none of them reachable through
  // --allowedTools, all of them re-sent on every headless turn.
  const mcpConfig = launch.environment.UNMUTE_MCP_CONFIG
  const mcpArgs = mcpConfig ? ['--mcp-config', mcpConfig, '--strict-mcp-config'] : []
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--append-system-prompt', systemPrompt,
    '--allowedTools', allowedTools,
    ...mcpArgs,
    // Fresh-vs-resume was already decided by the runtime. Re-deriving it here
    // is how two paths that must agree start disagreeing.
    ...launch.argv,
  ]
}

interface ContentBlock {
  type?: unknown
  name?: unknown
  text?: unknown
}

/**
 * One stream-json value to zero or more driver events. Returns an array
 * because a single assistant message can carry prose *and* a tool call, and
 * collapsing that to one event silently drops the second.
 */
export function headlessEvents(value: unknown): AgentProcessEvent[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>

  if (record.type === 'system' && record.subtype === 'init') {
    return typeof record.session_id === 'string'
      ? [{ type: 'handle', sessionId: record.session_id }]
      : []
  }

  if (record.type === 'assistant') {
    const message = record.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? message.content as ContentBlock[] : []
    const events: AgentProcessEvent[] = []
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : null
        events.push({ type: 'activity', kind: 'tool', summary: name ? `using ${name}` : 'using a tool' })
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ type: 'activity', kind: 'message', summary: block.text })
      }
    }
    return events
  }

  if (record.type === 'result') {
    // Trust the negative signals over the positive one: a result that is not
    // explicitly a success is a failure, so a shape we have not seen before
    // can never be reported to the user as a good answer.
    const failed = record.is_error === true || record.subtype !== 'success'
    if (failed) return [{ type: 'completion', outcome: 'failed' }]
    return [{
      type: 'completion',
      outcome: 'completed',
      ...(typeof record.result === 'string' && record.result ? { finalText: record.result } : {}),
    }]
  }

  return []
}

export interface HeadlessChild {
  readonly stdout: AsyncIterable<string | Buffer>
  readonly stderr?: AsyncIterable<string | Buffer>
  /** Writes the prompt and closes stdin — print mode reads until EOF. */
  writePrompt(text: string): void
  kill(signal: NodeJS.Signals): void
  onExit(cb: (code: number | null) => void): void
}

export type HeadlessSpawner = (
  argv: string[],
  opts: { binary: string; cwd: string; env: NodeJS.ProcessEnv },
) => HeadlessChild

export interface HeadlessAgentProcessOptions {
  spawn?: HeadlessSpawner
  readSystemPrompt?: (path: string) => Promise<string>
  allowedTools?: string
}

class EventQueue implements AsyncIterable<AgentProcessEvent> {
  private readonly values: AgentProcessEvent[] = []
  private readonly waiters: Array<(value: IteratorResult<AgentProcessEvent>) => void> = []
  private ended = false

  emit = (event: AgentProcessEvent): void => {
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

export class HeadlessAgentProcess implements AgentProcessDriver {
  private readonly queue = new EventQueue()
  readonly events: AsyncIterable<AgentProcessEvent> = this.queue
  private readonly spawn: HeadlessSpawner
  private readonly readSystemPrompt: (path: string) => Promise<string>
  private readonly allowedTools: string
  private pending: AgentProcessLaunch | null = null
  private child: HeadlessChild | null = null
  private drained: Promise<void> = Promise.resolve()
  private interrupted = false
  private completed = false
  private closed = false

  constructor(options: HeadlessAgentProcessOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawner
    this.readSystemPrompt = options.readSystemPrompt ?? ((path) => fs.readFile(path, 'utf8'))
    this.allowedTools = options.allowedTools ?? AGENT_TOOL_ALLOWLIST
  }

  /**
   * Nothing is spawned yet — print mode wants the prompt at launch. The
   * identity is announced now because the runtime pinned it, which is what
   * removes the handle timeout the PTY path could sit inside.
   */
  async start(launch: AgentProcessLaunch): Promise<void> {
    this.pending = launch
    if (launch.session.id) this.queue.emit({ type: 'handle', sessionId: launch.session.id })
  }

  async submitUserTurn(text: string): Promise<void> {
    const launch = this.pending
    if (!launch) throw new Error('not started')
    if (this.closed) throw new Error('closed')
    const systemPrompt = await this.readSystemPrompt(launch.systemContext.path)
    const child = this.spawn(
      headlessArgv(launch, systemPrompt, this.allowedTools),
      { binary: launch.binary, cwd: launch.cwd, env: launch.environment },
    )
    this.child = child
    this.drained = this.readStdout(child)
    child.onExit((code) => { void this.onExit(code) })
    void this.readStderr(child)
    child.writePrompt(text)
  }

  /** SIGINT so the CLI can shut its session down cleanly rather than be torn out. */
  async interrupt(): Promise<void> {
    if (!this.child || this.closed) return
    this.interrupted = true
    try { this.child.kill('SIGINT') } catch { /* it may already be gone */ }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { this.child?.kill('SIGKILL') } catch { /* process may already have exited */ }
    this.queue.end()
  }

  private async readStdout(child: HeadlessChild): Promise<void> {
    try {
      for await (const line of lines(child.stdout)) {
        if (this.closed) return
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue } // non-JSON noise is not authoritative
        for (const event of headlessEvents(parsed)) {
          if (event.type === 'completion') this.completed = true
          this.queue.emit(event)
        }
      }
    } catch { /* the exit handler is the backstop */ }
  }

  private async readStderr(child: HeadlessChild): Promise<void> {
    if (!child.stderr) return
    try {
      for await (const chunk of child.stderr) {
        if (this.closed) return
        // Diagnosis only. Like PTY bytes, this can explain a failure but is
        // never allowed to decide one.
        this.queue.emit({ type: 'terminal-output', chunk: chunk.toString() })
      }
    } catch { /* stderr is best-effort */ }
  }

  /**
   * Exit is the LAST word, never the first. Node can fire exit while stdout
   * still holds buffered data, and the runtime treats an exit seen before a
   * completion as a crash — so a turn that answered perfectly would be
   * reported as failed. Drain first, then speak. The cap exists so a stream
   * that never ends cannot reinstate the very hang this driver removes.
   */
  private async onExit(code: number | null): Promise<void> {
    await Promise.race([this.drained, delay(EXIT_DRAIN_CAP_MS)])
    if (this.closed) return
    // An answer already given is not rewritten by however the process ended.
    if (this.interrupted && !this.completed) {
      this.completed = true
      this.queue.emit({ type: 'completion', outcome: 'interrupted' })
    }
    this.queue.emit({ type: 'exit', exitCode: code ?? 0 })
  }
}

/** Reassemble whole lines: a pipe does not respect line boundaries. */
async function* lines(source: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of source) {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) yield line
      index = buffer.indexOf('\n')
    }
  }
  const rest = buffer.trim()
  if (rest) yield rest
}

const defaultSpawner: HeadlessSpawner = (argv, { binary, cwd, env }) => {
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
      // 'close' rather than 'exit': it fires once the stdio streams are done,
      // so the answer is already in hand.
      child.on('close', (code) => cb(code))
      // A spawn that never starts (missing binary) must still end the turn.
      child.on('error', () => cb(null))
    },
  }
}
