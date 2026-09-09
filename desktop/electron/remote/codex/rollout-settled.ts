import { promises as fs } from 'node:fs'

/** Whether a Codex thread's own rollout says its last turn finished.
 *
 *  WHY READ THE FILE AT ALL. A task leaves `processing` when a live worker
 *  delivers `task_complete`. If nothing is attached when the turn ends — the
 *  worker was reaped, the app restarted, the route broke — that event is never
 *  delivered and the task stays "Working" forever, with no Stop button, because
 *  there is no live turn to stop. The rollout is append-only and is the thread's
 *  own record, so it can always answer the question the event stream dropped.
 *  Measured 2026-09-09: a task sat "Working" for an hour with `task_complete`
 *  already on disk.
 *
 *  `null` means UNKNOWN, never "still running". A caller must not settle a task
 *  on an unknown. */
export interface RolloutOutcome {
  settled: boolean
  lastAgentMessage?: string
  at?: string
}

/** Turns are bracketed by exactly these two markers, so whichever came last
 *  decides whether a turn is open. Everything between them is noise here. */
const TASK_STARTED = 'task_started'
const TASK_COMPLETE = 'task_complete'

/** A live rollout grows for as long as the session runs — one was measured at
 *  26GB. The markers we need are always within the last handful of events, so
 *  read a fixed window off the END and never size the read to the file. */
const TAIL_BYTES = 256 * 1024

/** Read up to `cap` bytes from the END of a file, without reading the whole
 *  file. The first line in the window is usually a fragment of a larger line;
 *  the tolerant parser below drops it rather than corrupting it. */
async function readBoundedSuffix(path: string, cap: number): Promise<string | null> {
  let fh
  try {
    fh = await fs.open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, cap)
    if (len === 0) return ''
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

export async function rolloutOutcome(path: string, tailBytes = TAIL_BYTES): Promise<RolloutOutcome | null> {
  const tail = await readBoundedSuffix(path, tailBytes)
  if (tail === null) return null

  // Walk backwards: the first turn marker we meet is the one that decides.
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let event: { timestamp?: string, payload?: { type?: string, last_agent_message?: string } }
    try { event = JSON.parse(line) } catch { continue } // torn by the window, or a half-written tail
    const type = event.payload?.type
    if (type === TASK_STARTED) return { settled: false }
    if (type !== TASK_COMPLETE) continue
    const outcome: RolloutOutcome = { settled: true }
    if (event.payload?.last_agent_message !== undefined) outcome.lastAgentMessage = event.payload.last_agent_message
    if (event.timestamp !== undefined) outcome.at = event.timestamp
    return outcome
  }
  return null
}
