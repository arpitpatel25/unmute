import { readFile } from 'node:fs/promises'
import type { TaskDraft } from './task-draft'

export type TaskInput = { type: 'text'; text: string; attachment?: { path: string; name: string; mimeType: string; bytes?: number } } | { type: 'image'; path: string; name?: string; mimeType?: string; bytes?: number }

/** The tray is a collapsed presentation, not a reordering of message content. */
export async function draftInput(draft: TaskDraft): Promise<TaskInput[]> {
  const parts: TaskInput[] = []
  let position = 0
  for (const a of [...draft.attachments].sort((a, b) => (a.offset ?? draft.text.length) - (b.offset ?? draft.text.length)
    || (a.reservationOrder !== undefined && b.reservationOrder !== undefined ? a.reservationOrder - b.reservationOrder : 0))) {
    const offset = Math.max(position, Math.min(draft.text.length, a.offset ?? draft.text.length))
    if (offset > position) parts.push({ type: 'text', text: draft.text.slice(position, offset) })
    position = offset
    if (a.mimeType.startsWith('image/')) parts.push({ type: 'image', path: a.path, name: a.name, mimeType: a.mimeType, bytes: a.bytes })
    else parts.push({ type: 'text', attachment: { path: a.path, name: a.name, mimeType: a.mimeType, bytes: a.bytes }, text: a.mimeType === 'text/x-unmute-paste'
      ? await readFile(a.path, 'utf8')
      : `\nAttached file: ${JSON.stringify(a.name)}\nLocal path: ${JSON.stringify(a.path)}\n` })
  }
  if (position < draft.text.length) parts.push({ type: 'text', text: draft.text.slice(position) })
  return parts
}
