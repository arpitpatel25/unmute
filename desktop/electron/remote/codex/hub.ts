/**
 * CODEX CLI — one App Server, many tasks.
 *
 * The layer between `CodexAppServer` (a socket) and `TaskManager` (tasks). It
 * owns the single server process, maps threads to task ids, folds the event
 * stream through `reduceAppServerEvent`, and hands the result back as patches.
 *
 * LAZY, NOT AT LAUNCH. The server starts on the first Codex CLI task and stays
 * warm for the life of the app. Starting it when unmute starts would put a
 * Codex process on every machine at login — including the large majority who
 * never touch Codex CLI — and unmute's launch path sits next to the capture
 * path, which must never wait on someone else's binary.
 *
 * ONE SERVER, MANY THREADS, because permissions are per-thread (`thread/start`
 * takes approvalPolicy, sandbox, model, cwd). A server per task would be a
 * process per task for no isolation we do not already have.
 *
 * ROUTING IS BY threadId, NOT BY WHO ASKED. Notifications arrive on one socket
 * for every thread, so each is dispatched to the task that owns that thread. A
 * notification for a thread we do not know is dropped with a log rather than
 * applied to whichever task happens to be current — that mistake would show one
 * task's output on another's card, which is worse than showing nothing.
 */

import { CodexAppServer, type ServerRequest } from './app-server-client'
import { CodexBlockStream, type CodexInputMetadata } from './blocks-app-server'
export type { CodexInputMetadata } from './blocks-app-server'
import {
  reduceAppServerEvent, questionFromApproval, approvalDecision, approvalOptions, responseForApproval,
  type CodexPatch,
} from './app-server-events'
import { createLogger } from '../log'
import { sameQuestion, type QuestionReference } from '../question-reference'
import type { TaskInput } from '../task-input'
import type { FollowupGate, FollowupTurnEnded, NewTurnOutcome } from '../task-followup'
import { randomUUID } from 'node:crypto'
import { codexExtraRoots } from '../skill-catalog'
import { appliedPosture, clampPosture, learnFromRejection, mergeRequirements, requirementsFrom, type CodexRequirements } from './requirements'
import { codexLimit } from '../permission-ceiling'

const log = createLogger('codex-hub')

