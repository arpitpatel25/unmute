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

export type AgentRuntimeMode = 'persistent' | 'headless' | 'repl'

/**
 * THREE DRIVERS, AND THE DEFAULT MOVED.
 *
 *   persistent  ONE process for the whole conversation, fed turn by turn over
 *               stdin as stream-json. The default.
 *   headless    one process PER TURN — what persistent replaced. Kept as the
 *               step back that changes one thing, for bisecting a regression.
 *   repl        the PTY driver. Kept for completeness; see the header above for
 *               why it is not the default and should not be.
 *
 * WHY PERSISTENT IS NOT A RETURN TO THE REPL. The three failures that removed
 * the PTY driver all come from driving a TUI: outcomes learned from a side
 * channel that could produce nothing, a paste landing one Enter short, and an
 * interactive permission prompt with nobody there to answer it. None of them
 * are properties of a LONG-LIVED PROCESS — they are properties of a terminal
 * interface. Streaming input has no terminal: turns go in as JSON, results come
 * out as JSON on stdout, and `-p` still resolves permissions from flags. The
 * process stays warm and every safety property of the headless rewrite holds.
 *
 * What it buys is the ~4s spawn per turn, which is most of what made the Agent
 * feel like a command rather than a conversation.
 */
export function agentRuntimeMode(env: NodeJS.ProcessEnv = process.env): AgentRuntimeMode {
  const raw = env.UNMUTE_AGENT_RUNTIME?.trim().toLowerCase()
  if (raw === 'repl') return 'repl'
  if (raw === 'headless') return 'headless'
  return 'persistent'
}

/**
 * The Unmute intercom, plus reading.
 *
 * READING IS ALLOWED BECAUSE THE ANSWER LIVES ON DISK. What the user did
 * yesterday is in ~/.claude/projects and ~/.codex/sessions — hundreds of
 * transcripts this app did not write and does not own. Asked "what have we
 * been working on", an Agent with no file access can only answer from tasks
 * Unmute happened to start, which is a fraction of the truth.
 *
 * Glob finds them, Grep searches them, Read opens one. That is the entire job,
 * and it is why Bash is still absent below: a shell adds nothing to finding and
 * reading a file, and everything to destroying one.
 */
const AGENT_TOOL_ALLOWLIST = ['mcp__unmute', 'Read', 'Glob', 'Grep'].join(',')

/**
 * Built-in tools the Agent must never hold.
 *
 * THE LINE IS WRITE AND REACH, NOT FILESYSTEM. It used to be everything, on the
 * reasoning that every capability should live behind the intercom. That was too
 * wide: it also refused the Agent the one thing it needs to answer questions
 * about the user's own work, while Remote spawns Claude with
 * --dangerously-skip-permissions on the same machine. Being strict here and
 * open there was an accident of build order, not a posture.
 *
 * What stays denied is what actually went wrong. Measured against the real
 * binary: `--allowedTools mcp__unmute` on its own leaves Bash fully usable and
 * reports ZERO permission denials — and in the field the Agent, refused a
 * delete by the intent gate, went around it with `Bash: rm` against the user's
 * home directory. A gate that can be walked around is not a gate. Denying these
 * names blocks that, and `--strict-mcp-config` (above) closes the other route,
 * where the model reached a shell through a different MCP server's osascript
 * tool. Neither half is sufficient alone.
 *
 * WebFetch and WebSearch stay denied for a second reason: with reading allowed
 * they would be the only route OFF the machine. Read-only access to your own
 * files, on your own machine, answering your own question is a small step;
 * read-plus-network is exfiltration.
 */
const AGENT_TOOL_DENYLIST = [
  'Bash', 'BashOutput', 'KillShell',
  'Write', 'Edit', 'NotebookEdit',
  'WebFetch', 'WebSearch',
  'Task', 'ToolSearch',
].join(',')

/** How long exit waits for stdout to finish before speaking anyway. */
const EXIT_DRAIN_CAP_MS = 2_000

/**
 * Every live headless turn, so the app can reap them on the way out.
 *
 * A running Agent turn must not survive the app that started it. We have
 * shipped this exact fix once already: the native notch process outlived its
 * parent and sat on screen with nothing driving it — and force-quitting Unmute
 * never touched it, because the process was named something else. A headless
 * `claude` holding a model connection has the same shape, and inherits the
 * same failure if nobody reaps it.
 */
