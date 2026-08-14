export interface DraftAttachment {
  id: string
  path: string
  mimeType: string
  name: string
}

export interface TaskDraft {
  text: string
  attachments: DraftAttachment[]
}

const emptyDraft = (): TaskDraft => ({ text: '', attachments: [] })

const copyDraft = (draft: TaskDraft): TaskDraft => ({
  text: draft.text,
  attachments: draft.attachments.map((attachment) => ({ ...attachment })),
})

/**
 * Owns the unsent task reply. A snapshot is deliberately value-based: a send
 * completion may clear only the exact draft it accepted, never text or images
 * added while the provider was working.
 */
export class TaskDraftStore {
  private drafts = new Map<string, TaskDraft>()
  private traceIds = new Map<string, string>()
  /** Image paste crosses AppKit → IPC → disk before it can enter a draft.
   * Keep that work task-scoped so a subsequent Enter cannot overtake it. */
  private attachmentStages = new Map<string, Promise<void>>()
  private attachmentStageFailures = new Set<string>()

  get(taskId: string): TaskDraft {
    return copyDraft(this.drafts.get(taskId) ?? emptyDraft())
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

  setText(taskId: string, text: string): TaskDraft {
    const next = { ...this.get(taskId), text }
    this.drafts.set(taskId, next)
    return this.get(taskId)
  }

  appendText(taskId: string, text: string): TaskDraft {
    if (!text) return this.get(taskId)
    const current = this.get(taskId)
    return this.setText(taskId, current.text + text)
  }

  addAttachment(taskId: string, attachment: DraftAttachment): TaskDraft {
    const current = this.get(taskId)
    if (current.attachments.some((entry) => entry.id === attachment.id)) return current
    current.attachments.push({ ...attachment })
    this.drafts.set(taskId, current)
    return this.get(taskId)
  }

  async stageAttachment(
    taskId: string,
    persist: () => Promise<DraftAttachment | null>,
  ): Promise<void> {
    // A new user paste is an explicit retry of a previous failed handoff.
    if (!this.attachmentStages.has(taskId)) this.attachmentStageFailures.delete(taskId)
    const previous = this.attachmentStages.get(taskId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      try {
        const attachment = await persist()
        if (!attachment) {
          this.attachmentStageFailures.add(taskId)
          return
        }
        this.addAttachment(taskId, attachment)
      } catch (error) {
        this.attachmentStageFailures.add(taskId)
        throw error
      }
    })
    this.attachmentStages.set(taskId, current)
    try {
      await current
    } finally {
      if (this.attachmentStages.get(taskId) === current) this.attachmentStages.delete(taskId)
    }
  }

  async whenSettled(taskId: string): Promise<boolean> {
    // A stage may be queued while an earlier stage resolves. Follow the current
    // tail until no task-scoped persistence remains.
    while (this.attachmentStages.has(taskId)) {
      await this.attachmentStages.get(taskId)?.catch(() => {})
    }
    return !this.attachmentStageFailures.has(taskId)
  }

  removeAttachment(taskId: string, attachmentId: string): DraftAttachment | undefined {
    const current = this.get(taskId)
    const index = current.attachments.findIndex((entry) => entry.id === attachmentId)
    if (index < 0) return undefined
    const [removed] = current.attachments.splice(index, 1)
    this.drafts.set(taskId, current)
    return removed
  }

  snapshot(taskId: string): TaskDraft | null {
    const draft = this.get(taskId)
    return draft.text || draft.attachments.length ? draft : null
  }

  clearIfUnchanged(taskId: string, snapshot: TaskDraft): boolean {
    const current = this.get(taskId)
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) return false
    this.drafts.set(taskId, emptyDraft())
    this.traceIds.delete(taskId)
    return true
  }
}
import { randomUUID } from 'node:crypto'
