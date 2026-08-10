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
import {
  reduceAppServerEvent, questionFromApproval, approvalDecision,
  type CodexPatch,
} from './app-server-events'
import { createLogger } from '../log'

const log = createLogger('codex-hub')

/** What the task layer receives. A patch plus the task it belongs to. */
export interface HubPatch extends CodexPatch { taskId: string }

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
}

interface ThreadState {
  taskId: string
  threadId: string
  /** The blocking request we are waiting on the user for, if any. Held so the
   *  answer can be routed to the right JSON-RPC id — an approval answered
   *  against the wrong id leaves Codex blocked forever while the card reports
   *  itself unblocked. */
  pending: { id: number | string; method: string; resolve: (v: unknown) => void } | null
}

export interface CodexHubDeps {
  /** Resolves the `codex` binary. Injected so the hub owns no PATH logic. */
  resolveBin: () => Promise<string | null>
  /** Where patches go. */
  onPatch: (p: HubPatch) => void
  /** For tests. */
  makeServer?: (bin: string) => CodexAppServer
}

export class CodexHub {
  private server: CodexAppServer | null = null
  private byThread = new Map<string, ThreadState>()
  private byTask = new Map<string, ThreadState>()
  private starting: Promise<CodexAppServer> | null = null

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
      const bin = await this.deps.resolveBin()
      if (!bin) throw new Error('CODEX_NOT_FOUND')
      const srv = this.deps.makeServer ? this.deps.makeServer(bin) : new CodexAppServer({ bin })
      srv.on('*', (m) => this.onNotification(m as { method: string; params?: Record<string, unknown> }))
      srv.onRequest((r) => this.onServerRequest(r))
      await srv.start()
      this.server = srv
      return srv
    })().finally(() => { this.starting = null })
    return this.starting
  }

  /**
   * Create a thread for a task and return its id plus the URL a terminal can
   * attach to.
   *
   * The permissions travel WITH the thread. That is what lets one server host a
   * full-access errand and a fenced session at the same time, and it is why
   * unmute never has to write a profile into the user's ~/.codex.
   */
  async startThread(taskId: string, o: StartThreadOpts): Promise<{ threadId: string; url: string }> {
    const srv = await this.ensure()
    const res = await srv.request<Record<string, unknown>>('thread/start', {
      cwd: o.cwd,
      approvalPolicy: o.approvalPolicy,
      sandbox: o.sandbox,
      ...(o.model ? { model: o.model } : {}),
    })
    const threadId = String(res?.threadId ?? (res?.thread as { id?: string } | undefined)?.id ?? res?.id ?? '')
    if (!threadId) throw new Error('thread/start returned no thread id')
    const st: ThreadState = { taskId, threadId, pending: null }
    this.byThread.set(threadId, st)
    this.byTask.set(taskId, st)
    log.event('codex-thread-started', { taskId, threadId, cwd: o.cwd, model: o.model ?? null, effort: o.effort ?? null, approvalPolicy: o.approvalPolicy, sandbox: o.sandbox })
    return { threadId, url: srv.url }
  }

  /** Send a message — the first prompt or a reply. Starts a turn. */
  async send(taskId: string, text: string, opts: { effort?: string } = {}): Promise<boolean> {
    const st = this.byTask.get(taskId)
    if (!st) { log.warn('send: no thread for task', { taskId }); return false }
    // AN OUTSTANDING APPROVAL IS ANSWERED, NOT TALKED OVER. Typing "yes" as a
    // new turn would leave Codex blocked on the original request and add a
    // stray message to the thread.
    if (st.pending) return this.answer(taskId, text)
    try {
      await this.server!.request('turn/start', {
        threadId: st.threadId,
        input: [{ type: 'text', text }],
        ...(opts.effort ? { effort: opts.effort } : {}),
      })
      return true
    } catch (e) {
      log.warn('turn/start failed', { taskId, error: (e as Error).message })
      return false
    }
  }

  /** Answer a blocking approval. Returns false if nothing was waiting. */
  answer(taskId: string, text: string): boolean {
    const st = this.byTask.get(taskId)
    if (!st?.pending) return false
    const decision = approvalDecision(text)
    const { resolve, method } = st.pending
    st.pending = null
    log.event('codex-approval-answered', { taskId, method, decision })
    resolve({ decision })
    this.deps.onPatch({ taskId, clearQuestion: true, state: 'processing' })
    return true
  }

  /** Stop the current turn. The thread survives — this is Esc, not a kill. */
  async interrupt(taskId: string): Promise<boolean> {
    const st = this.byTask.get(taskId)
    if (!st || !this.server) return false
    try { await this.server.request('turn/interrupt', { threadId: st.threadId }); return true }
    catch (e) { log.warn('turn/interrupt failed', { taskId, error: (e as Error).message }); return false }
  }

  /** Name the thread — a real task title, from Codex's own naming. */
  async rename(taskId: string, name: string): Promise<void> {
    const st = this.byTask.get(taskId)
    if (!st || !this.server) return
    try { await this.server.request('thread/name/set', { threadId: st.threadId, name }) }
    catch (e) { log.warn('thread/name/set failed', { taskId, error: (e as Error).message }) }
  }

  threadIdFor(taskId: string): string | undefined { return this.byTask.get(taskId)?.threadId }

  /** Forget a task. Does NOT delete the Codex thread — the conversation is the
   *  user's, and it stays resumable from disk after unmute lets go of it. */
  release(taskId: string): void {
    const st = this.byTask.get(taskId)
    if (!st) return
    // A RELEASED TASK WITH A BLOCKED TURN MUST NOT LEAVE CODEX HANGING. Nothing
    // will ever answer it now, and Codex has no timeout of its own.
    if (st.pending) { st.pending.resolve({ decision: 'denied' }); st.pending = null }
    this.byTask.delete(taskId)
    this.byThread.delete(st.threadId)
  }

  stop(): void {
    for (const [, st] of this.byThread) st.pending?.resolve({ decision: 'denied' })
    this.byThread.clear()
    this.byTask.clear()
    this.server?.stop()
    this.server = null
  }

  // ── the stream ────────────────────────────────────────────────────────────

  private onNotification(m: { method: string; params?: Record<string, unknown> }): void {
    const threadId = typeof m.params?.threadId === 'string' ? m.params.threadId : undefined
    const patch = reduceAppServerEvent({ method: m.method, params: m.params })
    if (!patch) return
    // thread/started is the one notification that ARRIVES with the id we are
    // about to learn; every other one must already be routable.
    const st = threadId ? this.byThread.get(threadId) : undefined
    if (!st) {
      if (threadId) log.debug('notification for an unknown thread', { method: m.method, threadId })
      return
    }
    this.deps.onPatch({ taskId: st.taskId, ...patch })
  }

  /**
   * A server→client request. Codex is BLOCKED until we reply.
   *
   * The reply is deliberately NOT sent here: the promise is parked, the task
   * goes to `needs-user` with the question, and it resolves when the human
   * answers. That is the whole point of the App Server path — an approval that
   * used to require finding a terminal now arrives on the card.
   */
  private onServerRequest(req: ServerRequest): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>
    const threadId = typeof p.threadId === 'string' ? p.threadId
      : typeof p.conversationId === 'string' ? p.conversationId : undefined
    const st = threadId ? this.byThread.get(threadId) : undefined
    const question = questionFromApproval(req.method, req.params)

    if (!st || !question) {
      // UNROUTABLE OR UNRECOGNISED ⇒ DENY, LOUDLY. Leaving it unanswered hangs
      // the turn forever; approving something we cannot describe to the user is
      // worse. Denial is the only answer that is safe when we do not understand
      // the question.
      log.warn('codex-approval-unroutable', { method: req.method, threadId: threadId ?? null, known: !!st })
      return Promise.resolve({ decision: 'denied' })
    }

    log.event('codex-approval-requested', { taskId: st.taskId, method: req.method })
    return new Promise((resolve) => {
      st.pending = { id: req.id, method: req.method, resolve }
      this.deps.onPatch({ taskId: st.taskId, state: 'needs-user', question, activity: null })
    })
  }
}
