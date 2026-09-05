import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FollowupRecord } from './task-followup'

export interface DraftAttachment {
  id: string
  path: string
  mimeType: string
  name: string
  offset?: number
  bytes?: number
  replacedText?: string
  reservationOrder?: number
}

export interface DraftOperation {
  id: string; name: string; order: number; offset: number; selectedLength: number
  phase: 'reserved' | 'staging' | 'failed'; error?: string
}

export interface DraftInsertion { insertionOffset?: number; selectedLength?: number; clientRevision?: number; insertionText?: string; operationId?: string }

/** Translate an anchor through one editor replacement without moving an item
 * after text newly typed at that anchor. Offsets use UTF-16 in AppKit and JS. */
function movedOffset(before: string, after: string, offset: number): number {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = before.length, nextEnd = after.length
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  return offset <= start ? offset : offset >= end ? offset + nextEnd - end : start
}

export interface TaskDraft {
  text: string
  attachments: DraftAttachment[]
  /** Last native edit acknowledged; absent for drafts from older clients. */
  clientRevision?: number
  stagingCount?: number
  error?: string
  operations?: DraftOperation[]
}

const emptyDraft = (): TaskDraft => ({ text: '', attachments: [] })

const copyDraft = (draft: TaskDraft): TaskDraft => ({
  text: draft.text,
  attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  ...(draft.operations?.length ? { operations: draft.operations.map(o => ({ ...o })) } : {}),
  ...(draft.clientRevision !== undefined ? { clientRevision: draft.clientRevision } : {}),
})

/**
 * Owns the unsent task reply. A snapshot is deliberately value-based: a send
 * completion may clear only the exact draft it accepted, never text or images
 * added while the provider was working.
 */
export class TaskDraftStore {
  private undone = new Map<string, { item: DraftAttachment; text: string }>()
  private stageCounts = new Map<string, number>()
  private forgotten = new Set<string>()
  private stageErrors = new Map<string, string>()
  private canceledOperations = new Set<string>()
  private reservationSequence = 0
  private drafts = new Map<string, TaskDraft>()
  private followups = new Map<string, FollowupRecord>()
  private versions = new Map<string, number>()
  private persistencePath?: string
  private persistenceTimer?: ReturnType<typeof setTimeout>
  private persistenceError?: (error: unknown) => void

