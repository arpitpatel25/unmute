import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { TaskDraft, TaskDraftStore } from './task-draft'

export interface AddressedCaptureDelivery {
  taskId: string
  text: string
  attachments: readonly string[]
  drafts: TaskDraftStore
  onStaged?: (taskId: string, draft: TaskDraft) => void
  deliver: (taskId: string, draft: TaskDraft) => Promise<boolean>
}

/** Stage one complete Right Option capture, expose it through the shared task
 * draft, then submit that exact snapshot to the locked voice address. */
export async function deliverAddressedCapture(input: AddressedCaptureDelivery): Promise<boolean> {
  const before = input.drafts.get(input.taskId)
  input.drafts.appendText(input.taskId, (before.text ? '\n' : '') + input.text)
  for (const path of input.attachments) input.drafts.addAttachment(input.taskId, {
    id: randomUUID(), path, mimeType: 'image/png', name: basename(path),
  })
  const snapshot = input.drafts.snapshot(input.taskId)
  if (!snapshot) return false
  input.onStaged?.(input.taskId, snapshot)
  const accepted = await input.deliver(input.taskId, snapshot)
  if (accepted) input.drafts.clearIfUnchanged(input.taskId, snapshot)
  return accepted
}
