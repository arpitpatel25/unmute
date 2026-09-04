import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

type Json = Record<string, any>
export type ClaudePermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan'
export type ClaudeTaskEvent =
  | { type: 'message'; message: Json }
  | { type: 'delta'; text: string; message: Json }
  | { type: 'turn-start'; submissionId: string; sessionId: string }
  | { type: 'result'; message: Json; submissionId?: string }
  | { type: 'error'; message: string }
  | { type: 'request'; requestId: string; kind: 'permission' | 'question'; tool: string; input: Json; payload: Json }
  | { type: 'request-resolved'; requestId: string }
  | { type: 'closed' }

export interface ClaudeTaskOptions {
  binary: string
  cwd: string
  sessionId?: string
  resume?: boolean
  model?: string
  effort?: string
  permissionMode?: ClaudePermissionMode
  systemPromptFile?: string
  /** Append task instructions while keeping Claude Code's built-in prompt. */
  appendSystemPromptFile?: string
  settingsFile?: string
  mcpConfigFile?: string
  addDirs?: string[]
  chrome?: boolean
  env?: NodeJS.ProcessEnv
  onEvent: (event: ClaudeTaskEvent) => void
  spawn?: (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe' }) => ChildProcessWithoutNullStreams
  controlTimeoutMs?: number
  readImage?: (path: string) => Promise<Buffer>
}

export interface ClaudeTaskAnswer {
  behavior: 'allow' | 'deny' | 'answer'
  updatedInput?: Json
  answers?: Record<string, string>
  message?: string
}

/** Persistent ordinary-task CLI session. The wire contract follows the official
 * claude-agent-sdk-python Query control protocol. No PTY or global settings.
 * `send` acknowledges a successful stdin write, not model completion. */
export class ClaudeTaskSession {
  readonly sessionId: string
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private closed = false
  private ready = false
  private active?: string
  private preparing?: { cancel: () => void }
  private submitted = new Set<string>()
  private requests = new Map<string, Json>()
  private answering = new Set<string>()
  private controls = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private stderr = ''

  constructor(private readonly options: ClaudeTaskOptions) {
    if (options.resume && !options.sessionId) throw new Error('Resuming Claude requires a session ID')
    this.sessionId = options.sessionId ?? randomUUID()
  }
  get alive(): boolean { return !!this.child && !this.closed }
  get busy(): boolean { return this.active !== undefined }
  get pid(): number | undefined { return this.child?.pid }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Claude session is closed; create a new driver with resume enabled'))
    return this.starting ??= this.launch()
  }

