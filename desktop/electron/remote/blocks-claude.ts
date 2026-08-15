/**
 * CLAUDE CODE → BLOCKS. The transcript, read as a conversation.
 *
 * Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md §3.3, §5
 *
 * `~/.claude/projects/**\/*.jsonl` — also the read path for Claude Desktop, via
 * cliSessionId. The reader this replaces kept `text` from user and assistant
 * entries and discarded everything else in the envelope, which across the
 * reference corpus meant throwing away 6,947 thinking blocks, 11,799 tool calls,
 * 11,819 tool results and every structured diff.
 *
 * TWO THINGS WERE NOT MERELY MISSING, THEY WERE MISLEADING:
 *   - a tool call the user REJECTED rendered exactly like one that succeeded
 *   - a sub-agent doing work rendered as nothing, so a busy task looked stalled
 * Both get their own block here.
 *
 * Field names verified across 400 transcripts / 55,956 lines on 2026-08-16.
 */

import type { Block, Source } from './blocks'

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export interface ClaudeBlocks {
  blocks: Block[]
  usage?: { used: number; window: number }
  /** Claude's own generated title for the session, when it has one. */
  title?: string
}

/** Claude Code's own context window. Not carried per message, so it is named here. */
const CONTEXT_WINDOW = 200_000

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => str(obj(p).type) === 'text')
    .map((p) => str(obj(p).text) ?? '')
    .join('')
}

/** `mcp__unmute-computer__click` → server `unmute-computer`, tool `click`. */
function splitMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const at = rest.indexOf('__')
  if (at < 0) return { server: rest, tool: '' }
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

