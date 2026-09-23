import { open, stat } from 'node:fs/promises'

const MAX_TAIL_BYTES = 512 * 1024
const MAX_LINE_CHARS = 64 * 1024
const MAX_CONCLUSION_CHARS = 900

/** Read a recent completed answer without loading an entire raw transcript. */
export async function readSessionConclusion(path: string): Promise<string | undefined> {
  try {
    const size = (await stat(path)).size
    if (!size) return undefined
    const start = Math.max(0, size - MAX_TAIL_BYTES)
    const length = size - start
    const handle = await open(path, 'r')
    let tail: string
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      tail = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    const lines = tail.split('\n')
    if (start > 0) lines.shift() // The first line may begin halfway through a JSON record.
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!
      if (!line || line.length > MAX_LINE_CHARS) continue
      let record: any
      try { record = JSON.parse(line) } catch { continue }
      let conclusion: string | undefined
      if (record?.type === 'assistant' && record.message?.stop_reason === 'end_turn') {
        conclusion = record.message.content?.filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
          .map((block: any) => block.text).join('\n')
      } else if (record?.type === 'event_msg' && record.payload?.type === 'task_complete') {
        conclusion = record.payload.last_agent_message
      }
      if (typeof conclusion === 'string' && conclusion.trim()) return conclusion.trim().slice(0, MAX_CONCLUSION_CHARS)
    }
  } catch { /* An unavailable transcript must not break the index lookup. */ }
  return undefined
}
