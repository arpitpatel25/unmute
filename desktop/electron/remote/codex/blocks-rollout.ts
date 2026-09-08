/**
 * CODEX DESKTOP → BLOCKS. The rollout file, read as a conversation.
 *
 * Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md §3.2, §5
 *
 * Codex Desktop owns its own window and never speaks to us; the only record of
 * what happened is the rollout JSONL it writes to disk. This reads it.
 *
 * WHAT THIS LANE DOES NOT HAVE, and must not pretend to: streaming deltas, and
 * a plan. Searching all 185 rollouts on the reference machine found zero plan
 * or todo payloads, so "2 of 5" is not available here. The surface shows counts
 * instead and says why, rather than inventing a plan the file never carried.
 *
 * WHAT IT DOES HAVE, contrary to first impressions: live counts.
 * `patch_apply_end` lands MID-TURN — line 14 of a 20-line turn in a real file —
 * so files changed and running ±lines climb while the agent is still working.
 *
 * Event names and nesting verified across 185 sessions / 82,385 lines.
 */

import type { Block, Source } from '../blocks'
import { blockFromCodexItem, commandLabel } from './blocks-app-server'

/** `{"cmd":"pwd && rg …"}` → `pwd && rg …`. Falls through for plain strings. */
function commandFromArgs(raw: string): string {
  const t = raw.trim()
  if (!t.startsWith('{')) return t
  try {
    const o = JSON.parse(t) as Record<string, unknown>
    for (const key of ['cmd', 'command', 'script', 'input']) {
      const v = o[key]
      if (typeof v === 'string' && v) return v
      if (Array.isArray(v)) return v.join(' ')
    }
  } catch { /* not JSON after all */ }
  return t
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export interface RolloutBlocks {
  blocks: Block[]
  usage?: { used: number; window: number; rateLimitPercent?: number; resetsAt?: number }
  /** Wall time of the most recent completed turn, for the work group header. */
  lastTurnDurationMs?: number
}

/**
 * Codex prefixes tool output with its own status header:
 *
 *     Exit code: 0
 *     Wall time: 2.9 seconds
 *     Output:
 *     <the actual output>
 *
 * The exit code is the honest success signal. The parser this replaces
 * regex-matched the word "error" at the start of the output to guess, while the
 * real code sat two lines above it.
 */
function parseToolOutput(raw: string): { exitCode?: number; durationMs?: number; body: string } {
  const exit = /^Exit code:\s*(-?\d+)/m.exec(raw)
  const wall = /Wall time:\s*([\d.]+)\s*seconds/.exec(raw)
  const body = raw
    .replace(/^Script (?:completed|running[^\n]*)\n/, '')
    .replace(/^Exit code:[^\n]*\n?/m, '')
    .replace(/^Wall time:[^\n]*\n?/m, '')
    .replace(/^Output:\s*/m, '')
    .trim()
  return {
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
    ...(wall ? { durationMs: Math.round(parseFloat(wall[1]) * 1000) } : {}),
    body,
  }
}

function countContent(content: string, verb: 'Added' | 'Edited' | 'Deleted'): { added: number; removed: number } {
  const unified = /^@@ |\n@@ /.test(content)
  if (unified) {
    let added = 0, removed = 0
    for (const line of content.split('\n')) {
      if (/^\+\+\+|^---/.test(line)) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
    return { added, removed }
  }
  const lines = content.length ? content.replace(/\n$/, '').split('\n').length : 0
  return verb === 'Deleted' ? { added: 0, removed: lines } : { added: lines, removed: 0 }
}

function sourcesOf(v: unknown): Source[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((r) => {
    const o = obj(r)
    const url = str(o.url)
    // A RESULT WITH NO URL IS NOT A LINK. Rendering it would give the user
    // something that looks clickable and does nothing.
    if (!url) return []
    return [{
      url,
      title: str(o.title) ?? url,
      domain: str(o.domain) ?? url,
      ...(str(o.snippet) ? { snippet: str(o.snippet)! } : {}),
    }]
  })
}

function textOfContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (!Array.isArray(v)) return ''
  return v.map((p) => str(obj(p).text) ?? '').filter(Boolean).join('')
}

/**
 * Is this text something Codex injected rather than something you typed?
 *
 * MEASURED IN A REAL THREAD: alongside one genuine prompt, the rollout carried
 * `<recommended_plugins>`, `<environment_context>` and an AGENTS.md preamble as
 * USER-ROLE records. Rendering them opened the panel with a wall of plugin
 * listings and XML the user never wrote.
 *
 * Conservative on purpose — it matches the wrapper, not the content. A prompt
 * that merely mentions a tag is unaffected, because a real message does not
 * BEGIN with one.
 */
function isInjected(text: string): boolean {
  const t = text.trimStart()
  if (/^<\/?[a-z_][a-z0-9_-]*>/i.test(t)) return true          // <environment_context>, <INSTRUCTIONS>
  if (/^#+\s*AGENTS\.md\b/i.test(t)) return true               // repo instructions preamble
  if (/^<!--/.test(t)) return true                             // comment-fenced injections
  return false
}

export function blocksFromRollout(text: string): RolloutBlocks {
  const blocks: Block[] = []
  /** Prompts from response_item records, used only if no events exist. */
  // ONE PROMPT, TWO RECORDS, ONE BLOCK — deduped WITHIN A TURN.
  //
  // Codex writes a prompt as a `user_message` event AND as a `response_item`
  // with role user, so emitting both showed every question twice. The previous
  // cure held the response_items back and used them only when a thread had no
  // events at all, then unshifted them to the front.
  //
  // That broke on current threads (observed 29 Aug): a live two-turn rollout
  // carried NO user_message events, so the "old rollout" path fired on a brand
  // new one and hoisted BOTH questions above BOTH answers.
  //
  // Turn-scoped instead of global, because asking the same thing twice in one
  // conversation is ordinary and must render twice. The two records for a
  // single prompt always land in the same turn; the same text in a later turn
  // is a genuine repeat.
  let userTextsThisTurn = new Set<string>()
  // call_id → index in `blocks`, so an output can complete the call that opened
  // several lines earlier without re-walking what we have already emitted.
  const pending = new Map<string, number>()
  let usage: RolloutBlocks['usage']
  let lastTurnDurationMs: number | undefined

  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let entry: unknown
    // A TORN LAST LINE IS NORMAL. Codex is appending while we read.
    try { entry = JSON.parse(raw) } catch { continue }
    const e = obj(entry)
    const timestamp = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : undefined
    const at = timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : undefined
    const p = obj(e.payload)
    const t = str(p.type) ?? str(e.type)
    if (!t) continue

    switch (t) {
      case 'user_message': {
        const message = str(p.message)
        if (!message || isInjected(message)) break
        if (userTextsThisTurn.has(message)) break   // the response_item got here first
        userTextsThisTurn.add(message)
        blocks.push({ kind: 'message', role: 'user', text: message, ...(at !== undefined ? { at } : {}) })
        break
      }

      // THE REPLY COMES FROM task_complete, NOT agent_message.
      //
      // Both carry the final text, and emitting both would print every answer
      // twice. `task_complete` is preferred because it also carries the turn's
      // wall time, which the work group header needs.
      case 'agent_message':
        break

      // THE TURN'S CLOCK — see the note in blocks-app-server.ts. Codex writes
      // these as epoch SECONDS here, unlike the wire.
      case 'task_started': {
        // A new turn: the same wording from here on is a genuine repeat, not
        // the second copy of the prompt that opened the previous turn.
        userTextsThisTurn = new Set<string>()
        const s = num(p.started_at)
        blocks.push({ kind: 'turnStart', startedAt: s !== undefined ? (s < 1e12 ? s * 1000 : s) : 0 })
        break
      }

      case 'task_complete': {
        const textOut = str(p.last_agent_message)
        const d = num(p.duration_ms)
        blocks.push({ kind: 'turnEnd', outcome: 'completed', ...(d !== undefined ? { durationMs: d } : {}) })
        if (textOut) blocks.push({ kind: 'message', role: 'assistant', text: textOut, ...(at !== undefined ? { at } : {}) })
        if (d !== undefined) lastTurnDurationMs = d
        break
      }

      case 'agent_reasoning': {
        const r = str(p.text)
        if (r) blocks.push({ kind: 'reasoning', text: r })
        break
      }

      case 'custom_tool_call':
      case 'function_call': {
        const callId = str(p.call_id)
        // A function_call carries JSON arguments — {"cmd":"pwd && rg …"}. Shown
        // raw that is worse than the `exec` it replaces, so the command is
        // lifted out of it.
        const rawInput = str(p.input) ?? str(p.arguments) ?? ''
        const input = commandFromArgs(rawInput)
        const name = str(p.name) ?? 'step'
        // An MCP call is a function call with a namespace. Same event, different row.
        const ns = str(p.namespace)
        if (ns) {
          blocks.push({ kind: 'mcpCall', server: ns, tool: name, ...(input ? { args: input.slice(0, 300) } : {}) })
          if (callId) pending.set(callId, blocks.length - 1)
          break
        }
        blocks.push({ kind: 'command', label: commandLabel(input), command: input, status: 'running' })
        if (callId) pending.set(callId, blocks.length - 1)
        break
      }

      case 'custom_tool_call_output':
      case 'function_call_output': {
        const callId = str(p.call_id)
        const at = callId ? pending.get(callId) : undefined
        if (at === undefined) break
        pending.delete(callId!)
        const existing = blocks[at]
        const parsed = parseToolOutput(str(p.output) ?? '')
        if (existing.kind === 'mcpCall') {
          blocks[at] = { ...existing, ok: parsed.exitCode === undefined || parsed.exitCode === 0 }
          break
        }
        if (existing.kind !== 'command') break
        blocks[at] = {
          ...existing,
          status: parsed.exitCode !== undefined && parsed.exitCode !== 0 ? 'failed' : 'ok',
          ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
          ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
          ...(parsed.body ? { output: parsed.body.slice(0, 2000) } : {}),
        }
        break
      }

      case 'patch_apply_end': {
        const changes = obj(p.changes)
        for (const [path, change] of Object.entries(changes)) {
          const c = obj(change)
          const kindType = str(c.type) ?? str(obj(c.kind).type) ?? 'modify'
          const verb = kindType === 'add' ? 'Added' : kindType === 'delete' ? 'Deleted' : 'Edited'
          const { added, removed } = countContent(str(c.content) ?? str(c.diff) ?? '', verb)
          blocks.push({ kind: 'fileChange', path, verb, added, removed })
        }
        break
      }

      case 'mcp_tool_call_end': {
        const inv = obj(p.invocation)
        const d = obj(p.duration)
        const secs = num(d.secs), nanos = num(d.nanos)
        const ms = secs === undefined && nanos === undefined
          ? undefined : Math.round((secs ?? 0) * 1000 + (nanos ?? 0) / 1e6)
        const readOnly = p.read_only_hint
        blocks.push({
          kind: 'mcpCall',
          server: str(inv.server) ?? '',
          tool: str(inv.tool) ?? '',
          ...(inv.arguments !== undefined ? { args: JSON.stringify(inv.arguments).slice(0, 300) } : {}),
          ...(ms !== undefined ? { durationMs: ms } : {}),
          ...(typeof readOnly === 'boolean' ? { readOnly } : {}),
        })
        break
      }

      case 'web_search_end': {
        blocks.push({ kind: 'search', query: str(p.query) ?? '', results: sourcesOf(p.results) })
        break
      }

      case 'sub_agent_activity': {
        const name = str(p.agent_path) ?? str(p.agent_thread_id) ?? 'sub-agent'
        blocks.push({ kind: 'subAgent', name, status: 'done' })
        break
      }

      case 'context_compacted':
      case 'compacted':
        blocks.push({ kind: 'compaction' })
        break

      // ESCAPE IS AN ENDING, AND IT IS WORTH SAYING SO. Ignoring turn_aborted is
      // what left nine threads on the reference machine permanently claiming to
      // be `processing`; the fix landed in rollout.ts, and here it earns a row
      // so the user can see the turn they stopped.
      case 'turn_aborted':
        blocks.push({ kind: 'denied', what: 'Turn stopped', ...(str(p.reason) ? { reason: str(p.reason)! } : {}) })
        break

      case 'error':
      case 'stream_error':
        blocks.push({ kind: 'error', message: str(p.message) ?? 'Codex reported an error' })
        break

      case 'token_count': {
        const info = obj(p.info)
        // `last_token_usage`, NOT `total_token_usage` — see the note in
        // blocks-app-server.ts. Measured on a real 72-turn thread: total reads
        // 33,595,604 against a 258,400 window; last reads 167,452, which is the
        // 65% a context meter is for.
        const used = num(obj(info.last_token_usage).total_tokens)
          ?? num(obj(info.total_token_usage).total_tokens)
        const window = num(info.model_context_window)
        const primary = obj(obj(p.rate_limits).primary)
        usage = {
          used: used ?? usage?.used ?? 0,
          window: window ?? usage?.window ?? 0,
          ...(num(primary.used_percent) !== undefined ? { rateLimitPercent: num(primary.used_percent)! } : {}),
          ...(num(primary.resets_at) !== undefined ? { resetsAt: num(primary.resets_at)! } : {}),
        }
        break
      }

      // The structured item model, when Codex writes it. Same vocabulary as the
      // app-server wire, PascalCase here — one mapping handles both.
      case 'item_completed': {
        const b = blockFromCodexItem(p.item)
        // A user/assistant message would duplicate the event_msg above it.
        if (b && b.kind !== 'message' && b.kind !== 'unknown') blocks.push(b)
        break
      }

      case 'message': {
        // response_item/message — the transcript's own copy of the prompt.
        //
        // HELD BACK, NOT EMITTED. Codex records the same prompt as BOTH an
        // event and a response_item, so emitting here put every question on
        // screen twice. The event is the authority. These are kept aside and
        // used only if the thread turns out to have no events at all, which is
        // the case for older rollouts — dropping them outright would leave
        // those threads showing no question.
        if (str(p.role) !== 'user') break
        const body = textOfContent(p.content)
        if (!body || isInjected(body)) break
        if (userTextsThisTurn.has(body)) break      // the event got here first
        userTextsThisTurn.add(body)
        blocks.push({ kind: 'message', role: 'user', text: body, ...(at !== undefined ? { at } : {}) })
        break
      }

      default:
        break
    }
  }

  return {
    blocks,
    ...(usage ? { usage } : {}),
    ...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {}),
  }
}
