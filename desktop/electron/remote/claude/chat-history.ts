import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { findTranscriptById } from '../transcript-locate'
import type { HistoryState } from '../codex/app-server-events'
import type { Block } from '../blocks'

type Frame = Record<string, any>
export type ClaudeHistory = { frames: Frame[]; history: HistoryState }
const incomplete = (frames: Frame[]) => frames.some(f => f.unmuteHistoryIncomplete === true)
/** Beside chat-frames.json while a reconnected session runs with saving
 * suspended: the saved file may be missing newer turns, so it cannot be
 * trusted alone and provider history is merged in on read. */
export const CLAUDE_HISTORY_STALE_MARKER = 'chat-frames.stale'

/** A block-only older display has no UUIDs to reconcile. Keep raw recovery
 * privately, but checkpoint the readable projection until complete recovery. */
export function retainClaudeHistoryDisplay(frames: Frame[], blocks: Block[], pendingTools?: Record<string, number>): Frame[] {
  return [...frames.filter(f => !f.unmuteHistoryProjection), { type: 'system', unmuteHistoryProjection: true, unmuteRetainedBlocks: blocks,
    ...(pendingTools ? { unmutePendingTools: pendingTools } : {}) }]
}

/** Local order is the spine: owned clock markers keep their original anchors.
 * Provider UUID matches enrich a record, never erase owned display metadata.
 * Partial records may add fields/frames but cannot overwrite readable locals. */
export function mergeClaudeHistory(local: Frame[], recovered: Frame[], complete = !incomplete(recovered)): Frame[] {
  const key = (frame: Frame) => typeof frame.uuid === 'string' ? `uuid:${frame.uuid}` : `frame:${JSON.stringify(frame)}`
  const frames: Frame[] = []
  const seen = new Set<string>()
  for (const frame of local) {
    if (complete && (frame.unmuteHistoryIncomplete || frame.unmuteHistoryProjection) || seen.has(key(frame))) continue
    seen.add(key(frame)); frames.push(frame)
  }
  const positions = new Map(frames.map((frame, index) => [key(frame), index]))
  const nextAnchors: number[] = []
  let next = frames.length
  for (let i = recovered.length - 1; i >= 0; i--) {
    nextAnchors[i] = next
    const at = positions.get(key(recovered[i]))
    if (at !== undefined) next = at
  }
  const additions = new Map<number, Frame[]>()
  for (let i = 0; i < recovered.length; i++) {
    const incoming = recovered[i]
    if (complete && (incoming.unmuteHistoryIncomplete || incoming.unmuteHistoryProjection)) continue
    const at = positions.get(key(incoming))
    if (at !== undefined) {
      const owned = Object.fromEntries(Object.entries(frames[at]).filter(([name]) => name.startsWith('unmute')))
      frames[at] = { ...(complete ? { ...frames[at], ...incoming } : { ...incoming, ...frames[at] }), ...owned }
      continue
    }
    if (seen.has(key(incoming))) continue
    seen.add(key(incoming))
    let insert = nextAnchors[i]
    // An older recovered record belongs before the next owned turn's start,
    // not between that start and its matching user UUID.
    while (insert > 0 && typeof frames[insert - 1].unmuteTurnStart === 'number') insert--
    const bucket = additions.get(insert) ?? []
    bucket.push(incoming); additions.set(insert, bucket)
  }
  return frames.flatMap((frame, index) => [...(additions.get(index) ?? []), frame]).concat(additions.get(frames.length) ?? [])
}

/** Read only this session. Never bind a neighbour or create a provider session. */
export async function readClaudeHistory(task: { home: string; cwd: string; sessionId?: string; chatUnstarted?: boolean }, projectsDir?: string): Promise<ClaudeHistory> {
  if (task.chatUnstarted) return { frames: [], history: { phase: 'empty' } }
  let saved: Frame[] = [], failure: string | undefined
  try {
    const value: unknown = JSON.parse(await fs.readFile(join(task.home, 'chat-frames.json'), 'utf8'))
    if (!Array.isArray(value) || value.some(f => !f || typeof f !== 'object' || !['user', 'assistant', 'system'].includes(f.type))) throw new Error('Invalid saved history frames')
    saved = value
    const stale = await fs.access(join(task.home, CLAUDE_HISTORY_STALE_MARKER)).then(() => true, () => false)
    if (saved.length && !incomplete(saved) && !stale) return { frames: saved, history: { phase: 'ready' } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure = `Could not read saved history: ${(error as Error).message}`
  }
  if (task.sessionId) {
    try {
      const path = await findTranscriptById(task.cwd, task.sessionId, { projectsDir })
      if (path) {
        const frames: Frame[] = []; let partial = false
        for (const line of (await fs.readFile(path, 'utf8')).split('\n')) {
          if (!line.trim()) continue
          try {
            const frame = JSON.parse(line)
            if (frame.isSidechain === true) continue
            if (frame.sessionId && frame.sessionId !== task.sessionId) throw new Error('History session identity differs')
            if (['user', 'assistant', 'system'].includes(frame.type)) frames.push(frame)
          } catch { partial = true }
        }
        if (frames.length) return { frames: mergeClaudeHistory(saved, partial ? [{ type: 'system', unmuteHistoryIncomplete: true }, ...frames] : frames, !partial),
          history: partial ? { phase: 'partial', reason: 'Some provider history records could not be read. Retry history after the provider finishes writing.', canRetry: true } : { phase: 'ready' } }
      }
    } catch (error) { failure = `Could not recover provider history: ${(error as Error).message}` }
  }
  return { frames: saved.length ? saved : [{ type: 'system', unmuteHistoryIncomplete: true }],
    history: { phase: failure ? 'failed' : saved.some(f => f.type !== 'system') ? 'partial' : 'missing',
      reason: failure ?? 'Earlier conversation history is unavailable. Retry history to recover the same session; existing messages are kept.', canRetry: true } }
}
