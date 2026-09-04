/**
 * WHAT THE AGENT ACTUALLY DID, line by line.
 *
 * The driver turns the CLI's stream-json into the four events the runtime
 * needs — handle, activity, completion, exit — and that is the right shape for
 * DRIVING the Agent. It is the wrong shape for explaining it afterwards,
 * because almost everything is thrown away on the way: a tool call keeps its
 * name and loses its arguments, thinking is dropped entirely, and a result
 * keeps its text and loses its cost, its duration and its token counts.
 *
 * So a turn that went wrong could be seen to have gone wrong and not read. The
 * `--resume` bug took a CLI reproduction to find something the stream had
 * already said in plain English, on a line nobody kept.
 *
 * This is that line, kept. It is a pure translation with no I/O of its own —
 * the caller decides where it goes — so the record can be tested against real
 * fixtures rather than against a mock of a logger.
 */

/** One thing that happened inside a turn. */
export type AgentTrace =
  | { kind: 'session'; sessionId: string; model?: string; tools?: number; mcpServers?: string[] }
  /** The model's own reasoning, when the CLI emits it. */
  | { kind: 'thinking'; text: string; chars: number }
  /** Prose addressed to the user, mid-turn. */
  | { kind: 'says'; text: string; chars: number }
  /** A tool call, WITH its arguments — the half the activity event drops. */
  | { kind: 'tool'; tool: string; input?: string; id?: string }
  /** What the tool gave back. */
  | { kind: 'toolResult'; id?: string; ok: boolean; chars: number; preview?: string }
  | {
    kind: 'result'
    ok: boolean
    subtype?: string
    text?: string
    chars?: number
    durationMs?: number
    costUsd?: number
    turns?: number
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  }
  /** A shape we do not recognise. Kept, never guessed at. */
  | { kind: 'other'; type: string }

/** Enough to diagnose, short enough to live on one line. */
export const TRACE_TEXT_MAX = 800
/** Arguments are usually small; a Write payload is not. */
export const TRACE_INPUT_MAX = 600

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…<+${text.length - max}>` : text
}

/**
 * SECRETS DO NOT GO IN THE LOG.
 *
 * The Agent's own MCP bearer token travels in its environment and can appear in
 * a tool argument or an error string. A log the user is asked to send us must
 * not be the thing that leaks it.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1<redacted>')
    .replace(/([A-Za-z0-9_]*(?:token|secret|key|password)[A-Za-z0-9_]*"?\s*[:=]\s*"?)[A-Za-z0-9._~+/=-]{12,}/gi,
      '$1<redacted>')
}

interface Block { type?: unknown; name?: unknown; text?: unknown; thinking?: unknown; id?: unknown; input?: unknown }

/**
 * One parsed stream-json value to zero or more trace records.
 *
 * Returns an ARRAY for the same reason the driver's parser does: one assistant
 * message can carry reasoning, prose and a tool call, and collapsing that to
 * one record silently drops two thirds of what happened.
 */
export function traceStreamLine(value: unknown): AgentTrace[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'system' && record.subtype === 'init') {
    if (typeof record.session_id !== 'string') return []
    const servers = Array.isArray(record.mcp_servers)
      ? record.mcp_servers
        .map((s) => (s && typeof s === 'object' ? (s as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === 'string')
      : undefined
    return [{
      kind: 'session',
      sessionId: record.session_id,
      ...(typeof record.model === 'string' ? { model: record.model } : {}),
      ...(Array.isArray(record.tools) ? { tools: record.tools.length } : {}),
      ...(servers?.length ? { mcpServers: servers } : {}),
    }]
  }

  if (type === 'assistant') {
    const message = record.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? message.content as Block[] : []
    const out: AgentTrace[] = []
    for (const block of blocks) {
      if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.push({ kind: 'thinking', text: clip(redactSecrets(block.thinking), TRACE_TEXT_MAX), chars: block.thinking.length })
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'says', text: clip(redactSecrets(block.text), TRACE_TEXT_MAX), chars: block.text.length })
      } else if (block?.type === 'tool_use') {
        out.push({
          kind: 'tool',
          tool: typeof block.name === 'string' ? block.name : 'unknown',
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
          ...(block.input !== undefined
            ? { input: clip(redactSecrets(safeJson(block.input)), TRACE_INPUT_MAX) }
            : {}),
        })
      }
    }
    return out
  }

  // A tool's answer arrives as a `user` message the CLI wrote to itself.
  if (type === 'user') {
    const message = record.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : []
    const out: AgentTrace[] = []
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue
      const body = typeof block.content === 'string' ? block.content : safeJson(block.content)
      out.push({
        kind: 'toolResult',
        ...(typeof block.tool_use_id === 'string' ? { id: block.tool_use_id } : {}),
        ok: block.is_error !== true,
        chars: body.length,
        preview: clip(redactSecrets(body), TRACE_INPUT_MAX),
      })
    }
    return out
  }

  if (type === 'result') {
    const usage = record.usage as Record<string, unknown> | undefined
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
    const text = typeof record.result === 'string' ? record.result : undefined
    return [{
      kind: 'result',
      ok: record.is_error !== true && record.subtype === 'success',
      ...(typeof record.subtype === 'string' ? { subtype: record.subtype } : {}),
      ...(text ? { text: clip(redactSecrets(text), TRACE_TEXT_MAX), chars: text.length } : {}),
      ...(num(record.duration_ms) !== undefined ? { durationMs: num(record.duration_ms) } : {}),
      ...(num(record.total_cost_usd) !== undefined ? { costUsd: num(record.total_cost_usd) } : {}),
      ...(num(record.num_turns) !== undefined ? { turns: num(record.num_turns) } : {}),
      ...(usage ? {
        usage: {
          ...(num(usage.input_tokens) !== undefined ? { input: num(usage.input_tokens) } : {}),
          ...(num(usage.output_tokens) !== undefined ? { output: num(usage.output_tokens) } : {}),
          ...(num(usage.cache_read_input_tokens) !== undefined ? { cacheRead: num(usage.cache_read_input_tokens) } : {}),
          ...(num(usage.cache_creation_input_tokens) !== undefined ? { cacheWrite: num(usage.cache_creation_input_tokens) } : {}),
        },
      } : {}),
    }]
  }

  return type ? [{ kind: 'other', type }] : []
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value) } catch { return '<unserializable>' }
}