function countPatch(patch: unknown): { added: number; removed: number } {
  let added = 0, removed = 0
  if (!Array.isArray(patch)) return { added, removed }
  for (const hunk of patch) {
    const lines = obj(hunk).lines
    if (!Array.isArray(lines)) continue
    for (const l of lines) {
      const s = typeof l === 'string' ? l : ''
      if (s.startsWith('+')) added++
      else if (s.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function lineCount(s: string): number {
  return s.length ? s.replace(/\n$/, '').split('\n').length : 0
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function sourcesOf(v: unknown): Source[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((r) => {
    const o = obj(r)
    // WebSearch nests its hits one level deeper under `content`.
    if (Array.isArray(o.content)) return sourcesOf(o.content)
    const url = str(o.url)
    if (!url) return []
    return [{ url, title: str(o.title) ?? url, domain: safeHost(url) }]
  })
}

/** A pending tool call, waiting for the result entry that completes it. */
interface Pending { name: string; input: Record<string, unknown>; index: number }

export function blocksFromClaudeTranscript(text: string): ClaudeBlocks {
  const blocks: Block[] = []
  const pending = new Map<string, Pending>()
  let usage: ClaudeBlocks['usage']
  let title: string | undefined

  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let entry: unknown
    try { entry = JSON.parse(raw) } catch { continue }   // torn last line while Claude writes
    const e = obj(entry)
    const type = str(e.type)

    // A SIDECHAIN IS ANOTHER AGENT'S CONVERSATION, in the same file. Inlining it
    // would interleave a sub-agent's private working into this thread. The
    // sub-agent still appears — as one subAgent block, from the Agent tool call
    // that started it.
    if (e.isSidechain === true) continue

    if (type === 'ai-title') { title = str(e.aiTitle) ?? title; continue }

    if (type === 'system') {
      const meta = obj(e.compactMetadata)
      if (Object.keys(meta).length) {
        blocks.push({
          kind: 'compaction',
          ...(num(meta.preTokens) !== undefined ? { before: num(meta.preTokens)! } : {}),
          ...(num(meta.postTokens) !== undefined ? { after: num(meta.postTokens)! } : {}),
          ...(str(meta.trigger) ? { trigger: str(meta.trigger)! } : {}),
        })
      }
      continue
    }

    if (type === 'user') {
      // A REJECTED TOOL CALL. The result entry carries the denial, and the call
      // it refers to must NOT also render as a command that ran.
      const denial = str(e.toolDenialKind)
      const result = obj(e.toolUseResult)
      const content = obj(e.message).content
      const toolUseId = Array.isArray(content)
        ? str(obj(content.find((c) => str(obj(c).type) === 'tool_result')).tool_use_id)
        : undefined

      if (denial && toolUseId) {
        const p = pending.get(toolUseId)
        if (p) {
          blocks.splice(p.index, 1)
          reindex(pending, p.index)
          pending.delete(toolUseId)
          blocks.push({ kind: 'denied', what: describeTool(p.name, p.input), reason: denial })
        } else {
          blocks.push({ kind: 'denied', what: 'A tool call', reason: denial })
        }
        continue
      }

      if (toolUseId && pending.has(toolUseId)) {
        completeTool(blocks, pending, toolUseId, result, Array.isArray(content) ? content : [])
        continue
      }

      // A REAL PROMPT. Meta entries are command output and hook noise Claude
      // writes into the user slot; they were never spoken.
      if (e.isMeta === true) continue
      const body = textOfContent(content)
      if (body) blocks.push({ kind: 'message', role: 'user', text: body })
      continue
    }

    if (type !== 'assistant') continue

    const message = obj(e.message)
    const u = obj(message.usage)
    const used = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0)
      + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.output_tokens) ?? 0)
    if (used > 0) usage = { used, window: CONTEXT_WINDOW }

    if (e.isApiErrorMessage === true) {
      const status = num(e.apiErrorStatus)
      blocks.push({
        kind: 'error',
        message: textOfContent(message.content) || `API error${status !== undefined ? ` ${status}` : ''}`,
      })
      continue
    }

    const content = Array.isArray(message.content) ? message.content : []
    for (const part of content) {
      const c = obj(part)
      switch (str(c.type)) {
        case 'text': {
          const body = str(c.text)
          if (body) blocks.push({ kind: 'message', role: 'assistant', text: body })
          break
        }
        case 'thinking': {
          const body = str(c.thinking) ?? str(c.text)
          if (body) blocks.push({ kind: 'reasoning', text: body })
          break
        }
        case 'tool_use': {
          const name = str(c.name) ?? ''
          const id = str(c.id) ?? ''
          const input = obj(c.input)
          const index = blocks.length
          const block = startTool(name, input, obj(e))
          if (!block) break
          blocks.push(block)
          if (id) pending.set(id, { name, input, index })
          break
        }
        default:
          break
      }
    }
  }

  return {
    blocks,
    ...(usage ? { usage } : {}),
    ...(title ? { title } : {}),
  }
}

/** Splicing a rejected call out shifts every later pending index down by one. */
function reindex(pending: Map<string, Pending>, removedAt: number): void {
  for (const [, p] of pending) if (p.index > removedAt) p.index--
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const cmd = str(input.command)
  if (cmd) return `${name} — ${cmd}`
  const path = str(input.file_path)
  if (path) return `${name} — ${path}`
  return name
}

/** The row a tool call opens, before its result arrives. */
function startTool(name: string, input: Record<string, unknown>, entry: Record<string, unknown>): Block | null {
  const mcp = splitMcpName(name)
  if (mcp) {
    return {
      kind: 'mcpCall',
      server: str(entry.attributionMcpServer) ?? mcp.server,
      tool: str(entry.attributionMcpTool) ?? mcp.tool,
      ...(Object.keys(input).length ? { args: JSON.stringify(input).slice(0, 300) } : {}),
    }
  }
  switch (name) {
    case 'Bash':
      return { kind: 'command', label: 'Bash', command: str(input.command) ?? '', status: 'running' }
    case 'Read':
      return { kind: 'fileRead', path: str(input.file_path) ?? '' }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return {
        kind: 'fileChange', path: str(input.file_path) ?? '',
        verb: name === 'Write' ? 'Added' : 'Edited', added: 0, removed: 0,
      }
    case 'WebSearch':
      return { kind: 'search', query: str(input.query) ?? '', results: [] }
    case 'WebFetch':
      return { kind: 'fileRead', path: str(input.url) ?? '' }
    case 'Agent':
      return {
        kind: 'subAgent',
        name: str(input.description) ?? str(input.subagent_type) ?? 'sub-agent',
        status: 'running',
      }
    case 'TaskCreate':
    case 'TaskUpdate':
      // Claude's plan lives in the task list rather than a plan event. Rendering
      // each mutation as a row would spam the panel; the plan block is derived
      // by the caller from task state instead.
      return null
    default:
      return { kind: 'command', label: name, command: describeTool(name, input), status: 'running' }
  }
}

/** Fold a tool's result into the row it opened. */
function completeTool(
  blocks: Block[], pending: Map<string, Pending>, id: string,
  result: Record<string, unknown>, content: unknown[],
): void {
  const p = pending.get(id)!
  pending.delete(id)
  const at = p.index
  const existing = blocks[at]
  if (!existing) return
  const isError = content.some((c) => obj(c).is_error === true)

  switch (existing.kind) {
    case 'command': {
      const stdout = str(result.stdout) ?? ''
      const stderr = str(result.stderr) ?? ''
      const interrupted = result.interrupted === true
      blocks[at] = {
        ...existing,
        status: isError || stderr && !stdout ? 'failed' : interrupted ? 'failed' : 'ok',
        ...(stdout || stderr ? { output: (stdout || stderr).slice(0, 2000) } : {}),
      }
      break
    }
    case 'fileChange': {
      const patch = result.structuredPatch
      const counted = countPatch(patch)
      // A CREATE HAS NO HUNKS. Its lines are the content it wrote, so counting
      // '+' prefixes would report zero for every new file.
      const added = counted.added || counted.removed
        ? counted.added
        : lineCount(str(result.content) ?? '')
      blocks[at] = {
        ...existing,
        path: str(result.filePath) ?? existing.path,
        verb: str(result.type) === 'create' ? 'Added' : existing.verb,
        added,
        removed: counted.removed,
      }
      break
    }
    case 'fileRead': {
      const file = obj(result.file)
      const body = str(file.content) ?? str(result.result)
      blocks[at] = {
        ...existing,
        path: str(file.filePath) ?? existing.path,
        ...(body ? { lines: lineCount(body) } : {}),
      }
      break
    }
    case 'search': {
      blocks[at] = { ...existing, results: sourcesOf(result.results) }
      break
    }
    case 'mcpCall': {
      blocks[at] = { ...existing, ok: !isError }
      break
    }
    case 'subAgent': {
      blocks[at] = { ...existing, status: isError ? 'failed' : 'done' }
      break
    }
    default:
      break
  }
}