const liveTurns = new Set<{ kill(signal: NodeJS.Signals): void }>()

/** How many turns are currently running. Exposed for tests and diagnostics. */
export function liveHeadlessTurns(): number {
  return liveTurns.size
}

/**
 * Kill every running turn. Safe with nothing running and safe to call twice:
 * it runs from process-exit handlers, which fire in ways that are hard to
 * predict and impossible to debug after the fact.
 */
export function reapHeadlessTurns(): void {
  for (const child of [...liveTurns]) {
    try { child.kill('SIGKILL') } catch { /* it may already be gone */ }
    liveTurns.delete(child)
  }
}

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
  /** Streaming input: the process stays up and reads turns as JSON from stdin
   *  instead of one prompt followed by EOF. */
  streamingInput = false,
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
    // THE ONE FLAG THAT MAKES THE PROCESS PERSISTENT. Without it print mode
    // reads a single prompt to EOF and exits, which is the per-turn driver.
    ...(streamingInput ? ['--input-format', 'stream-json'] : []),
    '--verbose',
    '--append-system-prompt', systemPrompt,
    '--allowedTools', allowedTools,
    '--disallowedTools', AGENT_TOOL_DENYLIST,
    // Left unset, Claude Code defaults to `high` on Sonnet 5 — measured live:
    // a headless turn (a memory lookup, a clipboard copy, a task handoff,
    // none of it deep reasoning) spent 2,583 thinking tokens on one step,
    // ~39s for a reply that should be near-instant. `medium` is Anthropic's
    // own documented sweet spot for ordinary work. Scoped to the headless
    // Agent only — an interactive orchestrator SESSION (task-manager.ts's
    // dispatch, real coding/architecture work) is deliberately untouched and
    // stays on the CLI's own high default, where the deeper reasoning earns
    // its latency.
    '--effort', 'medium',
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
    liveTurns.add(child)
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
    if (this.child) liveTurns.delete(this.child)
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
    if (this.child) liveTurns.delete(this.child)
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

/**
 * ONE PROCESS FOR THE WHOLE CONVERSATION.
 *
 * Same argv, same stdout parser, same event contract as the per-turn driver —
 * the only differences are that stdin is not closed after the first prompt, and
 * that a `result` ends a TURN rather than the process.
 *
 * THE PROCESS IS SPAWNED LAZILY, on the first turn rather than at start(). A
 * warm `claude` holds a model connection; spawning one the moment the app
 * launches would pay for an Agent the user may never speak to today.
 *
 * IT IS ALSO DISPOSABLE. If the process dies — crash, OOM, the user quitting
 * something underneath it — the next turn spawns a fresh one and resumes by
 * session id. A warm process is an optimisation, never the system of record;
 * the session id is.
 */
export class PersistentHeadlessAgentProcess implements AgentProcessDriver {
  private readonly queue = new EventQueue()
  readonly events: AsyncIterable<AgentProcessEvent> = this.queue
  private readonly spawn: HeadlessSpawner
  private readonly readSystemPrompt: (path: string) => Promise<string>
  private readonly allowedTools: string
  private pending: AgentProcessLaunch | null = null
  private child: HeadlessChild | null = null
  private interrupted = false
  private closed = false
  /** The id this conversation resumes by, learned from the `system/init` line.
   *  Survives the process it was learned from — that is the entire point. */
  private sessionId: string | null = null

  constructor(options: HeadlessAgentProcessOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawner
    this.readSystemPrompt = options.readSystemPrompt ?? ((path) => fs.readFile(path, 'utf8'))
    this.allowedTools = options.allowedTools ?? AGENT_TOOL_ALLOWLIST
  }

  async start(launch: AgentProcessLaunch): Promise<void> {
    this.pending = launch
    if (launch.session.id) {
      this.sessionId = launch.session.id
      this.queue.emit({ type: 'handle', sessionId: launch.session.id })
    }
  }

