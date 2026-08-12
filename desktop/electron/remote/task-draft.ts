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

  get(taskId: string): TaskDraft {
    return copyDraft(this.drafts.get(taskId) ?? emptyDraft())
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
    return true
  }
}
