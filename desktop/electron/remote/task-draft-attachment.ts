import type { DraftAttachment, DraftInsertion, TaskDraftStore } from './task-draft'
import * as fs from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareChatImage } from './image-validation'

export async function persistTaskDraftFile(
  taskDrafts: TaskDraftStore,
  manager: { get(id: string): unknown; attachFile(id: string, data: Buffer, ext: string): Promise<string | null> } | null,
  id: string, sourcePath: string, mimeType: string, name: string,
): Promise<{ attachment: DraftAttachment; bytes: number } | null> {
  if (!manager || !manager.get(id)) return null
  const stat = await fs.stat(sourcePath)
  if (!stat.isFile()) throw new Error('Attach individual files, not folders')
  if (mimeType.startsWith('image/') && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) throw new Error('Use PNG, JPEG, GIF, or WebP images')
  const limit = mimeType.startsWith('image/') ? 10 * 1024 * 1024 : 25 * 1024 * 1024
  if (stat.size > limit) throw new Error(`Attachment exceeds ${limit / 1024 / 1024} MB`)
  if (taskDrafts.get(id).attachments.reduce((sum, a) => sum + (a.bytes ?? 0), stat.size) > 50 * 1024 * 1024) throw new Error('Attachments exceed the 50 MB message limit')
  const data = await fs.readFile(sourcePath)
  if (data.byteLength > limit) throw new Error(`Attachment exceeds ${limit / 1024 / 1024} MB`)
  const preparedImage = mimeType.startsWith('image/') ? await prepareChatImage(data, mimeType, name) : null
  const validatedMimeType = preparedImage?.mimeType ?? mimeType
  if (taskDrafts.get(id).attachments.length >= 10) throw new Error('A message can contain at most 10 attachments')
  const ext = mimeType.startsWith('image/')
    ? preparedImage!.extension
    : (basename(name).split('.').pop() || mimeType.split('/').pop() || 'bin').replace(/[^a-z0-9]/gi, '')
  const ownedPath = await manager.attachFile(id, data, ext)
  if (!ownedPath) return null
  return {
    attachment: { id: randomUUID(), path: ownedPath, mimeType: validatedMimeType, name: name || basename(ownedPath), bytes: data.byteLength },
    bytes: data.byteLength,
  }
}

/** Shared production acknowledgment boundary. Logging must not turn a rejected
 * handoff into a successful native acknowledgment. Cleanup also runs when a
 * canceled operation never enters persistence. */
export async function stageTaskDraftAttachment(deps: {
  drafts: TaskDraftStore
  persist: () => Promise<DraftAttachment | null>
  cleanup: () => Promise<void>
  failed: (error: unknown) => void
}, taskId: string, insertion?: DraftInsertion): Promise<void> {
  try { await deps.drafts.stageAttachment(taskId, deps.persist, insertion) }
  catch (error) { deps.failed(error); throw error }
  finally { await deps.cleanup() }
}