/** What the task layer receives. A patch plus the task it belongs to. */
export interface HubPatch extends CodexPatch { taskId: string }
interface HistoryTurn { id: string; status?: string; startedAt?: number; durationMs?: number; itemsView?: string; items?: Record<string, unknown>[] }
interface ResumeHistory {
  thread?: { id?: string; forkedFromId?: string; turns?: HistoryTurn[] }
  turnsBackwardsCursor?: string | null
  itemsBackwardsCursor?: string | null
}
interface FormField { id: string; title: string; required: boolean; schema: Record<string, unknown>; options?: Array<{ label: string; value: string }> }
function validRfc3339(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m) return false
  const [, y, mo, d, h, mi, sec, zone] = m
  const year = +y, month = +mo, day = +d
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || +h > 23 || +mi > 59 || +sec > 60) return false
  if (!/^[Zz]$/.test(zone) && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return false
  if (+sec === 60) {
    const before = new Date(`${y}-${mo}-${d}T${h}:${mi}:59${zone.toUpperCase()}`)
    const next = new Date(before.getTime() + 1000)
    return before.getUTCHours() === 23 && before.getUTCMinutes() === 59 && next.getUTCDate() === 1
  }
  return true
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function enumOptions(schema: Record<string, unknown>): Array<{ label: string; value: string }> | undefined {
  if (Array.isArray(schema.enum) && schema.enum.every(v => typeof v === 'string')) return schema.enum.map((v, i) => ({ value: v, label: Array.isArray(schema.enumNames) && typeof schema.enumNames[i] === 'string' ? schema.enumNames[i] : v }))
  const choices = schema.oneOf ?? schema.anyOf
  if (Array.isArray(choices) && choices.every(v => typeof object(v).const === 'string')) return choices.map(v => ({ value: object(v).const as string, label: String(object(v).title ?? object(v).const) }))
  return undefined
}
function formFields(params: Record<string, unknown>): FormField[] {
  const schema = object(params.requestedSchema)
  if (!['form', 'openai/form', 'openaiForm'].includes(String(params.mode)) || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') throw new Error('Only primitive MCP forms are supported; URL and unknown forms require another client')
  if (Object.keys(schema).some(k => !['type', 'properties', 'required', '$schema', 'additionalProperties'].includes(k))) throw new Error('Unsupported MCP object constraint')
  const properties = object(schema.properties)
  const required = schema.required ?? []
  if (!Array.isArray(required) || required.some(k => typeof k !== 'string' || !Object.hasOwn(properties, k))) throw new Error('Malformed MCP required fields')
  const supported = (s: Record<string, unknown>, nested = false): boolean => {
    if (Object.keys(s).some(k => !['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'anyOf', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'format'].includes(k))) return false
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (s[key] !== undefined && s[key] !== null && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) return false
    const options = enumOptions(s)
    if ((s.enum || s.oneOf || s.anyOf) && !options?.length) return false
    if (options && new Set(options.map(o => o.label)).size !== options.length) return false
    if (s.type === 'array') return !nested && supported(object(s.items), true)
    if (!['string', 'number', 'integer', 'boolean'].includes(String(s.type)) && !(nested && options)) return false
    if (s.format && !['email', 'uri', 'date', 'date-time'].includes(String(s.format))) return false
    return true
  }
  return Object.entries(properties).map(([id, raw]) => {
    const field = object(raw)
    if (!supported(field)) throw new Error(`Unsupported MCP field schema: ${id}`)
    return { id, title: String(field.title ?? id), required: required.includes(id), schema: field, options: enumOptions(field) }
  })
}
function validateFormValue(value: unknown, schema: Record<string, unknown>): void {
  const options = enumOptions(schema)
  if (options && !options.some(o => o.value === value)) throw new Error('Choose one of the listed values')
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error('Enter a JSON array')
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error('Array length is outside the allowed range')
    if (schema.uniqueItems === true && new Set(value.map(v => JSON.stringify(v))).size !== value.length) throw new Error('Array values must be unique')
    for (const entry of value) validateFormValue(entry, object(schema.items))
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error('Enter text')
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength || typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) throw new Error('Text length is outside the allowed range')
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter an email address')
    if (schema.format === 'uri') { try { new URL(value) } catch { throw new Error('Enter an absolute URL') } }
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('Enter a valid YYYY-MM-DD date')
    if (schema.format === 'date-time' && !validRfc3339(value)) throw new Error('Enter an RFC 3339 date and time with a timezone, such as 2026-09-05T12:30:00+05:30')
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error('Choose true or false')
  else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value)) throw new Error('Enter a valid number')
    if (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum) throw new Error('Number is outside the allowed range')
  }
}

export interface StartThreadOpts {
  cwd: string
  /** Wire model id ('gpt-5.6-terra'), or undefined for Codex's own default. */
  model?: string
  /** Wire effort ('xhigh'). Only meaningful with a model. */
  effort?: string
  /** 'never' | 'on-request' | 'untrusted' */
  approvalPolicy: string
  /** 'read-only' | 'workspace-write' | 'danger-full-access' */
  sandbox: string
  writableRoots?: string[]
  config?: Record<string, unknown>
}

interface PendingRequest {
  choicesSignature?: string
  identity: string
  id: number | string
  method: string
  resolve: (v: unknown) => void
  params: Record<string, unknown>
  questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>
  answers: Record<string, { answers: string[] }>
  index: number
  respond?: ServerRequest['respond']
  awaitingReplay?: boolean
  form?: { fields: FormField[]; content: Record<string, unknown> }
  validationError?: string
}

interface ThreadState {
  taskId: string
  threadId: string
  /** The blocking request we are waiting on the user for, if any. Held so the
   *  answer can be routed to the right JSON-RPC id — an approval answered
   *  against the wrong id leaves Codex blocked forever while the card reports
   *  itself unblocked. */
  pending: PendingRequest | null
  pendingQueue?: PendingRequest[]
  turnId?: string
  submitting?: boolean
  disconnected?: boolean
  submissionFinished?: Promise<void>
  stopping?: boolean
  completedTurns?: Set<string>
  options?: StartThreadOpts
  /** What Unmute asked for before this machine's policy lowered it. */
  asked?: { approvalPolicy: string; sandbox: string }
  /** The chat view for this thread, built as the notifications arrive. This is
   *  the RICHEST source any lane has — reasoning, commands with exit codes,
   *  diffs and a live plan, streamed rather than read back off disk. */
  blocks: CodexBlockStream
}

export interface CodexHubDeps {
  /** Durable identity receipt for ordinary start/resume acknowledgements. */
  onThreadConfirmed?: (taskId: string, threadId: string) => Promise<void>
  /** Durable identity receipt, before potentially large history processing. */
  onForkConfirmed?: (taskId: string, result: { threadId: string; forkedFromId: string }, operationId?: string) => Promise<void>
  approvalCap?: (taskId: string) => import('./app-server-events').ApprovalCap
  loadPlans?: (taskId: string, threadId: string) => Promise<Array<Extract<import('../blocks').Block, { kind: 'plan' }>>>
  savePlans?: (taskId: string, threadId: string, plans: Array<Extract<import('../blocks').Block, { kind: 'plan' }>>) => Promise<void>
  /** Resolves the `codex` binary. Injected so the hub owns no PATH logic. */
  resolveBin: () => Promise<string | null>
  /** Where patches go. */
  onPatch: (p: HubPatch) => void
  /** For tests. */
  makeServer?: (bin: string) => CodexAppServer
  /** Fresh per-task instructions and MCP credentials; never persisted. */
  threadConfig?: (taskId: string) => Promise<Record<string, unknown>>
  loadInputMetadata?: (taskId: string, threadId: string) => Promise<CodexInputMetadata[]>
  /** Upsert by record.id before delivery, then correlate turnId after acknowledgement. */
  saveInputMetadata?: (taskId: string, threadId: string, record: CodexInputMetadata) => Promise<void>
}

export class CodexHub {
  /** Remote adapters refresh their projection after the manager saves identity. */
  async refreshTask(_taskId: string): Promise<void> {}
  /** Return a durable task→thread identity without acquiring writer ownership. */
  async recoverIdentity(_taskId: string, _sourceThreadId?: string): Promise<{ taskId: string; threadId: string; forkedFromId?: string } | null> { return null }
  private followupListeners = new Set<(event: { type: 'ended'; event: FollowupTurnEnded } | { type: 'changed' | 'disarm'; taskId: string }) => void>()
  private generations = new WeakMap<ThreadState, number>()
  private nextGeneration = 0
  onFollowup(listener: (event: { type: 'ended'; event: FollowupTurnEnded } | { type: 'changed' | 'disarm'; taskId: string }) => void): () => void {
    this.followupListeners.add(listener); return () => this.followupListeners.delete(listener)
  }
  private generation(st: ThreadState): number {
    if (!this.generations.has(st)) this.generations.set(st, ++this.nextGeneration)
    return this.generations.get(st)!
  }
  private followupChanged(taskId: string, disarm = false): void { for (const cb of this.followupListeners) cb({ type: disarm ? 'disarm' : 'changed', taskId }) }
  followupGate(taskId: string): FollowupGate {
    const st = this.byTask.get(taskId)
    if (!st || st.disconnected || !this.server?.running || st.stopping || st.submitting) return { kind: 'unavailable', reason: 'Codex is connecting or its delivery state is uncertain.' }
    const blocked = !!st.pending || !!st.pendingQueue?.length
    const generation = this.generation(st)
    return st.turnId ? { kind: 'active', fence: { sessionId: st.threadId, generation, turnId: st.turnId }, blocked }
      : { kind: 'idle', sessionId: st.threadId, generation, blocked }
  }
  async sendNewTurn(taskId: string, text: string, input: TaskInput[], expected: { sessionId: string; generation: number }): Promise<NewTurnOutcome> {
    const gate = this.followupGate(taskId)
    if (gate.kind !== 'idle' || gate.blocked || gate.sessionId !== expected.sessionId || gate.generation !== expected.generation) return { kind: 'not-sent', reason: 'Codex is not ready for this queued turn.' }
    return this.sendAttempt(taskId, text, input.length ? { ordered: input } : {})
  }
  private server: CodexAppServer | null = null
  private byThread = new Map<string, ThreadState>()
  private byTask = new Map<string, ThreadState>()
  private mcpStatuses = new Map<string, import('./app-server-events').McpStatus>()
  private planWrites = new Map<string, Promise<void>>()
  private starting: Promise<CodexAppServer> | null = null
  /** What this machine's administrator allows (codex/requirements.ts): the
   *  last `configRequirements/read` answer, narrowed by anything Codex has
   *  refused on this server. Both null when unmanaged. */
  private readRequirements: CodexRequirements | null = null
  private learnedRequirements: CodexRequirements | null = null
  private get requirements(): CodexRequirements | null { return mergeRequirements(this.readRequirements, this.learnedRequirements) }
  private registrations = 0
  private earlyNotifications: Array<{ method: string; params?: Record<string, unknown> }> = []
  private earlyRequests: Array<{ req: ServerRequest; source: CodexAppServer | null; resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = []

  private finishRegistration(): void {
    this.registrations--
    if (this.registrations) return
    for (const m of this.earlyNotifications.splice(0)) this.onNotification(m)
    for (const r of this.earlyRequests.splice(0)) this.onServerRequest(r.req, r.source).then(r.resolve, r.reject)
    for (const st of this.byTask.values()) for (const mcpStatus of this.mcpStatuses.values()) this.deps.onPatch({ taskId: st.taskId, mcpStatus })
  }

  constructor(private deps: CodexHubDeps) {}

  /** The URL a TUI attaches to (`codex resume <id> --remote <url>`). */
  get url(): string { return this.server?.url ?? '' }
  get running(): boolean { return !!this.server?.running }

  /** Start the server if it is not up. Coalesced — several tasks dispatching at
   *  once must not each spawn a Codex. */
  private async ensure(): Promise<CodexAppServer> {
    if (this.server?.running) return this.server
    if (this.starting) return this.starting
    this.starting = (async () => {
      // A new server has no loaded threads. Old mappings cannot make resume
      // mistakenly succeed against this unrelated connection.
      const bin = await this.deps.resolveBin()
      if (!bin) throw new Error('CODEX_NOT_FOUND')
      this.server?.stop()
      const srv = this.deps.makeServer ? this.deps.makeServer(bin) : new CodexAppServer({ bin })
      this.server = srv
      srv.on('*', (m) => { if (this.server === srv) this.onNotification(m as { method: string; params?: Record<string, unknown> }) })
      srv.onRequest((r) => this.onServerRequest(r, srv))
      await srv.start()
      this.server = srv
      // CLAUDE'S SKILLS, ANSWERABLE TO `$name`. Codex resolves a skill by name
      // against the roots it knows, so a skill it cannot see is a turn that
      // reads the token as prose. Best-effort and never fatal: a Codex too old
      // to know the method still has to carry the user's work.
      try { await srv.request('skills/extraRoots/set', { extraRoots: codexExtraRoots() }) }
      catch (error) { log.warn('skill roots not set', { error: (error as Error).message }) }
      // A MANAGED MACHINE REFUSES, IT DOES NOT DOWNGRADE. Every request below
      // is clamped to these, so full access on a company laptop becomes the
      // most that laptop allows instead of a session that never starts.
      this.learnedRequirements = null
      await this.refreshRequirements(srv)
      return srv
    })().finally(() => { this.starting = null })
    return this.starting
  }

  /** Re-read on every new session, not once per server: an administrator can
   *  change the policy while Unmute runs, and the query is cheap. */
  private async refreshRequirements(srv: CodexAppServer): Promise<void> {
    try { this.readRequirements = requirementsFrom(await srv.request('configRequirements/read', {})) }
    catch (error) { log.warn('codex requirements not read', { error: (error as Error).message }) }
  }

  /** Lower a requested posture to what this machine allows. */
  private allowed(taskId: string, o: StartThreadOpts): StartThreadOpts {
    const next = clampPosture(o, this.requirements)
    if (next !== o) log.event('codex-posture-clamped', { taskId, asked: { approvalPolicy: o.approvalPolicy, sandbox: o.sandbox }, allowed: { approvalPolicy: next.approvalPolicy, sandbox: next.sandbox } })
    return next
  }

  /**
   * Send a thread request at the most this machine allows. If Codex refuses it
   * anyway — a policy the up-front query did not show — learn the allowed set
   * from the refusal and retry. At most one retry per dial, and only for a
   * refusal, which Codex returns before creating anything.
   */
  private async withPolicy<T>(taskId: string, asked: StartThreadOpts, send: (o: StartThreadOpts) => Promise<T>): Promise<{ res: T; o: StartThreadOpts }> {
    for (let attempt = 0; ; attempt++) {
      const o = this.allowed(taskId, asked)
      try { return { res: await send(o), o } }
      catch (error) {
        if (!this.learn(taskId, error, attempt) || this.allowed(taskId, asked).sandbox === o.sandbox && this.allowed(taskId, asked).approvalPolicy === o.approvalPolicy) throw error
      }
    }
  }

  private learn(taskId: string, error: unknown, attempt: number): boolean {
    const learned = attempt < 2 ? learnFromRejection((error as Error)?.message ?? '', this.learnedRequirements) : null
    if (!learned) return false
    this.learnedRequirements = learned
    log.event('codex-policy-learned', { taskId, allowedSandboxModes: learned.allowedSandboxModes ?? null, allowedApprovalPolicies: learned.allowedApprovalPolicies ?? null })
    return true
  }

  /** Tell the task what Codex actually applied when it is less than asked, so
   *  no surface claims a level this machine does not allow. */
  private reportPosture(taskId: string, asked: { approvalPolicy: string; sandbox: string }, applied: { approvalPolicy: string; sandbox: string }): void {
    const lower = applied.sandbox !== asked.sandbox || applied.approvalPolicy !== asked.approvalPolicy
    this.deps.onPatch({ taskId, permissionLimit: lower ? codexLimit(asked, applied) : null })
  }

  /**
   * Create a thread for a task and return its id plus the URL a terminal can
   * attach to.
   *
   * The permissions travel WITH the thread. That is what lets one server host a
   * full-access errand and a fenced session at the same time, and it is why
   * unmute never has to write a profile into the user's ~/.codex.
   */
  async startThread(taskId: string, asked: StartThreadOpts): Promise<{ threadId: string; url: string }> {
    const srv = await this.ensure()
    await this.refreshRequirements(srv)
    let o = asked
    const config = { ...o.config, ...await this.deps.threadConfig?.(taskId) }
    // A MODEL ID IS NEVER A SENTENCE.
    //
    // 'gpt-5.6-terra high' — the display record, model and effort joined for a
    // card — reached this call once and every task died at the API with "model
    // is not supported when using Codex with a ChatGPT account". The caller was
    // fixed; this refuses the whole CLASS, because the next thing to hand a
    // human-readable string to a machine field will not be that caller.
    //
    // Dropped rather than rejected: no model means Codex's own default, which
    // runs. Failing the task over a display bug would turn a wrong label into
    // no work at all.
    const model = o.model && /\s/.test(o.model) ? undefined : o.model
    if (o.model && !model) {
      log.error('refused a model id containing whitespace — that is a label, not an id', { taskId, got: o.model })
    }
    this.registrations++
    try {
    const sent = await this.withPolicy(taskId, asked, next => srv.request<Record<string, unknown>>('thread/start', {
      cwd: next.cwd,
      approvalPolicy: next.approvalPolicy,
      sandbox: next.sandbox,
      config,
      ...(model ? { model } : {}),
    }))
    const res = sent.res
    // Keep what we ASKED (already clamped): if Codex quietly applied less at
    // thread start, the next turn's refusal teaches the real allowed set
    // instead of this thread settling below it. Show what was applied.
    o = sent.o
    const applied = appliedPosture(res, sent.o)
    const threadId = String(res?.threadId ?? (res?.thread as { id?: string } | undefined)?.id ?? res?.id ?? '')
    if (!threadId) throw new Error('thread/start returned no thread id')
    await this.deps.onThreadConfirmed?.(taskId, threadId)
    const { config: _config, ...options } = o
    const st: ThreadState = { taskId, threadId, pending: null, blocks: new CodexBlockStream(), options: { ...options, model }, asked }
    this.byThread.set(threadId, st)
    this.byTask.set(taskId, st)
    this.reportPosture(taskId, asked, applied)
    log.event('codex-thread-started', { taskId, threadId, cwd: o.cwd, model: o.model ?? null, effort: o.effort ?? null, approvalPolicy: o.approvalPolicy, sandbox: o.sandbox })
    return { threadId, url: srv.url }
    } finally { this.finishRegistration() }
  }

  /** Create a provider-native child. The returned child identity is
   * authoritative; a fork is never emulated by starting a blank thread. */
  async forkThread(taskId: string, sourceThreadId: string, o: StartThreadOpts, operationId?: string): Promise<{
    threadId: string
    forkedFromId: string
  }> {
    const srv = await this.ensure()
    await this.refreshRequirements(srv)
    const asked = o
    const config = { ...o.config, ...await this.deps.threadConfig?.(taskId) }
    const model = o.model && /\s/.test(o.model) ? undefined : o.model
    this.registrations++
    try {
      const sent = await this.withPolicy(taskId, asked, next => srv.request<ResumeHistory>('thread/fork', {
        threadId: sourceThreadId,
        cwd: next.cwd,
        approvalPolicy: next.approvalPolicy,
        sandbox: next.sandbox,
        config,
        ...(model ? { model } : {}),
      }))
      const result = sent.res
      o = sent.o
      const applied = appliedPosture(result, sent.o)
      const threadId = String(result.thread?.id ?? '')
      if (!threadId) throw new Error('thread/fork returned no child thread id')
      if (threadId === sourceThreadId) throw new Error('Codex fork returned the same thread as its source')
      if (result.thread?.forkedFromId && result.thread.forkedFromId !== sourceThreadId) {
        throw new Error('Codex fork returned inconsistent source identity')
      }
      await this.deps.onForkConfirmed?.(taskId, { threadId, forkedFromId: sourceThreadId }, operationId)
      log.event('codex-fork-identity-confirmed', { taskId, threadId, forkedFromId: sourceThreadId })
      let historyError: string | undefined
      const turns = await this.loadHistory(srv, threadId, result).catch(error => {
        historyError = (error as Error).message
        return result.thread?.turns ?? []
      })
      const blocks = new CodexBlockStream()
      for (const turn of turns) {
        blocks.push({ method: 'turn/started', params: { threadId, turn } })
        for (const item of turn.items ?? []) {
          blocks.push({ method: 'item/completed', params: { threadId, turnId: turn.id, item } })
        }
        if (turn.status && turn.status !== 'inProgress') {
          blocks.push({ method: 'turn/completed', params: { threadId, turn } })
        }
      }
      const { config: _config, ...options } = o
      const st: ThreadState = {
        taskId, threadId, pending: null, pendingQueue: [], blocks,
        options: { ...options, model }, asked,
        completedTurns: new Set(turns
          .filter(turn => ['completed', 'interrupted', 'failed'].includes(turn.status ?? ''))
          .map(turn => turn.id)),
      }
      st.turnId = turns.find(turn => turn.status === 'inProgress')?.id
      const previous = this.byTask.get(taskId)
      if (previous) this.byThread.delete(previous.threadId)
      this.byThread.set(threadId, st)
      this.byTask.set(taskId, st)
      const snapshot = blocks.snapshot()
      blocks.takeBlockUpdates()
      if (snapshot.blocks.length) this.deps.onPatch({ taskId, blocks: snapshot.blocks })
      this.deps.onPatch({ taskId, history: historyError
        ? { phase: 'partial', reason: historyError, canRetry: true } : { phase: 'ready' } })
      this.reportPosture(taskId, asked, applied)
      log.event('codex-thread-forked', { taskId, threadId, forkedFromId: sourceThreadId })
      return { threadId, forkedFromId: sourceThreadId }
    } finally {
      this.finishRegistration()
    }
  }

  /** Send a message — the first prompt or a reply. Starts a turn. */
  async send(taskId: string, text: string, opts: { effort?: string; attachments?: readonly string[]; ordered?: TaskInput[]; newTurnOnly?: boolean } = {}): Promise<boolean> {
    const st = this.byTask.get(taskId)
    if (st?.pending && !st.disconnected && this.server?.running) {
      if (opts.newTurnOnly || opts.attachments?.length) return false
      return this.answer(taskId, text)
    }
    return (await this.sendAttempt(taskId, text, opts)).kind === 'accepted'
  }

  /** Certainty and identity belong to this attempt, never a later task mapping. */
  private async sendAttempt(taskId: string, text: string, opts: { effort?: string; attachments?: readonly string[]; ordered?: TaskInput[] } = {}): Promise<NewTurnOutcome> {
    const st = this.byTask.get(taskId)
    if (!st) { log.warn('send: no thread for task', { taskId }); return { kind: 'not-sent', reason: 'No Codex thread for this task.' } }
    if (st.disconnected || !this.server?.running) return { kind: 'not-sent', reason: 'Codex is disconnected.' }
    // AN OUTSTANDING APPROVAL IS ANSWERED, NOT TALKED OVER. Typing "yes" as a
    // new turn would leave Codex blocked on the original request and add a
    // stray message to the thread.
    if (st.pending) {
      return { kind: 'not-sent', reason: 'Answer the pending request before sending a new turn.' }
    }
    if (st.turnId || st.submitting || st.stopping) return { kind: 'not-sent', reason: 'Codex is not ready for a new turn.' }
    st.submitting = true
    let finishSubmission!: () => void
    st.submissionFinished = new Promise(resolve => { finishSubmission = resolve })
    let submissionAttempted = false
    try {
      const ordered: TaskInput[] = opts.ordered ?? [ ...(text ? [{ type: 'text' as const, text }] : []), ...(opts.attachments ?? []).map(path => ({ type: 'image' as const, path })) ]
      let metadata: CodexInputMetadata | undefined
      let registered: { turnId?: string } | undefined
      if (ordered.some(p => p.type === 'image' || p.attachment)) {
        metadata = { id: randomUUID(), input: ordered }
        await this.deps.saveInputMetadata?.(taskId, st.threadId, metadata)
        registered = st.blocks.registerInputMetadata(ordered)
      }
      if (st.pending || st.pendingQueue?.length || st.disconnected || st.stopping || this.byTask.get(taskId) !== st) return { kind: 'not-sent', reason: 'Codex changed before submission.' }
      submissionAttempted = true
      // A TURN CARRIES THE POSTURE TOO, and a managed Codex refuses a
      // disallowed one here even after quietly lowering it at thread start —
      // the exact failure on a company laptop. A refusal is returned before a
      // turn exists, so learning from it and retrying cannot send twice.
      let result!: { turn?: { id?: string } }
      for (let attempt = 0; ; attempt++) {
        try { result = await this.turnStart(st, text, opts); break }
        catch (error) {
          const next = st.options && this.learn(taskId, error, attempt) ? clampPosture(st.options, this.requirements) : undefined
          if (!next || next === st.options) throw error
          st.options = next
          this.reportPosture(taskId, st.asked ?? next, next)
        }
      }
      if (typeof result.turn?.id !== 'string' || !result.turn.id) {
        st.disconnected = true
        throw new Error('turn/start returned no turn id; acceptance is uncertain. Reconnect before sending again')
      }
      if (!st.completedTurns?.has(result.turn.id)) st.turnId = result.turn.id
      if (metadata && result.turn?.id) {
        metadata = { ...metadata, turnId: result.turn.id }
        if (registered) registered.turnId = result.turn.id
        try { await this.deps.saveInputMetadata?.(taskId, st.threadId, metadata) }
        catch { this.deps.onPatch({ taskId, errorReason: 'Codex accepted the message, but attachment display metadata could not be updated. Do not resend the message.' }) }
      }
      return { kind: 'accepted', submissionId: result.turn.id, turnId: result.turn.id }
    } catch (e) {
      if (submissionAttempted) st.disconnected = true
      log.warn('turn/start failed', { taskId, error: (e as Error).message })
      this.deps.onPatch({ taskId, state: 'failed', errorReason: `Could not confirm Codex submission: ${(e as Error).message}. Check the conversation before retrying.` })
      return { kind: submissionAttempted ? 'uncertain' : 'not-sent', reason: submissionAttempted ? 'Codex acceptance is uncertain. Check the conversation before sending again.' : 'Codex did not start this turn.' }
    } finally { st.submitting = false; finishSubmission(); this.followupChanged(taskId, !!st.disconnected) }
  }

  /** One `turn/start`, carrying the thread's CURRENT posture. */
  private turnStart(st: ThreadState, text: string, opts: { effort?: string; attachments?: readonly string[]; ordered?: TaskInput[] }): Promise<{ turn?: { id?: string } }> {
    return this.server!.request<{ turn?: { id?: string } }>('turn/start', {
      threadId: st.threadId,
      input: opts.ordered?.map(p => p.type === 'image' ? { type: 'localImage', path: p.path } : { type: 'text', text: p.text }) ?? [
        ...(text ? [{ type: 'text', text }] : []),
        ...(opts.attachments ?? []).map((path) => ({ type: 'localImage', path })),
      ],
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(st.options?.model ? { model: st.options.model } : {}),
      ...(st.options ? { approvalPolicy: st.options.approvalPolicy,
        sandboxPolicy: st.options.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
          : st.options.sandbox === 'read-only' ? { type: 'readOnly' }
          : { type: 'workspaceWrite', writableRoots: [st.options.cwd, ...(st.options.writableRoots ?? [])], networkAccess: true },
      } : {}),
    })
  }

  /** Answer a blocking approval. Returns false if nothing was waiting. */
  answer(taskId: string, text: string, expected?: QuestionReference): boolean {
    const st = this.byTask.get(taskId)
    if (!st?.pending || st.disconnected || st.pending.awaitingReplay) return false
    if (expected && !sameQuestion(expected, { requestId: st.pending.identity, stepId: String(st.pending.index) })) return false
    if (st.turnId && typeof st.pending.params.turnId === 'string' && st.pending.params.turnId !== st.turnId) return false
    const decision = approvalDecision(text)
    const pending = st.pending
    const { resolve, method } = pending
    const cap = this.approvalCap(st)
    const modernOptions = approvalOptions(method, pending.params, cap)
    const modernResponse = modernOptions ? responseForApproval(method, pending.params, text, cap) : undefined
    if (modernOptions && modernResponse === undefined) { this.presentRequest(st); return false }
    let formResponse: unknown
    if (pending.form) {
      if (text.trim() === '/cancel') formResponse = { action: 'cancel' }
      else {
        const field = pending.form.fields[pending.index]
        if (field) {
          try {
            if (text.trim() === '/skip' && !field.required) { /* explicit optional omission */ }
            else {
              if (!text.trim()) throw new Error('Enter a value; optional fields can use /skip')
              const selected = field.options?.find(o => o.label === text || o.value === text)
              let value: unknown = selected?.value ?? text
              if (field.schema.type === 'boolean') value = text.trim() === 'true' ? true : text.trim() === 'false' ? false : text
              if (['number', 'integer', 'array'].includes(String(field.schema.type))) { try { value = JSON.parse(text) } catch { throw new Error('Enter a valid JSON number or array') } }
              validateFormValue(value, field.schema)
              Object.defineProperty(pending.form.content, field.id, { value, enumerable: true, configurable: true, writable: true })
            }
          } catch (error) {
            pending.validationError = `${field.title}: ${(error as Error).message}`
            this.deps.onPatch({ taskId, state: 'needs-user', errorReason: pending.validationError })
            return false
          }
          pending.validationError = undefined
          this.deps.onPatch({ taskId, state: 'needs-user', errorReason: '' })
          pending.index++
          this.presentRequest(st)
          return true
        }
        if (!/^(approve|allow|yes|accept|deny|decline|no)$/i.test(text.trim())) return false
        formResponse = /^(approve|allow|yes|accept)$/i.test(text.trim()) ? { action: 'accept', content: pending.form.content } : { action: 'decline' }
      }
    }
    if (method === 'item/tool/requestUserInput') {
      const question = pending.questions[pending.index]
      if (!question || !text.trim()) return false
      pending.answers[question.id] = { answers: [text] }
      pending.index++
      if (pending.index < pending.questions.length) {
        this.presentRequest(st)
        return true
      }
    }
    const response = pending.form ? formResponse : method === 'item/tool/requestUserInput' ? { answers: pending.answers }
      : modernResponse ?? this.approvalResponse(method, decision === 'approved', pending.params)
    try { pending.respond?.(response) } catch (error) {
      if (method === 'item/tool/requestUserInput') pending.index = Math.max(0, pending.index - 1)
      this.deps.onPatch({ taskId, state: 'needs-user', errorReason: `Codex answer was not delivered: ${(error as Error).message}` })
      return false
    }
    st.pending = null
    log.event('codex-approval-answered', { taskId, method, decision })
    resolve(response)
    st.pending = st.pendingQueue?.shift() ?? null
    if (st.pending) this.presentRequest(st)
    else this.deps.onPatch({ taskId, clearQuestion: true, state: 'processing' })
    this.followupChanged(taskId)
    return true
  }

  /** Stop the current turn. The thread survives — this is Esc, not a kill. */
  async interrupt(taskId: string): Promise<boolean> {
    const st = this.byTask.get(taskId)
    if (!st || !this.server || st.disconnected || st.stopping) return false
    st.stopping = true
    this.deps.onPatch({ taskId, activity: { kind: 'lifecycle', label: 'Cancelling' } })
    try {
      await st.submissionFinished
      if (!st.turnId) return false
      await this.server.request('turn/interrupt', { threadId: st.threadId, turnId: st.turnId }); return true
    }
    catch (e) { this.deps.onPatch({ taskId, activity: null, errorReason: `Could not stop Codex: ${(e as Error).message}` }); log.warn('turn/interrupt failed', { taskId, error: (e as Error).message }); return false }
    finally { st.stopping = false }
  }

  /** Stop any provider-owned work, then forget only the local task mapping. */
  async stopAndRelease(taskId: string): Promise<boolean> {
    const st = this.byTask.get(taskId)
    if (!st) return true
    await st.submissionFinished
    if (this.byTask.get(taskId) !== st) return true
    // A disconnected submission may have reached Codex without returning its
    // turn id. Releasing that uncertainty would make running work invisible.
    if (st.disconnected || st.stopping) return false
    if (st.turnId) {
      const interrupted = await this.interrupt(taskId)
      // The turn may have completed between the check and interrupt(). That is
      // safe to release; an unchanged live id or disconnect is not.
      if (!interrupted && (st.turnId || st.disconnected)) return false
    }
    this.release(taskId)
    return true
  }

  /** Name the thread — a real task title, from Codex's own naming. */
  async rename(taskId: string, name: string): Promise<void> {
    const st = this.byTask.get(taskId)
    if (!st || !this.server) return
    try { await this.server.request('thread/name/set', { threadId: st.threadId, name }) }
    catch (e) { log.warn('thread/name/set failed', { taskId, error: (e as Error).message }) }
  }

  threadIdFor(taskId: string): string | undefined { return this.byTask.get(taskId)?.threadId }
  validationErrorFor(taskId: string): string | undefined { return this.byTask.get(taskId)?.pending?.validationError }

  private async loadHistory(srv: CodexAppServer, threadId: string, result: ResumeHistory): Promise<HistoryTurn[]> {
    const pages = async <T>(method: string, cursor: string | null | undefined, params: Record<string, unknown>, fromStart = false): Promise<T[]> => {
      const data: T[] = []
      const visited = new Set<string>()
      while (cursor || fromStart) {
        fromStart = false
        const key = cursor ?? '<start>'
        if (visited.has(key)) throw new Error(`Codex history pagination repeated a cursor (${method}); history is incomplete`)
        visited.add(key)
        const page = await srv.request<{ data: T[]; nextCursor?: string | null }>(method, { threadId, ...params, ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(page.data)) throw new Error(`Codex returned malformed history (${method})`)
        data.push(...page.data)
        cursor = page.nextCursor
      }
      return data
    }
    const older = (await pages<HistoryTurn>('thread/turns/list', result.turnsBackwardsCursor, { sortDirection: 'desc', itemsView: 'full' })).reverse()
    const turns = new Map<string, HistoryTurn>()
    const mergeItems = (...groups: Array<Record<string, unknown>[]>) => {
      const merged = new Map<string, Record<string, unknown>>()
      for (const items of groups) for (const item of items) {
        if (typeof item.id !== 'string') throw new Error('Codex history item has no stable identity')
        merged.set(item.id, item)
      }
      return [...merged.values()]
    }
    for (const turn of [...older, ...(result.thread?.turns ?? [])]) {
      const previous = turns.get(turn.id)
      const items = previous?.itemsView === 'full' && turn.itemsView && turn.itemsView !== 'full'
        ? mergeItems(turn.items ?? [], previous.items ?? []) : mergeItems(previous?.items ?? [], turn.items ?? [])
      turns.set(turn.id, { ...previous, ...turn, items,
        itemsView: previous?.itemsView === 'full' || turn.itemsView === 'full' ? 'full' : turn.itemsView })
    }
    const entries = (await pages<{ turnId: string; item: Record<string, unknown> }>('thread/items/list', result.itemsBackwardsCursor, { sortDirection: 'desc' })).reverse()
    const olderItems = new Map<string, Record<string, unknown>[]>()
    for (const entry of entries) {
      const items = olderItems.get(entry.turnId) ?? []
      items.push(entry.item)
      olderItems.set(entry.turnId, items)
    }
    const missing: HistoryTurn[] = []
    for (const [id, items] of olderItems) {
      const turn = turns.get(id)
      if (turn) turn.items = mergeItems(items, turn.items ?? [])
      else missing.push({ id, items: mergeItems(items) })
    }
    const ordered = [...missing, ...turns.values()]
    for (const turn of ordered) {
      if (turn.itemsView === 'summary' || turn.itemsView === 'notLoaded') {
        const full = await pages<{ turnId: string; item: Record<string, unknown> }>('thread/items/list', null, { turnId: turn.id, sortDirection: 'asc' }, true)
        turn.items = mergeItems(full.map(entry => entry.item))
      }
    }
    return ordered
  }

  /** Rewind only a freshly forked, idle branch; source history remains intact. */
  async rollbackLatestTurn(taskId: string, options: StartThreadOpts): Promise<void> {
    const state = this.byTask.get(taskId)
    if (!state || state.turnId || state.pending || state.submitting || state.disconnected) throw new Error('Codex must be idle before editing.')
    await this.server!.request('thread/rollback', { threadId: state.threadId, numTurns: 1 })
    this.deps.onPatch({ taskId, blocks: [] })
    await this.resumeThread(taskId, state.threadId, options, true)
  }

  /** Reattach the persisted conversation without creating a new thread or
   * replaying the user's last prompt. Process lifetime is not session lifetime. */
  async resumeThread(taskId: string, threadId: string, o: StartThreadOpts, force = false): Promise<void> {
    if (!force && this.byTask.get(taskId)?.threadId === threadId && !this.byTask.get(taskId)?.disconnected && this.server?.running) return
    if (this.byTask.has(taskId) && this.byTask.get(taskId)!.threadId !== threadId) {
      const gate = this.followupGate(taskId)
      if (gate.kind !== 'idle' || gate.blocked) throw new Error('Cannot replace a busy or blocked Codex session binding')
      this.release(taskId)
    }
    this.deps.onPatch({ taskId, history: { phase: 'loading' } })
    const previous = this.byTask.get(taskId)
    this.registrations++
    try {
    const srv = await this.ensure()
    await this.refreshRequirements(srv)
    const asked = o
    const config = { ...o.config, ...await this.deps.threadConfig?.(taskId) }
    const sent = await this.withPolicy(taskId, asked, next => srv.request<ResumeHistory>('thread/resume', {
      threadId, cwd: next.cwd, approvalPolicy: next.approvalPolicy, sandbox: next.sandbox,
      ...(next.model ? { model: next.model } : {}),
      config,
    }))
    const result = sent.res
    o = sent.o
    const applied = appliedPosture(result, sent.o)
    if (result.thread?.id && result.thread.id !== threadId) throw new Error('Codex resumed a different thread')
    await this.deps.onThreadConfirmed?.(taskId, threadId)
    const blocks = new CodexBlockStream()
    for (const record of await this.deps.loadInputMetadata?.(taskId, threadId) ?? []) blocks.registerInputMetadata(record.input, record.turnId)
    const turns = await this.loadHistory(srv, threadId, result)
    await this.planWrites.get(taskId)
    const plans = await this.deps.loadPlans?.(taskId, threadId) ?? previous?.blocks.snapshot().blocks.filter(b => b.kind === 'plan') ?? []
    for (const turn of turns) {
      blocks.push({ method: 'turn/started', params: { threadId, turn } })
      const plan = plans.find(p => p.turnId === turn.id)
      const pushPlan = () => { if (plan) blocks.push({ method: 'turn/plan/updated', params: { turnId: turn.id, plan: plan.steps } }) }
      if (!(turn.items ?? []).some(item => item.type === 'userMessage')) pushPlan()
      for (const item of turn.items ?? []) {
        blocks.push({ method: 'item/completed', params: { threadId, turnId: turn.id, item } })
        if (item.type === 'userMessage') pushPlan()
      }
      if (turn.status && turn.status !== 'inProgress') blocks.push({ method: 'turn/completed', params: { threadId, turn } })
    }
    const { config: _config, ...options } = o
    const preservePending = previous?.threadId === threadId
    const st: ThreadState = { taskId, threadId, pending: preservePending ? previous.pending : null,
      pendingQueue: preservePending ? previous.pendingQueue : [], blocks, options, asked,
      completedTurns: new Set([...(preservePending ? previous.completedTurns ?? [] : []), ...turns.filter(t => ['completed', 'interrupted', 'failed'].includes(t.status ?? '')).map(t => t.id)]) }
    this.retireCompletedRequests(st)
    st.turnId = turns.find(turn => turn.status === 'inProgress')?.id
    this.byThread.set(threadId, st)
    this.byTask.set(taskId, st)
    this.reportPosture(taskId, asked, applied)
    const snapshot = blocks.snapshot()
    blocks.takeBlockUpdates()
    if (snapshot.blocks.length) this.deps.onPatch({ taskId, blocks: snapshot.blocks })
    const lastStatus = turns.at(-1)?.status
    this.deps.onPatch({ taskId, state: st.pending ? 'needs-user' : st.turnId ? 'processing' : lastStatus === 'failed' ? 'failed' : 'done', activity: null,
      turnOutcome: st.turnId ? null : lastStatus === 'interrupted' ? 'cancelled' : lastStatus === 'failed' ? 'failed' : 'completed', history: { phase: 'ready' } })
    if (st.pending) this.presentRequest(st)
    } catch (error) {
      this.deps.onPatch({ taskId, history: { phase: previous?.blocks.snapshot().blocks.length ? 'partial' : 'failed', reason: `Could not load complete Codex history: ${(error as Error).message}`, canRetry: true } })
      throw error
    } finally { this.finishRegistration() }
  }

  /**
   * PROVE THE TRANSPORT WORKS, IN THIS BUILD, BEFORE A TASK DEPENDS ON IT.
   *
   * Starts the server, completes the handshake, asks one harmless question, and
   * shuts down. Non-fatal and fire-and-forget: it exists to LOG, not to gate.
   *
   * It exists because the App Server client was verified end-to-end under tsx
   * and then failed on its first frame in the packaged app — `ws` had been
   * bundled with a broken native masker. A dev-runtime test cannot see that
   * class of fault, and the way the user met it was two tasks silently running
   * on the wrong agent. Now the packaged app says so on its own, at launch,
   * before anyone asks it to do anything.
   *
   * Cheap enough to be unconditional: one short-lived Codex process, once.
   */
  async selfCheck(): Promise<{ ok: boolean; reason?: string }> {
    const started = Date.now()
    try {
      const srv = await this.ensure()
      // A REQUEST, not just a connection. The `ws` fault only appeared when a
      // frame was actually SENT, so a check that merely opened the socket would
      // have passed while the thing it was checking was broken.
      await srv.request('model/list', {})
      log.event('codex-selfcheck-ok', { ms: Date.now() - started, url: srv.url })
      return { ok: true }
    } catch (e) {
      const reason = (e as Error).message
      // ERROR, not warn: Codex CLI cannot work in this build, and the failure is
      // ours rather than the user's. Everything still runs — dispatch falls back
      // to the PTY path — but the reason is now on the record at launch.
      log.error('codex-selfcheck-failed — Codex CLI will fall back to the PTY path', {
        ms: Date.now() - started, reason,
      })
      return { ok: false, reason }
    }
  }

  /** Forget a task. Does NOT delete the Codex thread — the conversation is the
   *  user's, and it stays resumable from disk after unmute lets go of it. */
  release(taskId: string): void {
    const st = this.byTask.get(taskId)
    if (!st) return
    this.followupChanged(taskId, true)
    // A RELEASED TASK WITH A BLOCKED TURN MUST NOT LEAVE CODEX HANGING. Nothing
    // will ever answer it now, and Codex has no timeout of its own.
    for (const pending of [st.pending, ...(st.pendingQueue ?? [])]) {
      if (pending) pending.resolve(this.approvalResponse(pending.method, false, pending.params))
    }
    st.pending = null
    this.byTask.delete(taskId)
    this.byThread.delete(st.threadId)
  }

  stop(): void {
    for (const st of [...this.byThread.values()]) this.release(st.taskId)
    this.byThread.clear()
    this.byTask.clear()
    this.server?.stop()
    this.server = null
  }

  // ── the stream ────────────────────────────────────────────────────────────

  private onNotification(m: { method: string; params?: Record<string, unknown> }): void {
    if (m.method === 'mcpServer/startupStatus/updated' && !m.params?.threadId) {
      const mcpStatus = reduceAppServerEvent(m)?.mcpStatus
      if (mcpStatus) {
        this.mcpStatuses.set(mcpStatus.name, mcpStatus)
        for (const st of this.byTask.values()) this.deps.onPatch({ taskId: st.taskId, mcpStatus })
      }
      return
    }
    if (m.method === 'transport/disconnected') {
      for (const st of this.byTask.values()) {
        st.disconnected = true
        this.followupChanged(st.taskId, true)
        for (const pending of [st.pending, ...(st.pendingQueue ?? [])]) if (pending) pending.awaitingReplay = true
        this.deps.onPatch({ taskId: st.taskId, state: 'failed', activity: null,
          errorReason: 'Codex connection lost; submission and turn status are uncertain. Reconnect to recover the conversation before retrying.' })
      }
      return
    }
    const threadId = typeof m.params?.threadId === 'string' ? m.params.threadId : undefined
    // thread/started is the one notification that ARRIVES with the id we are
    // about to learn; every other one must already be routable.
    const st = threadId ? this.byThread.get(threadId) : undefined
    const liveTurn = st?.turnId
    if (this.registrations && (!st || m.method !== 'transport/disconnected')) {
      this.earlyNotifications.push(m)
      return
    }
    if (st && m.method === 'turn/started') {
      const turn = m.params?.turn as { id?: string } | undefined
      if (turn?.id) st.turnId = turn.id
    }
    if (st && m.method === 'turn/completed') {
      const id = (m.params?.turn as { id?: string } | undefined)?.id
      if (id) (st.completedTurns ??= new Set()).add(id)
      this.retireCompletedRequests(st)
      if (!id || st.turnId === id) st.turnId = undefined
      else if (st.turnId) return
    }

    // THE CHAT VIEW IS FED FIRST, AND FROM EVERY NOTIFICATION.
    //
    // reduceAppServerEvent handles fourteen methods and returns null for the
    // rest, which is correct for TASK STATE — most of this protocol says
    // nothing about whether a task is working. It is quite wrong for the chat:
    // the reasoning, the commands, the diffs and the plan all live in those
    // "ignored" notifications. So the block stream sees the whole feed, and the
    // state reducer keeps its narrow view.
    let blocksChanged = false
    if (st) blocksChanged = st.blocks.push({ method: m.method, params: m.params }, Date.now())

    const patch = reduceAppServerEvent({ method: m.method, params: m.params })
    if (!patch && !blocksChanged) return
    if (!st) {
      if (threadId) log.debug('notification for an unknown thread', { method: m.method, threadId })
      return
    }
    const blockUpdates = blocksChanged ? st.blocks.takeBlockUpdates() : []
    const metadata = blocksChanged ? st.blocks.metadata() : null
    if (m.method === 'turn/plan/updated' && blocksChanged && this.deps.savePlans) {
      const plans = st.blocks.snapshot().blocks.filter(b => b.kind === 'plan')
      const write = (this.planWrites.get(st.taskId) ?? Promise.resolve()).then(() => this.deps.savePlans!(st.taskId, st.threadId, plans))
        .catch(error => this.deps.onPatch({ taskId: st.taskId, history: { phase: 'partial', reason: `Could not save turn plans: ${(error as Error).message}`, canRetry: true } }))
      this.planWrites.set(st.taskId, write)
      void write.finally(() => { if (this.planWrites.get(st.taskId) === write) this.planWrites.delete(st.taskId) })
    }
    this.deps.onPatch({
      taskId: st.taskId,
      ...(patch ?? {}),
      ...(blockUpdates.length ? { blockUpdates } : {}),
      ...(metadata?.usage ? { usage: metadata.usage } : {}),
    })
    if (st.pending) this.presentRequest(st)
    this.followupChanged(st.taskId)
    if (m.method === 'turn/completed' && liveTurn && (m.params?.turn as { id?: string })?.id === liveTurn) {
      const generation = this.generation(st), server = this.server
      const status = (m.params?.turn as { status?: string })?.status
      const outcome = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed'
      void Promise.resolve(st.submissionFinished).then(() => {
        if (this.server !== server || this.byTask.get(st.taskId) !== st || st.disconnected || st.submitting) return
        for (const cb of this.followupListeners) cb({ type: 'ended', event: { taskId: st.taskId,
          fence: { sessionId: st.threadId, generation, turnId: liveTurn }, outcome } })
      })
    }
  }

  /**
   * A server→client request. Codex is BLOCKED until we reply.
   *
   * The reply is deliberately NOT sent here: the promise is parked, the task
   * goes to `needs-user` with the question, and it resolves when the human
   * answers. That is the whole point of the App Server path — an approval that
   * used to require finding a terminal now arrives on the card.
   */
  private onServerRequest(req: ServerRequest, source = this.server): Promise<unknown> {
    if (source !== this.server) return Promise.reject(new Error('Codex request belongs to a replaced connection'))
    const p = (req.params ?? {}) as Record<string, unknown>
    const threadId = typeof p.threadId === 'string' ? p.threadId
      : typeof p.conversationId === 'string' ? p.conversationId : undefined
    const st = threadId ? this.byThread.get(threadId) : undefined
    if (this.registrations) return new Promise((resolve, reject) => { this.earlyRequests.push({ req, source, resolve, reject }) })
    const question = questionFromApproval(req.method, req.params)

    const rejectRequest = (reason: string) => {
      if (st) this.deps.onPatch({ taskId: st.taskId, state: 'failed', activity: null, errorReason: reason })
      return Promise.reject(new Error(reason))
    }
    if (!question) return rejectRequest(`Unsupported Codex request: ${req.method}`)
    if (req.method === 'item/tool/requestUserInput') {
      const questions = p.questions as PendingRequest['questions'] | undefined
      if (!Array.isArray(questions) || !questions.length || questions.some(q => !q || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question ||
        (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => !o || typeof o.label !== 'string')))) || new Set(questions.map(q => q.id)).size !== questions.length) {
        return rejectRequest('Malformed Codex question set; required question identities or labels are missing.')
      }
    }
    let fields: FormField[] | undefined
    if (req.method === 'mcpServer/elicitation/request') {
      try { fields = formFields(p) }
      catch (error) {
        if (st) this.deps.onPatch({ taskId: st.taskId, errorReason: `MCP request declined: ${(error as Error).message}` })
        return Promise.resolve({ action: 'decline' })
      }
    }
    if (st && typeof p.turnId === 'string' && (st.completedTurns?.has(p.turnId) || (st.turnId && p.turnId !== st.turnId))) {
      return Promise.resolve(this.approvalResponse(req.method, false, p))
    }

    if (!st || !question) {
      // UNROUTABLE OR UNRECOGNISED ⇒ DENY, LOUDLY. Leaving it unanswered hangs
      // the turn forever; approving something we cannot describe to the user is
      // worse. Denial is the only answer that is safe when we do not understand
      // the question.
      log.warn('codex-approval-unroutable', { method: req.method, threadId: threadId ?? null, known: !!st })
      return Promise.resolve(this.approvalResponse(req.method, false, p))
    }

    log.event('codex-approval-requested', { taskId: st.taskId, method: req.method })
    return new Promise((resolve) => {
      const replay = [st.pending, ...(st.pendingQueue ?? [])].find(pr => pr && pr.awaitingReplay && pr.method === req.method && pr.params.turnId === p.turnId &&
        JSON.stringify(pr.params) === JSON.stringify(p) && (pr.id === req.id || (typeof p.itemId === 'string' && p.itemId === pr.params.itemId)))
      if (replay) {
        replay.resolve(this.approvalResponse(replay.method, false, replay.params))
        replay.id = req.id; replay.resolve = resolve; replay.respond = req.respond; replay.awaitingReplay = false
        this.deps.onPatch({ taskId: st.taskId, errorReason: '' })
        if (st.pending === replay) this.presentRequest(st)
        return
      }
      const pending: PendingRequest = {
        identity: `${typeof req.id}:${req.id}:${randomUUID()}`,
        id: req.id, method: req.method, resolve, params: p, respond: req.respond,
        questions: Array.isArray(p.questions) ? p.questions as PendingRequest['questions'] : [], answers: {}, index: 0,
        ...(fields ? { form: { fields, content: {} } } : {}),
      }
      if (st.pending) (st.pendingQueue ??= []).push(pending)
      else { st.pending = pending; this.presentRequest(st) }
    })
  }

  private approvalCap(st: ThreadState): import('./app-server-events').ApprovalCap {
    const cap = this.deps.approvalCap?.(st.taskId) ?? { fullAccessAllowed: st.options?.sandbox === 'danger-full-access', roots: [] }
    return { ...cap, roots: [...new Set([...cap.roots, ...(st.options?.writableRoots ?? [])])], readOnly: st.options?.sandbox === 'read-only' }
  }

  private presentRequest(st: ThreadState): void {
    const pending = st.pending
    if (!pending) return
    const reference = { requestId: pending.identity, stepId: String(pending.index) }
    if (pending.form) {
      const field = pending.form.fields[pending.index]
      const choices = field?.options?.map(o => o.label) ?? (field?.schema.type === 'boolean' ? ['true', 'false'] : undefined)
      this.deps.onPatch({ taskId: st.taskId, state: 'needs-user', activity: null,
        question: field ? { reference, text: `${String(pending.params.message ?? 'MCP tool input')}\n\n${field.title}${field.required ? ' (required)' : ' (optional; /skip to omit)'}${field.schema.description ? `\n${field.schema.description}` : ''}\n${field.schema.type === 'array' ? 'Enter a JSON array. ' : ''}/cancel cancels this request.`, kind: choices?.length ? 'choice' : 'free_text', ...(choices ? { choices } : {}) }
          : { reference, text: `Submit these MCP form answers?\n\n${JSON.stringify(pending.form.content, null, 2)}`, kind: 'confirm', choices: ['Approve', 'Deny'] },
        ...(pending.awaitingReplay ? { errorReason: 'MCP request is unresolved after reconnect; waiting for provider replay before accepting answers.' } : {}) })
      return
    }
    const item = pending.questions[pending.index]
    const question = pending.method === 'item/tool/requestUserInput' && item
      ? { text: item.question, kind: item.options?.length ? 'choice' as const : 'free_text' as const, choices: item.options?.map((o) => o.label) }
      : questionFromApproval(pending.method, pending.params, st.blocks.item(String(pending.params.itemId ?? '')), this.approvalCap(st))
    if (question && pending.method !== 'item/tool/requestUserInput') {
      const signature = JSON.stringify(question.choices)
      if (pending.choicesSignature !== undefined && pending.choicesSignature !== signature) reference.stepId = String(++pending.index)
      pending.choicesSignature = signature
    }
    if (question) this.deps.onPatch({ taskId: st.taskId, state: 'needs-user', question: { ...question, reference }, activity: null,
      ...(pending.awaitingReplay ? { errorReason: 'Codex has not replayed this unresolved request after reconnect. Its outcome remains uncertain; answers are disabled until the provider confirms it.' } : {}) })
  }

  private retireCompletedRequests(st: ThreadState): void {
    const retained: PendingRequest[] = []
    for (const request of [st.pending, ...(st.pendingQueue ?? [])]) {
      if (!request) continue
      if (typeof request.params.turnId === 'string' && st.completedTurns?.has(request.params.turnId)) request.resolve(this.approvalResponse(request.method, false, request.params))
      else retained.push(request)
    }
    st.pending = retained.shift() ?? null
    st.pendingQueue = retained
  }

  private approvalResponse(method: string, allow: boolean, params: Record<string, unknown>): unknown {
    if (method === 'item/tool/requestUserInput') return { answers: {} }
    if (method === 'mcpServer/elicitation/request') return allow ? { action: 'accept', content: {} } : { action: 'decline' }
    if (method === 'item/permissions/requestApproval') return { permissions: allow ? params.permissions ?? {} : {}, scope: 'turn' }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: allow ? 'accept' : 'decline' }
    return { decision: allow ? 'approved' : 'denied' }
  }
}
