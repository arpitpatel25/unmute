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

/** One side of the conversation, as a human would recognise it. The shape
 *  matches TurnP (notch-client.ts) so a Claude session projects into the same
 *  panel a Codex thread does — one Turn type, three producers. */
export interface Turn {
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp from the entry itself. */
  at?: string
  /** Stable id for keying a UI row. */
  uuid?: string
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

// ─── The conversation, both sides ───────────────────────────────────────────
//
// THE USER SIDE IS EVEN CLEANER THAN THE ASSISTANT SIDE, and the rule is one
// line. Measured on a real session: 211 lines have `type: "user"`, but only 17
// of them are a human talking. The other 194 are TOOL RESULTS, which Claude Code
// records as user turns because that is how the API frames them.
//
// They are told apart by the shape of `message.content`:
//   * a STRING  → a person typed (or spoke) this
//   * an ARRAY  → tool_result blocks being fed back
//
// No heuristics, no keyword matching, no guessing. `toolUseResult` on the entry
// is a second, independent tell for the same thing.

/** Parse one JSONL line into a conversation turn, or null if it is not one a
 *  human would recognise as part of the conversation. */
export function parseTurnLine(line: string): Turn | null {
  let o: unknown
  try { o = JSON.parse(line) } catch { return null }
  if (typeof o !== 'object' || o === null) return null
  const rec = o as {
    type?: unknown; message?: { content?: unknown }; isSidechain?: unknown
    timestamp?: unknown; uuid?: unknown; toolUseResult?: unknown
  }
  // A SUBAGENT'S conversation is not the user's. Without this, one Task call
  // floods the panel with an exchange the user never had and never saw.
  if (rec.isSidechain === true) return null
  const at = typeof rec.timestamp === 'string' ? rec.timestamp : undefined
  const uuid = typeof rec.uuid === 'string' ? rec.uuid : undefined

  if (rec.type === 'user') {
    const content = rec.message?.content
    // The whole filter. An array here is always tool_result.
    if (typeof content !== 'string') return null
    if (rec.toolUseResult !== undefined) return null // belt and braces
    const text = content.trim()
    return text ? { role: 'user', text, at, uuid } : null
  }
  if (rec.type === 'assistant') {
    const m = parseAssistantLine(line)
    return m && m.text ? { role: 'assistant', text: m.text, at, uuid } : null
  }
  return null // system, attachment, ai-title, mode, last-prompt, …
}

/** The conversation as a person would read it, oldest first. */
export function parseTurns(raw: string): Turn[] {
  const out: Turn[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const t = parseTurnLine(line)
    if (t) out.push(t)
  }
  return out
}

/**
 * The LATEST EXCHANGE: the most recent assistant message, and the user message
 * that prompted it — in that order, oldest first.
 *
 * This is what the stage shows. Not a scrollback: the question a returning user
 * has is "what did I ask, and what came back", and everything else is history
 * they can reach through the terminal.
 *
 * Degrades honestly: a task mid-first-turn yields just the user's message; a
 * session with nothing yet yields [].
 */
export function latestExchange(turns: readonly Turn[]): Turn[] {
  let lastAssistant = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') { lastAssistant = i; break }
  }
  // No reply yet — show what was asked, so the card is never blank while it works.
  if (lastAssistant === -1) {
    const lastUser = [...turns].reverse().find((t) => t.role === 'user')
    return lastUser ? [lastUser] : []
  }
  for (let i = lastAssistant - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return [turns[i], turns[lastAssistant]]
  }
  return [turns[lastAssistant]]
}

/** Read a transcript and return the latest exchange. Never throws. */
export async function readLatestExchange(path: string | null): Promise<Turn[]> {
  if (!path) return []
  try {
    return latestExchange(parseTurns(await fs.readFile(path, 'utf8')))
  } catch {
    return []
  }
}

// ─── Codex, into the same Turn shape ────────────────────────────────────────
//
// A Codex rollout carries the SAME conversation twice, and taking both doubles
// every turn. Measured on a real 800 KB rollout:
//
//   response_item  message/user  17   message/assistant  312
//   event_msg      user_message  17   agent_message      313
//
// They are duplicates of one another, not two granularities. `response_item` is
// the canonical record — it states a `role` explicitly, mirrors the shape
// Claude already uses here, and its content blocks are typed (`input_text` /
// `output_text`), so filtering is exact rather than positional. `event_msg` is
// the UI event stream and is ignored for turns.
//
// The 312-to-17 ratio is not an error: Codex narrates between tool calls, so a
// single user turn draws many short assistant messages. That is prose about
// what it did, which is exactly what a summary wants.

export type Harness = 'claude' | 'codex'

/** Identity out of a Codex `session_meta` line. */
export function codexIdentity(line: string): { sessionId?: string; cwd?: string } {
  let o: unknown
  try { o = JSON.parse(line) } catch { return {} }
  const rec = o as { type?: unknown; payload?: unknown }
  if (rec.type !== 'session_meta') return {}
  const p = (rec.payload ?? {}) as { session_id?: unknown; cwd?: unknown }
  return {
    ...(typeof p.session_id === 'string' ? { sessionId: p.session_id } : {}),
    ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
  }
}

/** Text out of a Codex content array, dropping anything that is not a message. */
function codexText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const block = b as { type?: unknown; text?: unknown }
    // Only the two message block types. Reasoning, tool calls and their output
    // carry the same weight of noise here that thinking and tool_result do on
    // the Claude side, and are dropped for the same reason.
    if ((block.type === 'input_text' || block.type === 'output_text')
      && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** One Codex rollout line as a conversation turn, or null if it is not one. */
export function parseCodexTurnLine(line: string): Turn | null {
  let o: unknown
  try { o = JSON.parse(line) } catch { return null }
  if (typeof o !== 'object' || o === null) return null
  const rec = o as { type?: unknown; timestamp?: unknown; payload?: unknown }
  if (rec.type !== 'response_item') return null
  const p = (rec.payload ?? {}) as { type?: unknown; role?: unknown; content?: unknown }
  if (p.type !== 'message') return null
  if (p.role !== 'user' && p.role !== 'assistant') return null
  const text = codexText(p.content)
  if (!text) return null
  return {
    role: p.role,
    text,
    ...(typeof rec.timestamp === 'string' ? { at: rec.timestamp } : {}),
  }
}

/** One line into a Turn, whichever harness wrote it. */
export function parseTurnLineFor(harness: Harness, line: string): Turn | null {
  return harness === 'codex' ? parseCodexTurnLine(line) : parseTurnLine(line)
}

/** Every turn in a transcript, oldest first, whichever harness wrote it. */
export function parseTurnsFor(harness: Harness, raw: string): Turn[] {
  const out: Turn[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const t = parseTurnLineFor(harness, line)
    if (t) out.push(t)
  }
  return out
}