  connectFile(path: string, onError: (error: unknown) => void): void {
    this.persistencePath = path
    this.persistenceError = onError
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      const entries: unknown = Array.isArray(saved) ? saved : saved?.version === 2 ? saved.drafts : null
      if (!Array.isArray(entries)) throw new Error('Invalid saved drafts')
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const draft = entry[1]
        if (typeof draft?.text !== 'string' || !Array.isArray(draft.attachments)) continue
        if (!draft.attachments.every((a: DraftAttachment) => a && ['id', 'path', 'mimeType', 'name'].every((key) => typeof (a as unknown as Record<string, unknown>)[key] === 'string'))) continue
        const recovered = copyDraft(draft)
        recovered.operations = recovered.operations?.map(o => ({ ...o, phase: 'failed', error: o.error ?? 'Attachment preparation interrupted. Remove and attach again.' }))
        this.reservationSequence = Math.max(this.reservationSequence, ...recovered.attachments.map(a => a.reservationOrder ?? 0), ...(recovered.operations ?? []).map(o => o.order))
        this.drafts.set(entry[0], recovered)
      }
      for (const entry of Array.isArray(saved?.followups) ? saved.followups : []) {
        const r = entry?.[1] as FollowupRecord
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || r?.taskId !== entry[0] || r.owner !== 'unmute'
          || !['claude', 'codex'].includes(r.provider) || typeof r.id !== 'string' || typeof r.sessionId !== 'string'
          || typeof r.draft?.text !== 'string' || !Array.isArray(r.draft.attachments) || !Array.isArray(r.input) || !Array.isArray(r.files)
          || !['queued', 'saved', 'submitting', 'uncertain'].includes(r.phase)) continue
        this.followups.set(entry[0], { ...r, after: undefined,
          phase: r.phase === 'submitting' || r.phase === 'uncertain' ? 'uncertain' : 'saved',
          reason: r.phase === 'submitting' || r.phase === 'uncertain' ? 'Delivery not confirmed — check the conversation before sending again.' : 'Recovered — not scheduled' })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
    }
  }

  /** Coalesce edits received in one IPC turn; keep the latest draft durable
   * with an atomic private file, including on a graceful app shutdown. */
  flush(): boolean {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer)
    this.persistenceTimer = undefined
    return this.persist(this.drafts, this.followups)
  }

  private persist(drafts: Map<string, TaskDraft>, followups: Map<string, FollowupRecord>): boolean {
    if (!this.persistencePath) return true
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      const temp = `${this.persistencePath}.tmp-${randomUUID()}`
      writeFileSync(temp, JSON.stringify({ version: 2, drafts: [...drafts], followups: [...followups] }), { mode: 0o600 })
      renameSync(temp, this.persistencePath)
      return true
    } catch (error) { this.persistenceError?.(error); return false }
  }

  version(taskId: string): number { return this.versions.get(taskId) ?? 0 }
  private changed(taskId: string): void { this.versions.set(taskId, this.version(taskId) + 1) }
  getFollowup(taskId: string): FollowupRecord | undefined {
    const r = this.followups.get(taskId)
    return r ? structuredClone(r) : undefined
  }
  private transact(taskId: string, draft: TaskDraft, record?: FollowupRecord): boolean {
    const drafts = new Map(this.drafts), followups = new Map(this.followups)
    drafts.set(taskId, copyDraft(draft))
    if (record) followups.set(taskId, structuredClone(record)); else followups.delete(taskId)
    if (!this.persist(drafts, followups)) return false
    this.drafts = drafts; this.followups = followups; this.changed(taskId)
    return true
  }
  transferToFollowup(taskId: string, expectedVersion: number, record: FollowupRecord): boolean {
    if (this.forgotten.has(taskId) || this.version(taskId) !== expectedVersion || this.get(taskId).stagingCount || this.followups.has(taskId)
      || record.taskId !== taskId || record.owner !== 'unmute') return false
    const ok = this.transact(taskId, { ...emptyDraft(), clientRevision: this.get(taskId).clientRevision }, record)
    if (ok) this.traceIds.delete(taskId)
    return ok
  }
  updateFollowup(taskId: string, queueId: string, update: (record: FollowupRecord) => FollowupRecord | null): boolean {
    const r = this.getFollowup(taskId)
    if (!r || r.id !== queueId) return false
    const next = update(r)
    if (next && (next.id !== queueId || next.taskId !== taskId)) return false
    return this.transact(taskId, this.get(taskId), next ?? undefined)
  }
  restoreFollowup(taskId: string, queueId: string, expectedVersion: number, allowUncertain = false): boolean {
    const r = this.getFollowup(taskId), current = this.get(taskId)
    if (!r || r.id !== queueId || (r.phase !== 'saved' && !(allowUncertain && r.phase === 'uncertain'))
      || this.version(taskId) !== expectedVersion || current.text || current.attachments.length || current.stagingCount) return false
    return this.transact(taskId, { ...r.draft, clientRevision: current.clientRevision })
  }

  private save(taskId: string, draft: TaskDraft): void {
    this.changed(taskId)
    this.drafts.set(taskId, draft)
    if (!this.persistencePath || this.persistenceTimer) return
    this.persistenceTimer = setTimeout(() => this.flush(), 150)
    this.persistenceTimer.unref?.()
  }
  private traceIds = new Map<string, string>()
  /** Image paste crosses AppKit → IPC → disk before it can enter a draft.
   * Keep that work task-scoped so a subsequent Enter cannot overtake it. */
  private attachmentStages = new Map<string, Promise<void>>()
  private attachmentStageFailures = new Set<string>()

  get(taskId: string): TaskDraft {
    const draft = copyDraft(this.drafts.get(taskId) ?? emptyDraft())
    const count = (this.stageCounts.get(taskId) ?? 0) + (draft.operations ?? []).filter(o => o.phase !== 'failed').length
    const error = draft.operations?.find(o => o.error)?.error ?? this.stageErrors.get(taskId)
    return { ...draft,
      ...(count > 0 ? { stagingCount: count } : {}),
      ...(error ? { error } : {}),
    }
  }

  /** Stable only for the lifetime of the current unsent draft. It correlates
   * input events that happen before a delivery attempt has its own id. */
  traceId(taskId: string): string {
    const existing = this.traceIds.get(taskId)
    if (existing) return existing
    const id = randomUUID()
    this.traceIds.set(taskId, id)
    return id
  }

  setText(taskId: string, text: string, clientRevision?: number): TaskDraft {
    const current = this.get(taskId)
    if (clientRevision !== undefined && clientRevision < (current.clientRevision ?? 0)) return current
    const next = { ...current, text,
      attachments: current.attachments.map(a => ({ ...a, offset: movedOffset(current.text, text, a.offset ?? current.text.length) })),
      operations: this.moveOperations(current, text),
      ...(clientRevision !== undefined ? { clientRevision } : {}) }
    this.save(taskId, next)
    return this.get(taskId)
  }

  appendText(taskId: string, text: string): TaskDraft {
    if (!text) return this.get(taskId)
    const current = this.get(taskId)
    return this.setText(taskId, current.text + text)
  }

  insertText(taskId: string, text: string, insertion?: DraftInsertion): TaskDraft {
    const current = this.get(taskId)
    if (!insertion || insertion.insertionOffset === undefined) return this.appendText(taskId, text)
    const original = insertion.insertionText ?? current.text
    const offset = movedOffset(original, current.text, Math.max(0, Math.min(original.length, insertion.insertionOffset)))
    const length = original === current.text ? Math.max(0, insertion.selectedLength ?? 0) : 0
    return this.setText(taskId, current.text.slice(0, offset) + text + current.text.slice(offset + length))
  }

  addAttachment(taskId: string, attachment: DraftAttachment, insertion?: DraftInsertion): TaskDraft {
    const current = this.get(taskId)
    if (current.attachments.some((entry) => entry.id === attachment.id)) return current
    let offset = current.text.length
    if (insertion?.insertionOffset !== undefined) {
      const original = insertion.insertionText ?? current.text
      offset = movedOffset(original, current.text, Math.max(0, Math.min(original.length, insertion.insertionOffset)))
      // Never delete a selection that has since been edited. Its content is
      // still user-owned, even if disk staging completed a little later.
      if (current.text === original && insertion.selectedLength) {
        attachment = { ...attachment, replacedText: current.text.slice(offset, offset + insertion.selectedLength) }
        const text = current.text.slice(0, offset) + current.text.slice(offset + insertion.selectedLength)
        current.operations = this.moveOperations(current, text)
        current.attachments = current.attachments.map(a => ({ ...a, offset: movedOffset(current.text, text, a.offset ?? current.text.length) }))
        current.text = text
      }
    }
    const next = { ...attachment, ...(insertion?.operationId ? { id: insertion.operationId } : {}), offset }
    const before = next.reservationOrder === undefined ? -1 : current.attachments.findIndex(a =>
      a.reservationOrder !== undefined && a.reservationOrder > next.reservationOrder!)
    if (before < 0) current.attachments.push(next)
    else current.attachments.splice(before, 0, next)
    this.save(taskId, current)
    return this.get(taskId)
  }

  async stageAttachment(
    taskId: string,
    persist: () => Promise<DraftAttachment | null>,
    insertion?: DraftInsertion,
  ): Promise<void> {
    if (insertion?.operationId) return this.stageReservedAttachment(taskId, persist, insertion)
    this.changed(taskId)
    this.stageCounts.set(taskId, (this.stageCounts.get(taskId) ?? 0) + 1)
    this.stageErrors.delete(taskId)
    // A new user paste is an explicit retry of a previous failed handoff.
    if (!this.attachmentStages.has(taskId)) this.attachmentStageFailures.delete(taskId)
    const previous = this.attachmentStages.get(taskId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      if (this.forgotten.has(taskId)) return
      try {
        const attachment = await persist()
        if (this.forgotten.has(taskId)) return
        if (!attachment) {
          this.attachmentStageFailures.add(taskId)
          throw new Error('Attachment storage refused this file')
        }
        this.addAttachment(taskId, attachment, insertion)
      } catch (error) {
        this.attachmentStageFailures.add(taskId)
        this.stageErrors.set(taskId, (error as Error).message)
        throw error
      }
    })
    this.attachmentStages.set(taskId, current)
    try {
      await current
    } finally {
      this.changed(taskId)
      this.stageCounts.set(taskId, Math.max(0, (this.stageCounts.get(taskId) ?? 1) - 1))
      if (this.attachmentStages.get(taskId) === current) this.attachmentStages.delete(taskId)
    }
  }

  async whenSettled(taskId: string): Promise<boolean> {
    // A stage may be queued while an earlier stage resolves. Follow the current
    // tail until no task-scoped persistence remains.
    while (this.attachmentStages.has(taskId)) {
      if (!(this.stageCounts.get(taskId) ?? 0) && !(this.get(taskId).operations ?? []).some(o => o.phase === 'staging')) break
      await this.attachmentStages.get(taskId)?.catch(() => {})
    }
    return !this.attachmentStageFailures.has(taskId) && !(this.get(taskId).operations?.length)
  }

  private moveOperations(draft: TaskDraft, text: string): DraftOperation[] | undefined {
    return draft.operations?.map(o => {
      const offset = movedOffset(draft.text, text, o.offset)
      const end = movedOffset(draft.text, text, o.offset + o.selectedLength)
      // A selection survives edits outside it, but an overlapping replacement
      // invalidates deletion even if its new length happens to match.
      let start = 0
      while (start < draft.text.length && start < text.length && draft.text[start] === text[start]) start++
      let oldEnd = draft.text.length, newEnd = text.length
      while (oldEnd > start && newEnd > start && draft.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd-- }
      const insertedAtStart = start === oldEnd && start === o.offset && newEnd > start
      const touched = start < o.offset + o.selectedLength && (oldEnd > o.offset || insertedAtStart)
      return { ...o, offset, selectedLength: touched ? 0 : Math.max(0, end - offset) }
    })
  }

  reserveAttachment(taskId: string, id: string, name: string, insertion?: DraftInsertion): void {
    if (this.forgotten.has(taskId) || this.canceledOperations.has(`${taskId}:${id}`)) return
    const draft = this.get(taskId)
    if (draft.attachments.some(a => a.id === id)) return
    const existing = draft.operations?.find(o => o.id === id)
    if (existing) {
      if (existing.phase !== 'failed') return
      existing.phase = 'reserved'; delete existing.error
    } else {
      const original = insertion?.insertionText ?? draft.text
      const captured = Math.max(0, Math.min(original.length, insertion?.insertionOffset ?? original.length))
      const offset = movedOffset(original, draft.text, captured)
      draft.operations = [...(draft.operations ?? []), { id, name, order: ++this.reservationSequence, offset,
        selectedLength: original === draft.text ? Math.min(insertion?.selectedLength ?? 0, draft.text.length - offset) : 0,
        phase: 'reserved' }]
    }
    this.save(taskId, draft)
  }

  failAttachment(taskId: string, id: string, error: string): void {
    const draft = this.get(taskId), op = draft.operations?.find(o => o.id === id)
    if (!op || this.canceledOperations.has(`${taskId}:${id}`)) return
    op.phase = 'failed'; op.error = error
    this.save(taskId, draft)
  }

  private async stageReservedAttachment(taskId: string, persist: () => Promise<DraftAttachment | null>, insertion: DraftInsertion): Promise<void> {
    const id = insertion.operationId!, key = `${taskId}:${id}`
    if (this.canceledOperations.has(key) || this.forgotten.has(taskId)) return
    this.reserveAttachment(taskId, id, 'Attachment', insertion)
    const draft = this.get(taskId), op = draft.operations?.find(o => o.id === id)
    if (!op || op.phase === 'staging') return
    op.phase = 'staging'; delete op.error; this.save(taskId, draft)
    const previous = this.attachmentStages.get(taskId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      if (this.canceledOperations.has(key) || this.forgotten.has(taskId)) return
      try {
        const attachment = await persist()
        if (this.canceledOperations.has(key) || this.forgotten.has(taskId)) return
        if (!attachment) throw new Error('Attachment storage refused this file')
        const latest = this.get(taskId), anchor = latest.operations?.find(o => o.id === id)
        if (!anchor) return
        this.addAttachment(taskId, { ...attachment, reservationOrder: anchor.order }, {
          operationId: id, insertionOffset: anchor.offset, selectedLength: anchor.selectedLength, insertionText: latest.text,
        })
        const accepted = this.get(taskId)
        accepted.operations = accepted.operations?.filter(o => o.id !== id)
        this.save(taskId, accepted)
      } catch (error) {
        if (this.canceledOperations.has(key) || this.forgotten.has(taskId)) return
        this.failAttachment(taskId, id, error instanceof Error ? error.message : String(error))
        throw error
      }
    })
    this.attachmentStages.set(taskId, current)
    try { await current } finally {
      this.changed(taskId)
      if (this.attachmentStages.get(taskId) === current) this.attachmentStages.delete(taskId)
    }
  }

  removeAttachment(taskId: string, attachmentId: string): DraftAttachment | undefined {
    const current = this.get(taskId)
    this.canceledOperations.add(`${taskId}:${attachmentId}`)
    current.operations = current.operations?.filter(o => o.id !== attachmentId)
    const index = current.attachments.findIndex((entry) => entry.id === attachmentId)
    if (index < 0) { this.save(taskId, current); return undefined }
    const [removed] = current.attachments.splice(index, 1)
    this.save(taskId, current)
    return removed
  }

  restoreAttachment(taskId: string, attachmentId: string, text: string): void {
    const current = this.get(taskId)
    const item = current.attachments.find(a => a.id === attachmentId)
    if (!item) return
    const offset = Math.max(0, Math.min(current.text.length, item.offset ?? current.text.length))
    current.attachments = current.attachments.filter(a => a.id !== attachmentId)
      .map(a => ({ ...a, offset: (a.offset ?? current.text.length) >= offset ? (a.offset ?? current.text.length) + text.length : a.offset }))
    current.text = current.text.slice(0, offset) + text + current.text.slice(offset)
    current.operations = this.moveOperations(this.get(taskId), current.text)
    this.save(taskId, current)
  }

  undoAttachment(taskId: string, attachmentId: string): void {
    const current = this.get(taskId), item = current.attachments.find(a => a.id === attachmentId)
    if (!item) return
    this.restoreAttachment(taskId, attachmentId, item.replacedText ?? '')
    this.undone.set(`${taskId}:${attachmentId}`, { item, text: this.get(taskId).text })
  }

  redoAttachment(taskId: string, attachmentId: string): void {
    const key = `${taskId}:${attachmentId}`, undo = this.undone.get(key)
    if (!undo) return
    const current = this.get(taskId)
    const offset = movedOffset(undo.text, current.text, undo.item.offset ?? undo.text.length)
    this.addAttachment(taskId, undo.item, { insertionOffset: offset, insertionText: current.text,
      selectedLength: current.text === undo.text ? (undo.item.replacedText?.length ?? 0) : 0 })
    this.undone.delete(key)
  }

  snapshot(taskId: string): TaskDraft | null {
    const draft = this.get(taskId)
    return draft.text || draft.attachments.length ? draft : null
  }

  forget(taskId: string): void {
    this.changed(taskId)
    this.followups.delete(taskId)
    this.forgotten.add(taskId)
    this.drafts.delete(taskId)
    this.traceIds.delete(taskId)
    this.stageErrors.delete(taskId)
    this.attachmentStageFailures.delete(taskId)
    for (const key of this.canceledOperations) if (key.startsWith(`${taskId}:`)) this.canceledOperations.delete(key)
    for (const key of this.undone.keys()) if (key.startsWith(`${taskId}:`)) this.undone.delete(key)
    this.flush()
  }

  clearIfUnchanged(taskId: string, snapshot: TaskDraft): boolean {
    const current = this.get(taskId)
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) return false
    this.save(taskId, { ...emptyDraft(), clientRevision: current.clientRevision })
    this.traceIds.delete(taskId)
    return true
  }

  acceptSnapshot(taskId: string, snapshot: TaskDraft): void {
    const current = this.get(taskId)
    const acceptedIds = new Set(snapshot.attachments.map((attachment) => attachment.id))
    const text = current.text === snapshot.text ? ''
      : snapshot.text && current.text.startsWith(snapshot.text) ? current.text.slice(snapshot.text.length)
        : current.text
    this.save(taskId, {
      ...current, text,
      attachments: current.attachments.filter((attachment) => !acceptedIds.has(attachment.id))
        .map(a => ({ ...a, offset: movedOffset(current.text, text, a.offset ?? current.text.length) })),
    })
    this.traceIds.delete(taskId)
  }
}
