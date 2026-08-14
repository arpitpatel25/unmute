import type { DraftAttachment, TaskDraft, TaskDraftStore } from './task-draft'

export interface AddressedCaptureDelivery {
  taskId: string
  text: string
  attachments: readonly string[]
  drafts: TaskDraftStore
  persistAttachment: (taskId: string, sourcePath: string) => Promise<DraftAttachment | null>
  onStaged?: (taskId: string, draft: TaskDraft) => void
  onAttachmentStageFailed?: (taskId: string, sourcePath: string, error: Error) => void
  deliver: (taskId: string, draft: TaskDraft) => Promise<boolean>
}

/** Stage one complete Right Option capture, expose it through the shared task
 * draft, then submit that exact snapshot to the locked voice address. */
export async function deliverAddressedCapture(input: AddressedCaptureDelivery): Promise<boolean> {
  const before = input.drafts.get(input.taskId)
  input.drafts.appendText(input.taskId, (before.text ? '\n' : '') + input.text)
  let attachmentStageFailed = false
  for (const sourcePath of input.attachments) {
    try {
      const owned = await input.persistAttachment(input.taskId, sourcePath)
      if (!owned) throw new Error('attachment persistence was refused')
      input.drafts.addAttachment(input.taskId, owned)
    } catch (error) {
      attachmentStageFailed = true
      input.onAttachmentStageFailed?.(
        input.taskId,
        sourcePath,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }
  const snapshot = input.drafts.snapshot(input.taskId)
  if (!snapshot) return false
  input.onStaged?.(input.taskId, snapshot)
  // Delivery is atomic: never send the text or a partial subset of images when
  // any captured attachment could not be transferred into task ownership.
  if (attachmentStageFailed) return false
  const accepted = await input.deliver(input.taskId, snapshot)
  if (accepted) input.drafts.clearIfUnchanged(input.taskId, snapshot)
  return accepted
}