  private async launch(): Promise<void> {
    const o = this.options
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', o.permissionMode ?? 'manual', o.resume ? '--resume' : '--session-id', this.sessionId]
    for (const [flag, value] of [['--model', o.model], ['--effort', o.effort], ['--system-prompt-file', o.systemPromptFile], ['--append-system-prompt-file', o.appendSystemPromptFile], ['--settings', o.settingsFile], ['--mcp-config', o.mcpConfigFile]]) if (value) args.push(flag!, value)
    for (const directory of o.addDirs ?? []) args.push('--add-dir', directory)
    if (o.chrome !== undefined) args.push(o.chrome ? '--chrome' : '--no-chrome')
    const env = { ...process.env, ...o.env }
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    // Subscription auth must not be overridden by keys inherited from the host.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_API_KEY
    try {
      const child = (o.spawn ?? ((binary, argv, options) => spawn(binary, argv, options)))(o.binary, args, { cwd: o.cwd, env, stdio: 'pipe' })
      this.child = child
      child.stdout.on('data', (chunk: Buffer | string) => this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk)))
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-8192) })
      child.on('error', error => this.fail(new Error(`Cannot run Claude (${o.binary}): ${error.message}`)))
      child.stdin.on('error', error => this.fail(new Error(`Claude input failed: ${error.message}`)))
      child.on('close', (code, signal) => {
        if (this.closed) return
        this.consume(this.decoder.end() + (this.buffer.trim() ? '\n' : ''))
        if (this.closed) return
        const detail = this.stderr.trim()
        this.fail(new Error(`Claude exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : this.busy ? ' before returning a result. Resume this session to continue.' : '. Resume this session to continue.'}`))
      })
      await this.control({ subtype: 'initialize', hooks: null })
      this.ready = true
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async send(text: string, imagePaths: string[] = [], submissionId: string = randomUUID()): Promise<{ submissionId: string; sessionId: string }> {
    if (this.busy) throw new Error('A Claude turn is already in progress')
    if (this.submitted.has(submissionId)) throw new Error('This submission has already been accepted')
    if (!text.trim() && !imagePaths.length) throw new Error('Enter a message or attach an image')
    this.active = submissionId // Reserve before async startup or image loading.
    let cancel!: () => void
    let wasCancelled = false
    const cancellationError = new Error('Claude submission cancelled before acceptance')
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => { wasCancelled = true; reject(cancellationError) } })
    const preparation = { cancel }
    this.preparing = preparation
    try {
      await Promise.race([this.start(), cancelled])
      if (wasCancelled) throw cancellationError
      const content: Json[] = text ? [{ type: 'text', text }] : []
      for (const path of imagePaths) {
        const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extname(path).toLowerCase()]
        if (!mediaType) throw new Error(`Unsupported image format: ${path}. Use PNG, JPEG, GIF, or WebP.`)
        const bytes = await Promise.race([(this.options.readImage ?? readFile)(path), cancelled])
        if (wasCancelled) throw cancellationError
        if (bytes.length > 20 * 1024 * 1024) throw new Error(`Image is too large: ${path}`)
        content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } })
      }
      if (this.closed) throw new Error('Claude session closed before submission')
      // No await between leaving preparation and writing input: interrupts now
      // target an actual submitted CLI turn instead of racing future input.
      this.preparing = undefined
      await this.write({ type: 'user', uuid: submissionId, session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content } })
      this.submitted.add(submissionId)
      this.emit({ type: 'turn-start', submissionId, sessionId: this.sessionId })
      return { submissionId, sessionId: this.sessionId }
    } catch (error) { if (this.active === submissionId) this.active = undefined; throw error }
    finally { if (this.preparing === preparation) this.preparing = undefined }
  }

  async answer(requestId: string, decision: ClaudeTaskAnswer): Promise<void> {
    const request = this.requests.get(requestId)
    if (!request) throw new Error(`Unknown or resolved Claude request: ${requestId}`)
    if (this.answering.has(requestId)) throw new Error('An answer is already being submitted for this request')
    const question = request.tool_name === 'AskUserQuestion'
    if (question && decision.behavior !== 'deny' && !decision.answers && !decision.updatedInput?.answers) throw new Error('Question responses require structured answers')
    if (!question && decision.behavior === 'answer') throw new Error('This request requires an allow or deny decision')
    const response = decision.behavior === 'deny'
      ? { behavior: 'deny', message: decision.message ?? 'The user declined this request' }
      : { behavior: 'allow', updatedInput: { ...request.input, ...decision.updatedInput, ...(decision.answers ? { answers: decision.answers } : {}) } }
    this.answering.add(requestId)
    try {
      await this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
      if (this.requests.delete(requestId)) this.emit({ type: 'request-resolved', requestId })
    } finally { this.answering.delete(requestId) }
  }

  async interrupt(): Promise<void> {
    if (this.preparing) { this.preparing.cancel(); return }
    if (!this.alive || !this.busy) return
    await this.control({ subtype: 'interrupt' })
    // Only a result frame ends the turn. An acknowledgement is not completion.
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.preparing?.cancel()
    this.ready = false
    this.active = undefined
    for (const [requestId] of this.requests) this.emit({ type: 'request-resolved', requestId })
    this.requests.clear()
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(new Error('Claude session closed')) }
    this.controls.clear()
    const child = this.child
    if (child) {
      child.stdin.end()
      child.kill('SIGTERM')
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 2000)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
    }
    this.emit({ type: 'closed' })
  }

  private emit(event: ClaudeTaskEvent): void { this.options.onEvent(event) }
  private fail(error: Error): void {
    if (this.closed) return
    this.emit({ type: 'error', message: error.message })
    this.close()
  }
  private write(message: Json): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.child?.stdin.writable) { reject(new Error('Claude input is not writable')); return }
      this.child.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error) { this.fail(new Error(`Claude input failed: ${error.message}`)); reject(error) } else resolve()
      })
    })
  }
  private control(request: Json): Promise<void> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(requestId)
        const error = new Error(`Claude ${request.subtype} timed out. Close and resume the session.`)
        reject(error); this.fail(error)
      }, this.options.controlTimeoutMs ?? 60_000)
      this.controls.set(requestId, { resolve, reject, timer })
      void this.write({ type: 'control_request', request_id: requestId, request }).catch(error => {
        clearTimeout(timer); this.controls.delete(requestId); reject(error)
      })
    })
  }
  private consume(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error('Claude JSON frame exceeds the 32 MB limit')); return }
    let newline: number
    while (!this.closed && (newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let frame: Json
      try { frame = JSON.parse(line); if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') throw new Error('Missing type') }
      catch { this.fail(new Error('Claude returned invalid JSON. Check the CLI version and restart the session.')); return }
      this.receive(frame)
    }
  }
  private receive(frame: Json): void {
    if (frame.session_id && frame.session_id !== this.sessionId) { this.fail(new Error('Claude returned a different session ID; refusing to mix conversations')); return }
    if (frame.type === 'control_response') {
      const response = frame.response ?? {}; const pending = this.controls.get(response.request_id)
      if (pending) {
        clearTimeout(pending.timer); this.controls.delete(response.request_id)
        if (response.subtype === 'error') pending.reject(new Error(String(response.error ?? 'Claude control request failed')))
        else pending.resolve()
      }
      return
    }
    if (frame.type === 'control_cancel_request') {
      if (this.requests.delete(frame.request_id)) this.emit({ type: 'request-resolved', requestId: frame.request_id })
      return
    }
    if (frame.type === 'control_request') {
      const request = frame.request ?? {}; const requestId = frame.request_id
      if (typeof requestId !== 'string' || this.requests.has(requestId)) { this.fail(new Error('Claude sent an invalid or duplicate control request ID')); return }
      if (request.subtype !== 'can_use_tool') {
        void this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported control request: ${request.subtype}` } }).catch(error => this.fail(error))
        this.emit({ type: 'error', message: `Claude requested unsupported control operation: ${request.subtype}` })
        return
      }
      this.requests.set(requestId, request)
      this.emit({ type: 'request', requestId, kind: request.tool_name === 'AskUserQuestion' ? 'question' : 'permission', tool: request.tool_name, input: request.input ?? {}, payload: request })
      return
    }
    this.emit({ type: 'message', message: frame })
    if (frame.type === 'stream_event' && frame.event?.delta?.type === 'text_delta') this.emit({ type: 'delta', text: frame.event.delta.text, message: frame })
    if (frame.type === 'result') {
      const submissionId = this.active; this.active = undefined
      this.emit({ type: 'result', message: frame, submissionId })
      if (frame.is_error) {
        const message = (frame.errors ?? [frame.result ?? 'Claude turn failed']).join('\n')
        this.emit({ type: 'error', message })
        if (!this.ready) this.fail(new Error(message))
      }
    }
  }
}
