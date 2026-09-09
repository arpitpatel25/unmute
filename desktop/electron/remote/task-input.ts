import { readFile } from 'node:fs/promises'
import type { TaskDraft } from './task-draft'
import { canvasContract } from './canvas-contract'

export type TaskInput = { type: 'text'; text: string; attachment?: { path: string; name: string; mimeType: string; bytes?: number } } | { type: 'image'; path: string; name?: string; mimeType?: string; bytes?: number }

/**
 * The tray is a collapsed presentation, not a reordering of message content.
 *
 * AN ARMED VISUAL TOOL PREFIXES ITS CONTRACT HERE, and here is the only place
 * that can be right. The delivery path hands transports BOTH a flat `text` and
 * this parts array, and the structured transports use the PARTS — so a contract
 * applied to the flat string alone is measured by the logs, reported as sent,
 * and never actually reaches the agent. That is exactly what shipped in the
 * first cut of this feature: `chat-delivery-attempt` logged 1173 characters
 * while the agent's transcript recorded the user's 36. Building it into the
 * parts makes the two agree by construction, and it means every route that
 * turns a draft into input — an immediate send, a queued follow-up — carries
 * it without having to remember to.
 */
export async function draftInput(draft: TaskDraft): Promise<TaskInput[]> {
  const parts: TaskInput[] = []
  const contract = canvasContract(draft.tool)
  if (contract) parts.push({ type: 'text', text: `${contract}\n\n---\n\n` })
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
