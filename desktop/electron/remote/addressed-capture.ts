import type { DraftAttachment, TaskDraft, TaskDraftStore } from './task-draft'
import type { DraftSubmissionRequest, SubmitDraftOutcome } from './task-followup'
import { randomUUID } from 'node:crypto'

interface AddressedCaptureStaging {
  taskId: string
  text: string
  attachments: readonly string[]
  drafts: TaskDraftStore
  persistAttachment: (taskId: string, sourcePath: string) => Promise<DraftAttachment | null>
  onStaged?: (taskId: string, draft: TaskDraft) => void
  onAttachmentStageFailed?: (taskId: string, sourcePath: string, error: Error) => void
}
export type AddressedCaptureDelivery = AddressedCaptureStaging & { deliver: (taskId: string, draft: TaskDraft) => Promise<boolean>; submitDraft?: never }
export type QueuedAddressedCaptureDelivery = AddressedCaptureStaging & { submitDraft: (taskId: string, request: DraftSubmissionRequest) => Promise<SubmitDraftOutcome>; deliver?: never }

/** Stage one complete Right Option capture, expose it through the shared task
 * draft, then submit that exact snapshot to the locked voice address. */
export function deliverAddressedCapture(input: QueuedAddressedCaptureDelivery): Promise<SubmitDraftOutcome>
export function deliverAddressedCapture(input: AddressedCaptureDelivery): Promise<boolean>
export async function deliverAddressedCapture(input: AddressedCaptureDelivery | QueuedAddressedCaptureDelivery): Promise<boolean | SubmitDraftOutcome> {
  const before = input.drafts.get(input.taskId)
  input.drafts.appendText(input.taskId, (before.text ? '\n' : '') + input.text)
  if (input.submitDraft) {
    // Register the whole capture at once so Enter cannot overtake an in-flight
    // image handoff. The shared coordinator owns acknowledgement and clearing.
    let failed = false
    const stages = input.attachments.map(sourcePath => input.drafts.stageAttachment(input.taskId, async () => {
      try {
        const owned = await input.persistAttachment(input.taskId, sourcePath)
        if (!owned) throw new Error('attachment persistence was refused')
        return owned
      } catch (error) {
        failed = true
        input.onAttachmentStageFailed?.(input.taskId, sourcePath, error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    }).catch(() => {}))
    await Promise.all(stages)
    const snapshot = input.drafts.snapshot(input.taskId)
    if (snapshot) input.onStaged?.(input.taskId, snapshot)
    if (failed || !snapshot) return { kind: 'retained', reason: failed ? 'Capture attachment staging failed. Your draft is kept.' : 'Nothing to send.' }
    return input.submitDraft(input.taskId, { id: randomUUID(), snapshot })
  }
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
