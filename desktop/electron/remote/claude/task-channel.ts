import { blocksFromClaudeTranscript } from '../blocks-claude'
import type { CodexPatch } from '../codex/app-server-events'
import type { ClaudeTaskEvent, ClaudeTaskSession } from './task-session'
import type { TaskInput } from '../task-input'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sameQuestion, type QuestionReference } from '../question-reference'
import { mergeClaudeHistory } from './chat-history'

type Frame = Record<string, any>
type Request = Extract<ClaudeTaskEvent, { type: 'request' }> & { index: number; answers: Record<string, string> }

function normalizeFrame(frame: Frame): Frame {
  if (frame.type !== 'system' || frame.subtype !== 'compact_boundary' || !frame.compact_metadata) return frame
  const metadata = frame.compact_metadata
  return { ...frame, compactMetadata: { ...metadata, ...frame.compactMetadata,
    ...(typeof metadata.pre_tokens === 'number' ? { preTokens: metadata.pre_tokens } : {}),
    ...(typeof metadata.post_tokens === 'number' ? { postTokens: metadata.post_tokens } : {}),
  } }
}

/** Adapts Claude's structured messages, not terminal text, to the shared chat.
 * Persist only completed protocol frames; partial deltas are replaceable views. */
export class ClaudeTaskChannel {
  private frames: Frame[] = []
  private ids = new Set<string>()
  private partial = new Map<number, Frame>()
  private requests: Request[] = []
  private answering = false
  private answeringReference?: QuestionReference
  private generation = randomUUID()
  private ended = false
  private compacting = false
  private cancelling = false
  private resultError?: string
  private renderTimer?: ReturnType<typeof setTimeout>
  private serializedFrames = ''
  private submissions = new Map<string, TaskInput[]>()
  constructor(private patch: (patch: CodexPatch) => void, private persist?: (frames: Frame[]) => void) {}

  /** Display projection only. Persisted provider text stays complete. */
  static displayTranscript(frames: Frame[]): string {
    return frames.map(normalizeFrame).map(f => JSON.stringify(f.type === 'user' && typeof f.unmuteDisplayText === 'string'
      ? { ...f, message: { ...f.message, content: [{ type: 'text', text: f.unmuteDisplayText }] } } : f)).join('\n')
  }

  restore(frames: Frame[]): void {
    this.frames = frames.filter(f => f && ['user', 'assistant', 'system'].includes(f.type)).map(normalizeFrame)
    this.ids = new Set(this.frames.map(f => f.uuid).filter(Boolean))
    this.serializedFrames = ClaudeTaskChannel.displayTranscript(this.frames)
    this.render()
  }
  get pending(): boolean { return this.requests.length > 0 }
  requestStop(): void { this.cancelling = true; this.patch({ activity: { kind: 'lifecycle', label: 'Cancelling' } }) }
  mergeHistory(frames: Frame[]): void {
    // Keep the checkpoint at its original boundary. Moving a fresh checkpoint
    // past newly recovered results would hide those results again.
    this.restore(mergeClaudeHistory(this.frames, frames))
    this.persist?.(this.frames)
  }
  expectSubmission(id: string, parts: TaskInput[]): void { this.submissions.set(id, parts) }