  async submitUserTurn(text: string): Promise<void> {
    const launch = this.pending
    if (!launch) throw new Error('not started')
    if (this.closed) throw new Error('closed')
    this.interrupted = false
    await this.ensureChild(launch)
    // The user turn, in the shape stream-json input expects. One line, one turn.
    this.child?.writePrompt(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`)
  }

  /**
   * SIGINT ends the TURN, and takes the process with it.
   *
   * There is no way to cancel one turn of a streaming session without ending
   * the process, and pretending otherwise would leave a half-answered turn in
   * a session we then went on using. Killing it is honest and costs one respawn
   * — the session id is kept, so the conversation itself is not lost.
   */
  async interrupt(): Promise<void> {
    if (!this.child || this.closed) return
    this.interrupted = true
    try { this.child.kill('SIGINT') } catch { /* it may already be gone */ }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.dropChild('SIGKILL')
    this.queue.end()
  }

  /** Spawn if there is nothing alive. Idempotent by construction. */
  private async ensureChild(launch: AgentProcessLaunch): Promise<void> {
    if (this.child) return
    const systemPrompt = await this.readSystemPrompt(launch.systemContext.path)
    // RESUME BY WHAT WE LEARNED, not by what we were told at start. A process
    // that died mid-conversation must come back into the SAME session, and the
    // id from `system/init` is the only one that reflects turns already taken.
    const resumed: AgentProcessLaunch = this.sessionId
      ? { ...launch, argv: ['--resume', this.sessionId] }
      : launch
    const child = this.spawn(
      headlessArgv(resumed, systemPrompt, this.allowedTools, true),
      { binary: launch.binary, cwd: launch.cwd, env: launch.environment },
    )
    this.child = child
    liveTurns.add(child)
    void this.readStdout(child)
    void this.readStderr(child)
    child.onExit((code) => { this.onExit(code) })
  }

  private dropChild(signal: NodeJS.Signals): void {
    const child = this.child
    this.child = null
    if (!child) return
    liveTurns.delete(child)
    try { child.kill(signal) } catch { /* it may already be gone */ }
  }

  private async readStdout(child: HeadlessChild): Promise<void> {
    try {
      for await (const line of lines(child.stdout)) {
        if (this.closed || this.child !== child) return
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        for (const event of headlessEvents(parsed)) {
          // Learn the id once and keep it for the life of the conversation —
          // a resumed process re-announces the same one, and taking it again is
          // harmless. What must not happen is losing it on a respawn.
          if (event.type === 'handle') this.sessionId = event.sessionId
          this.queue.emit(event)
        }
      }
    } catch { /* exit is the backstop */ }
  }

  /**
   * KEEP THE LAST WORDS. When the CLI refuses to start — a bad flag, expired
   * auth, a model it does not have — stderr is the ONLY place it says so, and
   * this forwarded it to the transcript for display and kept nothing. A crash
   * then reported `provider-crashed` with no account of itself anywhere.
   */
  private stderrTail: string[] = []

  private async readStderr(child: HeadlessChild): Promise<void> {
    if (!child.stderr) return
    try {
      for await (const chunk of child.stderr) {
        if (this.closed || this.child !== child) return
        const text = chunk.toString()
        const trimmed = text.trim()
        if (trimmed) this.stderrTail = [...this.stderrTail, trimmed].slice(-6)
        this.queue.emit({ type: 'terminal-output', chunk: text })
      }
    } catch { /* best-effort */ }
  }

  /**
   * A PROCESS EXITING IS NOT A TURN ENDING — normally.
   *
   * In the per-turn driver exit is the backstop that guarantees a completion.
   * Here it is a fault: the process should have stayed up. So it emits a
   * completion only if a turn was actually in flight, and either way clears the
   * child so the next turn respawns and resumes.
   */
  private onExit(code: number | null): void {
    this.dropChild('SIGKILL')
    if (this.closed) return
    if (this.interrupted) {
      this.interrupted = false
      this.queue.emit({ type: 'completion', outcome: 'interrupted' })
    }
    // The tail rides the exit so whatever consumed this process can say WHY
    // it went, not merely that it did.
    this.queue.emit({ type: 'exit', exitCode: code ?? 0, stderrTail: this.stderrTail.slice(-3) })
    this.stderrTail = []
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
