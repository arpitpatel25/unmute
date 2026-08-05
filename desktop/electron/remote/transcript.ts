// Unmute Remote — reading a Claude Code session the way Claude already wrote it.
//
// Claude Code stores every conversation as a JSONL at
// ~/.claude/projects/<cwd-slug>/<session-id>.jsonl — one typed object per line.
// Assistant entries carry `message.content` as an ARRAY OF TYPED BLOCKS:
//
//     text | thinking | tool_use | tool_result
//
// So the separation between "what a human should read" and "everything else" is
// already structural, on disk, and needs no model call to recover. Measured on a
// real 1.6 MB session: `text` blocks were 1.9% of the file. The remaining 98%
// is exactly the noise we never want to speak, show, or summarize.
//
// This is why Unmute no longer asks the model to write a `result.detail` field:
// its final reply already IS that, better written, at zero prompt cost.
//
// Every reader here is TOLERANT. The file is appended live, so a tail read can
// land mid-line; a bad line is skipped, never thrown. Same discipline as
// readStatus() — "no update this poll" beats a crash.

import { promises as fs } from 'node:fs'

/** One assistant turn's human-readable prose, with thinking and tools removed. */
export interface AssistantMessage {
  text: string
  /** Tool names invoked in the same entry — evidence of side effects. */
  tools: string[]
}

/** Tools whose use means the world changed: the task ACTED, it did not just
 *  answer. Read-only tools are deliberately absent — a task that only read and
 *  searched produced knowledge, which is `info`. */
const MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell',
])

/** Parse one JSONL line into an assistant message, or null for anything else
 *  (user turns, system lines, metadata, and any line caught mid-write). */
export function parseAssistantLine(line: string): AssistantMessage | null {
  let o: unknown
  try { o = JSON.parse(line) } catch { return null }
  if (typeof o !== 'object' || o === null) return null
  const rec = o as { type?: unknown; message?: { content?: unknown } }
  if (rec.type !== 'assistant') return null
  const content = rec.message?.content
  if (!Array.isArray(content)) return null
  const texts: string[] = []
  const tools: string[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const block = b as { type?: unknown; text?: unknown; name?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'tool_use' && typeof block.name === 'string') tools.push(block.name)
    // `thinking` and `tool_result` are dropped on purpose — see the header.
  }
  return { text: texts.join('\n').trim(), tools }
}

/** Every assistant turn in a transcript, oldest first. Tolerant throughout. */
export function parseTranscript(raw: string): AssistantMessage[] {
  const out: AssistantMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const m = parseAssistantLine(line)
    if (m) out.push(m)
  }
  return out
}

/** The last assistant turn that actually said something to the human. Most
 *  assistant entries are tool calls with no prose, so "the last entry" is the
 *  wrong answer — "the last entry WITH text" is the right one. */
export function lastAssistantText(messages: readonly AssistantMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].text) return messages[i].text
  }
  return null
}

/** Did this session change anything? Drives `info` vs `act` without asking. */
export function hadSideEffects(messages: readonly AssistantMessage[]): boolean {
  return messages.some((m) => m.tools.some((t) => MUTATING_TOOLS.has(t) || t.startsWith('mcp__')))
}

/** URLs the session's own prose mentions, de-duplicated, in order. Used as
 *  `result.artifacts` for navigate/watch/consume without the model being told
 *  to report them. Trailing punctuation is trimmed — prose ends sentences. */
export function urlsIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()[\]"']+/g) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** Read + parse a transcript file. Missing/unreadable ⇒ [] (never throws): a
 *  freshly-spawned session has no transcript yet, which is not an error. */
export async function readTranscript(path: string | null): Promise<AssistantMessage[]> {
  if (!path) return []
  try {
    return parseTranscript(await fs.readFile(path, 'utf8'))
  } catch {
    return []
  }
}