  event(event: ClaudeTaskEvent): void {
    if (event.type === 'message') {
      let f = normalizeFrame(event.message)
      if (f.type === 'system' && Array.isArray(f.mcp_servers)) {
        for (const server of f.mcp_servers) if (typeof server.name === 'string' && typeof server.status === 'string') {
          this.patch({ mcpStatus: { name: server.name, status: server.status,
            ...(typeof server.error === 'string' ? { error: server.error } : {}),
            ...(server.status === 'needs-auth' ? { remedy: 'Authenticate this MCP connection in Claude, then retry.' } : {}) } })
        }
      }
      if (f.type === 'system' && f.subtype === 'status' && (f.status === 'compacting' || f.status === null)) {
        this.compacting = f.status === 'compacting'
        if (!this.ended && !this.requests.length) this.patch({ activity: this.compacting ? { kind: 'lifecycle', label: 'Compacting context' } : null })
      }
      if (f.type === 'user') {
        const parts = this.submissions.get(f.uuid)
        const attachments = parts?.flatMap(p => p.type === 'image' ? [{ path: p.path, name: p.name ?? basename(p.path), mimeType: p.mimeType ?? `image/${extname(p.path).slice(1).replace('jpg', 'jpeg')}`, bytes: p.bytes }] : p.attachment ? [p.attachment] : [])
        f = { ...f, ...(attachments?.length ? { unmuteAttachments: attachments, unmuteDisplayText: parts!.filter(p => p.type === 'text' && !p.attachment).map(p => p.type === 'text' ? p.text : '').join('') } : {}), message: { ...f.message,
          content: Array.isArray(f.message?.content) ? f.message.content.map((p: Frame) => p.type === 'image' ? { type: 'image', source: { type: 'omitted-from-display' } } : p) : f.message?.content,
        } }
        this.submissions.delete(f.uuid)
      }
      if (f.type === 'stream_event') {
        const e = f.event ?? {}, index = Number(e.index ?? 0)
        if (e.type === 'message_start') this.partial.clear()
        if (e.type === 'content_block_start') this.partial.set(index, { ...e.content_block })
        if (e.type === 'content_block_delta') {
          const d = e.delta ?? {}, part = this.partial.get(index) ?? { type: d.type === 'thinking_delta' ? 'thinking' : 'text' }
          if (d.type === 'text_delta') part.text = (part.text ?? '') + d.text
          if (d.type === 'thinking_delta') part.thinking = (part.thinking ?? '') + d.thinking
          this.partial.set(index, part)
        }
        this.scheduleRender()
      } else if (['assistant', 'user', 'system'].includes(f.type)) {
        if (f.uuid && this.ids.has(f.uuid)) return
        if (f.uuid) this.ids.add(f.uuid)
        this.frames.push(f)
        this.serializedFrames += `${this.serializedFrames ? '\n' : ''}${ClaudeTaskChannel.displayTranscript([f])}`
        if (f.type === 'assistant') this.partial.clear()
        this.persist?.(this.frames)
        this.render()
      }
    } else if (event.type === 'turn-start') {
      this.ended = false
      this.cancelling = false; this.resultError = undefined
      this.frames.push({ type: 'system', uuid: `unmute-start:${event.submissionId}`, unmuteTurnStart: Date.now() })
      this.serializedFrames = ClaudeTaskChannel.displayTranscript(this.frames)
      this.persist?.(this.frames)
      this.patch({ turnOutcome: null, errorReason: '' })
      this.present()
    } else if (event.type === 'request') {
      this.requests.push({ ...event, index: 0, answers: {} })
      if (this.requests.length === 1) this.present()
    } else if (event.type === 'request-resolved') {
      this.requests = this.requests.filter(r => r.requestId !== event.requestId)
      this.present()
    } else if (event.type === 'result') {
      this.ended = true
      this.requests = []
      this.finishPartial()
      this.resultError = event.message.is_error ? (event.message.errors ?? [event.message.result ?? 'Claude failed']).join('\n') : undefined
      const cancelled = event.message.interrupted === true || ['cancelled', 'interrupted'].includes(event.message.status)
        || !!(this.resultError && /\b(interrupted by user|cancelled by user|canceled by user)\b/i.test(this.resultError))
      const outcome = cancelled ? 'cancelled' : event.message.is_error ? 'failed' : 'completed'
      this.frames.push({ type: 'system', uuid: `unmute-end:${event.submissionId ?? this.frames.length}`, unmuteTurnEnd: outcome, durationMs: event.message.duration_ms })
      this.serializedFrames = ClaudeTaskChannel.displayTranscript(this.frames)
      this.persist?.(this.frames); this.render()
      this.patch({ state: cancelled ? 'done' : event.message.is_error ? 'failed' : 'done', turnOutcome: outcome, activity: null, clearQuestion: true,
        ...(cancelled ? { errorReason: '' } : event.message.is_error ? { errorReason: this.resultError } : { assistantText: event.message.result || undefined }) })
    } else if (event.type === 'error') {
      if (this.ended && event.message === this.resultError) return
      this.ended = true
      this.requests = []
      this.finishPartial()
      this.patch({ state: 'failed', activity: null, clearQuestion: true, errorReason: event.message })
    } else if (event.type === 'closed') {
      if (this.renderTimer) clearTimeout(this.renderTimer)
      this.renderTimer = undefined
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.render() }, 33)
    this.renderTimer.unref?.()
  }

  private finishPartial(): void {
    if (this.partial.size) {
      const frame = { type: 'assistant', message: { content: [...this.partial.values()] } }
      this.frames.push(frame)
      this.serializedFrames += `${this.serializedFrames ? '\n' : ''}${JSON.stringify(frame)}`
      this.persist?.(this.frames)
      this.partial.clear()
    }
    this.render()
  }

  private render(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = undefined
    const partial = this.partial.size ? '\n' + JSON.stringify({ type: 'assistant', message: { content: [...this.partial.values()] } }) : ''
    const parsed = blocksFromClaudeTranscript(this.serializedFrames + partial)
    this.patch({ blocks: parsed.blocks, ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(this.frames.some(f => f.type === 'user' || f.type === 'assistant') && !this.frames.some(f => f.unmuteHistoryIncomplete)
        ? { history: { phase: 'ready' as const } } : {}) })
  }

  private present(): void {
    if (this.ended) return
    const r = this.requests[0]
    if (!r) { this.patch({ clearQuestion: true, state: 'processing', activity: { kind: 'lifecycle', label: this.cancelling ? 'Cancelling' : this.compacting ? 'Compacting context' : 'Working' } }); return }
    const q = r.kind === 'question' ? r.input.questions?.[r.index] : undefined
    const options = q?.options?.map((o: Frame) => String(o.label))
    const reference = { requestId: `${this.generation}:${r.requestId}`, stepId: String(r.index) }
    this.patch({ state: 'needs-user', activity: null, question: {
      reference,
      ...(sameQuestion(this.answeringReference, reference) ? { acknowledgment: 'pending' as const } : {}),
      text: q?.question ?? `Allow ${r.tool}?`,
      ...(r.kind === 'permission' ? { details: `${JSON.stringify(r.input, null, 2)}\n\nThis Claude adapter supports Allow once and Deny. Broader session approval is unavailable for this request.` } : {}),
      kind: options?.length || r.kind === 'permission' ? 'choice' : 'free_text',
      ...(r.kind === 'permission' ? { choices: ['Allow once', 'Deny'] } : options?.length ? { choices: options } : {}),
    } })
  }

  async answer(text: string, driver: ClaudeTaskSession, expected?: QuestionReference): Promise<boolean> {
    const r = this.requests[0]
    if (!r || this.answering || !text.trim()) return false
    if (expected && !sameQuestion(expected, { requestId: `${this.generation}:${r.requestId}`, stepId: String(r.index) })) return false
    if (r.kind === 'question') {
      const questions = r.input.questions
      if (!Array.isArray(questions) || !questions[r.index]?.question) throw new Error('Claude returned an unsupported question. Stop this turn and retry.')
      r.answers[questions[r.index].question] = text
      if (r.index + 1 < questions.length) { r.index++; this.present(); return true }
    } else if (!['Allow once', 'Deny'].includes(text)) {
      throw new Error('Choose Allow once or Deny to answer this permission request')
    }
    this.answering = true
    this.answeringReference = { requestId: `${this.generation}:${r.requestId}`, stepId: String(r.index) }
    this.present()
    try {
      await driver.answer(r.requestId, r.kind === 'question' ? { behavior: 'answer', answers: r.answers } : { behavior: text === 'Allow once' ? 'allow' : 'deny' })
      // Real drivers emit request-resolved synchronously; this also supports
      // adapters whose acknowledgment is the returned promise.
      if (this.requests[0] === r) { this.requests.shift(); this.present() }
      return true
    } finally { this.answering = false; this.answeringReference = undefined; this.present() }
  }
}
