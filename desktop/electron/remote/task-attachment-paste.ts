/**
 * Dependency-inverted pasteboard effect for an owned PTY. The Electron engine
 * registers the real macOS clipboard implementation; Remote owns only the
 * provider-neutral request and the exact PTY callback it must target.
 */
export type TaskImagePaste = (
  text: string,
  paths: readonly string[],
  paste: () => Promise<boolean>,
  observe?: (stage: string, fields: Record<string, unknown>) => void,
) => Promise<boolean>

export interface TaskDraftAttachmentPayload {
  taskId: string
  name: string
  mimeType: string
  data: Uint8Array
}

/**
 * Typed bridge into the existing task-composer attachment store. Delivery
 * callers provide bytes, never a filesystem destination, and success means the
 * composer has confirmed ownership of the attachment.
 */
export type TaskDraftAttachmentSink = (
  attachment: TaskDraftAttachmentPayload,
) => Promise<boolean>

let effect: TaskImagePaste | null = null
let draftAttachmentSink: TaskDraftAttachmentSink | null = null

export function registerTaskImagePaste(fn: TaskImagePaste): void { effect = fn }

export function registerTaskDraftAttachmentSink(fn: TaskDraftAttachmentSink): void {
  draftAttachmentSink = fn
}

export async function pasteTaskImages(
  text: string,
  paths: readonly string[],
  paste: () => Promise<boolean>,
  observe?: (stage: string, fields: Record<string, unknown>) => void,
): Promise<boolean> {
  return effect ? effect(text, paths, paste, observe) : false
}

export async function attachToTaskDraft(
  attachment: TaskDraftAttachmentPayload,
): Promise<boolean> {
  return draftAttachmentSink ? draftAttachmentSink(attachment) : false
}
