import { type TaskDraft, type DraftAttachment, TaskDraftStore } from './task-draft'
import { type TaskInput, draftInput } from './task-input'
import { constants } from 'node:fs'
import { mkdir, open, chmod, lstat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { sameQuestion, type AnswerContext } from './question-reference'

export type TurnFence = { sessionId: string; generation: number; turnId: string }
export type FollowupPhase = 'queued' | 'saved' | 'submitting' | 'uncertain'
export type FollowupRecord = {
  id: string; taskId: string; createdAt: string; owner: 'unmute'; provider: 'claude' | 'codex'; sessionId: string
  draft: TaskDraft; input: TaskInput[]; files: { path: string; sha256: string; bytes: number }[]
  phase: FollowupPhase; after?: TurnFence; attemptId?: string; reason?: string
}
export type SubmitDraftOutcome = { kind: 'accepted' } | { kind: 'queued'; queueId: string }
  | { kind: 'retained' | 'uncertain'; reason: string }
export type DraftSubmissionRequest = { id: string; snapshot: TaskDraft; answerContext?: AnswerContext }
type SubmissionEntry = { promise: Promise<SubmitDraftOutcome>; context: AnswerContext; request?: DraftSubmissionRequest; previous?: SubmissionEntry; snapshot?: TaskDraft; outcome?: SubmitDraftOutcome }
export type NewTurnOutcome = { kind: 'accepted'; submissionId: string; turnId?: string }
  | { kind: 'not-sent' | 'uncertain'; reason: string }
export type FollowupGate = { kind: 'active'; fence: TurnFence; blocked: boolean }
  | { kind: 'idle'; sessionId: string; generation: number; blocked: boolean }
  | { kind: 'unavailable'; reason: string }
export type FollowupTurnEnded = { taskId: string; fence: TurnFence; outcome: 'completed' | 'failed' | 'interrupted' }
export type FollowupOutcomeTrace = {
  taskId: string; queueId: string; attemptId?: string
  disposition: 'queued-locally' | 'submitting' | 'provider-accepted' | 'retained' | 'uncertain'
  persistence: 'saved' | 'failed'
}
export type FollowupP = {
  id: string; phase: FollowupPhase; label: string; preview: string; attachments: DraftAttachment[]
  canCancel: boolean; canRestore: boolean; canQueueAgain: boolean
}

const sameFence = (a?: TurnFence, b?: TurnFence): boolean => !!a && !!b && a.sessionId === b.sessionId && a.generation === b.generation && a.turnId === b.turnId
const retained = (reason: string): SubmitDraftOutcome => ({ kind: 'retained', reason })
async function privateBytes(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('Attachment is unavailable or too large')
    return await file.readFile()
  } finally { await file.close() }
}
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export class TaskFollowupCoordinator {
  private lanes = new Map<string, Promise<unknown>>()
  private submissions = new Map<string, SubmissionEntry>()
  private ready = new Map<string, TurnFence>()
  private invalidations = new Map<string, number>()
  private localErrors = new Map<string, string>()
  constructor(private readonly deps: {
    store: TaskDraftStore; assetsRoot: string | ((id: string) => string)
    scope(id: string): { provider: 'claude' | 'codex'; sessionId: string } | undefined
    gate(id: string): FollowupGate
    deliver(id: string, record: FollowupRecord, idle: { sessionId: string; generation: number }): Promise<NewTurnOutcome>
    immediate(id: string, onSnapshot?: (snapshot: TaskDraft) => void, context?: AnswerContext): Promise<SubmitDraftOutcome>
    changed(id: string): void
    onOutcome?(event: FollowupOutcomeTrace): void
  }) {}
  private trace(record: FollowupRecord, disposition: FollowupOutcomeTrace['disposition'], persisted = true, attemptId = record.attemptId): void {
    // Observability must neither expose payload/errors nor affect delivery.
    try { this.deps.onOutcome?.({ taskId: record.taskId, queueId: record.id, ...(attemptId ? { attemptId } : {}), disposition, persistence: persisted ? 'saved' : 'failed' }) }
    catch { /* A logger failure cannot turn accepted input into a retry. */ }
  }
  private lane<T>(id: string, action: () => Promise<T> | T): Promise<T> {
    const p = (this.lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.lanes.set(id, p)
    void p.finally(() => { if (this.lanes.get(id) === p) this.lanes.delete(id) }).catch(() => {})
    return p
  }
  async settled(id: string): Promise<void> { while (this.lanes.has(id)) await this.lanes.get(id)?.catch(() => {}) }
  submit(id: string, request?: DraftSubmissionRequest, context: AnswerContext = request?.answerContext ?? null): Promise<SubmitDraftOutcome> {
    const existing = this.submissions.get(id)
    const sameContext = (a: AnswerContext, b: AnswerContext) => a === null && b === null || sameQuestion(a, b)
    if (existing && sameContext(existing.context, context) && (!request || existing.request?.id === request.id)) return existing.promise
    const entry = { context: context ? { ...context } : null, ...(request ? { request: structuredClone(request) } : {}), previous: existing } as SubmissionEntry
    const p = this.lane(id, async () => {
      try { entry.outcome = await this.performSubmit(id, entry) }
      catch { entry.outcome = retained('Could not save this message. Your draft is kept.') }
      return entry.outcome
    }).finally(() => { if (this.submissions.get(id) === entry) this.submissions.delete(id); this.deps.changed(id) })
    entry.promise = p
    this.submissions.set(id, entry); this.deps.changed(id)
    return p
  }
  isSubmitting(id: string): boolean { return this.submissions.has(id) }
  composerMode(id: string): 'queue' | 'full' | 'answer' | 'send' | 'locked' {
    const gate = this.deps.gate(id), r = this.deps.store.getFollowup(id)
    if (gate.kind !== 'unavailable' && gate.blocked) return 'answer'
    if (gate.kind === 'unavailable' || r?.phase === 'uncertain' || r?.phase === 'submitting') return 'locked'
    if (r?.phase === 'queued') return 'full'
    return gate.kind === 'active' ? r ? 'full' : 'queue' : 'send'
  }
  private async performSubmit(id: string, submission: SubmissionEntry): Promise<SubmitDraftOutcome> {
    const { store } = this.deps, scope = this.deps.scope(id)
    if (!scope) return retained('This conversation does not support queued follow-ups.')
    store.discardFailedAttachmentStages(id)
    if (!await store.whenSettled(id)) return retained('Attachment staging failed. Your draft is kept.')
    const content = (d: TaskDraft) => JSON.stringify({ text: d.text, attachments: d.attachments, operations: d.operations ?? [] })
    let verifiedSnapshot: TaskDraft | undefined
    if (submission.request) {
      // A new capture is not a second click on the old send. Account only for
      // snapshots actually consumed ahead of it, then require an exact match.
      // Later typing/attachment edits stay in the composer, never auto-sent.
      const expected = structuredClone(submission.request.snapshot)
      const previous: SubmissionEntry[] = []
      for (let p = submission.previous; p; p = p.previous) previous.unshift(p)
      let consumed: SubmitDraftOutcome | undefined
      for (const p of previous) {
        if (p.outcome?.kind !== 'accepted' && p.outcome?.kind !== 'queued') continue
        if ((p.context || submission.context) && !sameQuestion(p.context, submission.context)) return retained('The question changed. Review your saved answer before submitting it again.')
        const sent = p.snapshot
        if (!sent || !expected.text.startsWith(sent.text)) return retained('Your new capture is saved separately. Review the draft and send it again.')
        const ids = new Set(sent.attachments.map(a => a.id))
        if (sent.attachments.some(a => !expected.attachments.some(b => b.id === a.id && b.path === a.path))) return retained('Your capture draft changed. It is kept for review.')
        expected.text = expected.text.slice(sent.text.length)
        expected.attachments = expected.attachments.filter(a => !ids.has(a.id)).map(a => ({ ...a, offset: Math.max(0, (a.offset ?? submission.request!.snapshot.text.length) - sent.text.length) }))
        consumed = p.outcome
      }
      if (content(store.get(id)) !== content(expected)) return retained('Newer edits are kept with your capture. Review the draft and send it again.')
      if (!expected.text && !expected.attachments.length && consumed) return consumed
      verifiedSnapshot = expected
    }
    const immediate = () => this.deps.immediate(id, snapshot => {
      if (verifiedSnapshot && content(snapshot) !== content(verifiedSnapshot)) throw new Error('Capture draft changed before its submission snapshot')
      submission.snapshot = structuredClone(snapshot)
    }, submission.context)
    const gate = this.deps.gate(id), existing = store.getFollowup(id)
    if (submission.context) return immediate()
    if (gate.kind !== 'unavailable' && gate.blocked) return retained('A request is waiting. Review the current question before submitting an answer. Your new message is saved.')
    if (existing?.phase === 'uncertain' || existing?.phase === 'submitting') return retained('Delivery is not confirmed. Check the saved follow-up before sending again.')
    if (existing?.phase === 'queued') return retained('A follow-up is queued ahead of this draft. Your current draft is kept.')
    // Explicit user answers still use the request-aware path, never the queue.
    if (gate.kind === 'idle') return immediate()
    if (gate.kind === 'unavailable') return retained(gate.reason)
    if (existing) return retained('A follow-up is already saved. Cancel or restore it before queuing another.')
    const draft = store.snapshot(id), version = store.version(id), invalidation = this.invalidations.get(id) ?? 0
    if (!draft || (!draft.text.trim() && !draft.attachments.length)) return retained('Nothing to send.')
    submission.snapshot = structuredClone(draft)
    if (/^\/(clear|compact|model|permissions|resume|quit)\s*$/i.test(draft.text)) return retained('Use the conversation controls for this command.')
    const r: FollowupRecord = { id: randomUUID(), taskId: id, owner: 'unmute', provider: scope.provider, sessionId: scope.sessionId,
      createdAt: new Date().toISOString(), draft: structuredClone(draft), input: [], files: [], phase: 'queued', after: gate.fence }
    // Copies are not removed after acceptance: sent history references them.
    if (draft.attachments.length) {
      const root = typeof this.deps.assetsRoot === 'string' ? this.deps.assetsRoot : this.deps.assetsRoot(id)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const rootInfo = await lstat(root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Attachment storage is not a private directory')
      await chmod(root, 0o700)
      const directory = join(root, `followup-${r.id}`)
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700)
      let total = 0
      for (const a of r.draft.attachments) {
        const bytes = await privateBytes(a.path); total += bytes.length
        if (bytes.length > (a.mimeType.startsWith('image/') ? 10 : 25) * 1024 * 1024) throw new Error('Attachment limit exceeded')
        if (total > 50 * 1024 * 1024 || r.draft.attachments.length > 10) throw new Error('Attachment limit exceeded')
        const path = join(directory, randomUUID() + extname(a.path))
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await file.writeFile(bytes) } finally { await file.close() }
        a.path = path; r.files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
      }
    }
    r.input = await draftInput(r.draft)
    const now = this.deps.gate(id)
    const sameActive = now.kind === 'active' && sameFence(now.fence, gate.fence) && !now.blocked
    const completedDuringPreparation = now.kind === 'idle' && now.sessionId === gate.fence.sessionId && now.generation === gate.fence.generation && sameFence(this.ready.get(id), gate.fence)
    if ((this.invalidations.get(id) ?? 0) !== invalidation || (!sameActive && !completedDuringPreparation)
      || !this.deps.scope(id) || !store.transferToFollowup(id, version, r)) return retained('Task or draft changed, or saving failed. Your draft is kept; send again.')
    this.trace(r, 'queued-locally')
    this.deps.changed(id)
    if (completedDuringPreparation) this.readinessChanged(id)
    return { kind: 'queued', queueId: r.id }
  }
  turnEnded(event: FollowupTurnEnded): void {
    if (event.outcome !== 'completed') {
      if (sameFence(this.deps.store.getFollowup(event.taskId)?.after, event.fence)) this.disarm(event.taskId, `Turn ${event.outcome} — follow-up saved`)
      return
    }
    this.ready.set(event.taskId, event.fence)
    this.readinessChanged(event.taskId)
  }
  readinessChanged(id: string): void {
    const r = this.deps.store.getFollowup(id)
    if (r?.phase === 'queued') {
      const gate = this.deps.gate(id)
      if (gate.kind === 'unavailable' || !this.deps.scope(id) || (gate.kind === 'active' && !sameFence(gate.fence, r.after))) {
        this.disarm(id, 'Connection or active turn changed — follow-up saved'); return
      }
    }
    void this.lane(id, () => this.drain(id)).catch(() => this.disarm(id, 'Could not prepare queued delivery'))
  }
  disarm(id: string, reason: string): void {
    this.invalidations.set(id, (this.invalidations.get(id) ?? 0) + 1); this.ready.delete(id)
    // Invalidate synchronously so an async prepare cannot later submit.
    const r = this.deps.store.getFollowup(id)
    if (r?.phase === 'queued') this.savePhase(id, r.id, 'saved', reason)
    this.deps.changed(id)
  }
  private savePhase(id: string, queueId: string, phase: FollowupPhase, reason?: string): boolean {
    const ok = this.deps.store.updateFollowup(id, queueId, r => ({ ...r, phase, reason, ...(phase !== 'queued' ? { after: undefined } : {}) }))
    if (!ok) this.localErrors.set(id, 'Could not save follow-up state. Delivery is paused; check storage.')
    this.deps.changed(id); return ok
  }
  private async drain(id: string): Promise<void> {
    const { store } = this.deps, r = store.getFollowup(id), fence = this.ready.get(id)
    if (!r || r.phase !== 'queued' || !sameFence(r.after, fence) || this.localErrors.has(id)) return
    const gate = this.deps.gate(id), scope = this.deps.scope(id)
    if (!scope || scope.sessionId !== r.sessionId || scope.provider !== r.provider || gate.kind === 'unavailable') { this.disarm(id, 'Connection changed — follow-up saved'); return }
    if (gate.kind === 'active') {
      if (!sameFence(gate.fence, r.after)) this.disarm(id, 'Another turn started — follow-up saved')
      return
    }
    if (gate.sessionId !== fence!.sessionId || gate.generation !== fence!.generation) { this.disarm(id, 'Session changed — follow-up saved'); return }
    if (gate.blocked) { this.deps.changed(id); return }
    const invalidation = this.invalidations.get(id) ?? 0
    try {
      for (const file of r.files) {
        const bytes = await privateBytes(file.path)
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Saved attachment changed')
      }
    } catch { this.disarm(id, 'Saved attachment is unavailable or changed. Restore the follow-up to repair it.'); return }
    if ((this.invalidations.get(id) ?? 0) !== invalidation || store.getFollowup(id)?.phase !== 'queued') return
    const attemptId = randomUUID()
    if (!store.updateFollowup(id, r.id, current => ({ ...current, phase: 'submitting', attemptId }))) { this.disarm(id, 'Could not save delivery attempt'); return }
    this.trace(r, 'submitting', true, attemptId)
    this.ready.delete(id); this.deps.changed(id)
    let outcome: NewTurnOutcome
    try { outcome = await this.deps.deliver(id, { ...r, phase: 'submitting', attemptId }, gate) }
    catch { outcome = { kind: 'uncertain', reason: 'Delivery not confirmed — check the conversation before sending again.' } }
    if (store.getFollowup(id)?.attemptId !== attemptId) return
    if (outcome.kind === 'accepted') {
      const removed = store.updateFollowup(id, r.id, () => null)
      if (!removed) {
        this.localErrors.set(id, 'Message accepted, but saved state could not be updated. Do not resend.')
        this.savePhase(id, r.id, 'uncertain', 'Message accepted. Do not resend.')
      }
      this.trace(r, 'provider-accepted', removed, attemptId)
    } else {
      const saved = this.savePhase(id, r.id, outcome.kind === 'uncertain' ? 'uncertain' : 'saved', outcome.reason)
      this.trace(r, outcome.kind === 'uncertain' ? 'uncertain' : 'retained', saved, attemptId)
    }
    this.deps.changed(id)
  }
  cancel(id: string, queueId: string): Promise<boolean> {
    const before = this.deps.store.getFollowup(id)
    if (!this.deps.scope(id) || !before || before.id !== queueId || !['queued', 'saved'].includes(before.phase)) return Promise.resolve(false)
    this.invalidations.set(id, (this.invalidations.get(id) ?? 0) + 1); this.ready.delete(id)
    return this.lane(id, () => {
      if (!this.deps.scope(id)) return false
      const r = this.deps.store.getFollowup(id)
      if (!r || r.id !== queueId || !['queued', 'saved'].includes(r.phase)) return false
      this.ready.delete(id)
      return this.savePhase(id, queueId, 'saved', 'Canceled — follow-up saved, not scheduled')
    })
  }
  restore(id: string, queueId: string, confirmUncertain = false): Promise<boolean> {
    return this.lane(id, () => {
      if (!this.deps.scope(id)) return false
      const ok = this.deps.store.restoreFollowup(id, queueId, this.deps.store.version(id), confirmUncertain)
      if (ok) { this.ready.delete(id); this.localErrors.delete(id) }
      this.deps.changed(id); return ok
    })
  }
  queueSaved(id: string, queueId: string): Promise<boolean> {
    return this.lane(id, () => {
      const r = this.deps.store.getFollowup(id), scope = this.deps.scope(id), gate = this.deps.gate(id)
      if (!scope || !r || r.id !== queueId || r.phase !== 'saved' || scope.sessionId !== r.sessionId || scope.provider !== r.provider || gate.kind !== 'active' || gate.blocked) return false
      this.ready.delete(id)
      const ok = this.deps.store.updateFollowup(id, queueId, current => ({ ...current, phase: 'queued', after: gate.fence, reason: undefined }))
      if (ok) this.localErrors.delete(id)
      this.deps.changed(id); return ok
    })
  }
  view(id: string): FollowupP | undefined {
    const r = this.deps.store.getFollowup(id)
    if (!r || !this.deps.scope(id)) return undefined
    const gate = this.deps.gate(id), empty = !this.deps.store.snapshot(id) && !this.deps.store.get(id).stagingCount
    return { id: r.id, phase: r.phase, preview: r.draft.text.slice(0, 180), attachments: r.draft.attachments,
      label: this.localErrors.get(id) ?? r.reason ?? (r.phase === 'queued' ? gate.kind !== 'unavailable' && gate.blocked ? 'Queued — waiting for your answer' : 'Queued — sends after this turn'
        : r.phase === 'submitting' ? 'Sending follow-up' : r.phase === 'uncertain' ? 'Delivery not confirmed — check the conversation' : 'Saved follow-up — not scheduled'),
      canCancel: r.phase === 'queued', canRestore: r.phase === 'saved' && empty,
      canQueueAgain: r.phase === 'saved' && gate.kind === 'active' && !gate.blocked }
  }
}
