/**
 * CODEX → BLOCKS. One item mapping, serving both Codex lanes.
 *
 * Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md §3.1, §5
 *
 * Codex describes what it did with the same item vocabulary in two places: the
 * app-server pushes `item/started` and `item/completed` over JSON-RPC (Codex
 * CLI), and the rollout file records the same items on disk (Codex Desktop).
 * That shared vocabulary is what lets one mapping serve both lanes instead of
 * two renderers drifting apart.
 *
 * THE CASING DIFFERS AND IT IS NOT COSMETIC. The wire says `commandExecution`
 * and `exitCode`; the rollout says `CommandExecution` and `exit_code`. Matching
 * only one of them would leave a whole lane silently empty, which is precisely
 * how the rollout reader once ended up finding nothing under a full
 * conversation. Both are normalised here, at the boundary, once.
 *
 * Fields verified against a real captured turn — see
 * `__fixtures__/app-server-live-turn.jsonl` and the tool beside it.
 */

import type { Block, Source } from '../blocks'

/** A notification as it arrives: a method and its params. */
export interface CodexNotification { method: string; params?: unknown }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Accept `exitCode` or `exit_code` — the wire and the rollout disagree. */
const pick = (o: Record<string, unknown>, ...names: string[]): unknown => {
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n]
  return undefined
}

/** `{secs, nanos}` (rollout) or a plain millisecond number (wire). */
function durationMs(v: unknown): number | undefined {
  const direct = num(v)
  if (direct !== undefined) return direct
  const d = obj(v)
  const secs = num(d.secs), nanos = num(d.nanos)
  if (secs === undefined && nanos === undefined) return undefined
  return Math.round((secs ?? 0) * 1000 + (nanos ?? 0) / 1e6)
}

/**
 * Count a change by its +/- lines.
 *
 * A modify carries a unified diff. An ADD carries the file's CONTENT, not a
 * diff — `{"kind":{"type":"add"},"diff":"ok\n"}` in the captured turn — so
 * counting '+' prefixes there would report zero for every new file. Detect the
 * unified form and fall back to counting lines.
 */
function countChange(diff: string, verb: 'Added' | 'Edited' | 'Deleted'): { added: number; removed: number } {
  const unified = /^@@ |\n@@ /.test(diff) || /^[+-]{3} /m.test(diff)
  if (unified) {
    let added = 0, removed = 0
    for (const line of diff.split('\n')) {
      if (/^\+\+\+|^---/.test(line)) continue      // file headers are not content
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
    return { added, removed }
  }
  const lines = diff.length ? diff.replace(/\n$/, '').split('\n').length : 0
  return verb === 'Deleted' ? { added: 0, removed: lines } : { added: lines, removed: 0 }
}

/**
 * Name a command the way Codex names it.
 *
 * `exec` twenty times down the panel says nothing — it is the transport, not
 * the act. Codex's own window shows "Ran mdfind …", "Listed files in …",
 * "Read files". The command line already contains the answer; this reads it.
 *
 * Deliberately shallow. It recognises the handful of shapes that dominate real
 * threads and falls back to the verb the user typed, which is always better
 * than the word `exec`. It never GUESSES at intent — an unrecognised command is
 * labelled by its own binary, not by a story about what it might be doing.
 */
export function commandLabel(command: string): string {
  // Strip the shell wrapper Codex adds: /bin/zsh -lc "the real command"
  const unwrapped = /^\S*(?:sh|zsh|bash)\s+-\w*c\s+["'](.+)["']$/s.exec(command.trim())
  const cmd = (unwrapped ? unwrapped[1] : command).trim()
  const head = cmd.split(/\s+/)[0] ?? ''
  const bin = head.split('/').pop() ?? head

  switch (bin) {
    case 'rg':
    case 'grep':
    case 'ugrep':   return 'Searched files'
    case 'ls':
    case 'find':
    case 'fd':      return 'Listed files'
    case 'cat':
    case 'head':
    case 'tail':
    case 'sed':     return 'Read files'
    case 'mdfind':  return 'Searched with Spotlight'
    case 'git':     return `Ran git ${(cmd.split(/\s+/)[1] ?? '').replace(/[^\w-]/g, '')}`.trim()
    case 'npm':
    case 'pnpm':
    case 'yarn':    return 'Ran a package script'
    case 'node':
    case 'python':
    case 'python3': return 'Ran a script'
    case 'pwd':
    case 'echo':    return 'Checked the workspace'
    case '':        return 'Ran a command'
    default:        return `Ran ${bin}`
  }
}

function textOfContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (!Array.isArray(v)) return ''
  return v.map((part) => str(obj(part).text) ?? '').filter(Boolean).join('')
}

function sourcesOf(v: unknown): Source[] {
  if (!Array.isArray(v)) return []
  return v.map((r) => {
    const o = obj(r)
    const url = str(o.url)
    if (!url) return null
    return {
      url,
      title: str(o.title) ?? url,
      domain: str(o.domain) ?? safeHost(url),
      ...(str(o.snippet) ? { snippet: str(o.snippet)! } : {}),
    } as Source
  }).filter((s): s is Source => s !== null)
}

function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/**
 * One Codex item → one block.
 *
 * Returns `unknown` — never null — for an item type we do not recognise, so a
 * new Codex item shows up as a quiet row instead of disappearing. Returns null
 * only for items that are deliberately not rendered.
 */
export function blockFromCodexItem(raw: unknown): Block | null {
  const item = obj(raw)
  const type = str(item.type)
  if (!type) return null
  // Normalise the casing difference between the wire and the rollout.
  switch (type.charAt(0).toLowerCase() + type.slice(1)) {
    case 'userMessage':
      return { kind: 'message', role: 'user', text: textOfContent(item.content) }

    case 'agentMessage': {
      const text = str(item.text) ?? textOfContent(item.content)
      if (!text) return null
      // PHASE DECIDES WHETHER THIS IS THE ANSWER OR NARRATION.
      //
      // Codex writes several agentMessages per turn: running commentary as it
      // works ("I'll get oriented in the repository…"), then the real answer,
      // tagged `final_answer`. Rendering them all as assistant messages put
      // Codex's own thinking-aloud into the chat as if each were a reply — and
      // because a reply ends a turn, three of them split one exchange into
      // three turns with no work in any of them, which is why the work group
      // vanished. Commentary belongs inside the work, where Codex puts it.
      const phase = str(item.phase)
      if (phase && phase !== 'final_answer') return { kind: 'reasoning', text }
      return { kind: 'message', role: 'assistant', text }
    }

    case 'reasoning': {
      const text = textOfContent(pick(item, 'summary_text', 'summaryText', 'summary'))
        || textOfContent(item.content)
      // An empty reasoning item is a placeholder Codex fills in later; drawing
      // a blank row for it would flicker an empty step into the panel.
      return text ? { kind: 'reasoning', text } : null
    }

    case 'commandExecution': {
      const command = Array.isArray(item.command) ? item.command.join(' ') : (str(item.command) ?? '')
      const named = commandLabel(command)
      const exitCode = num(pick(item, 'exitCode', 'exit_code'))
      const status = str(item.status)
      const running = status === 'inProgress' || status === 'running' || status === 'in_progress'
      return {
        kind: 'command',
        label: named,
        command,
        ...(str(item.cwd) ? { cwd: str(item.cwd)! } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(str(pick(item, 'aggregatedOutput', 'aggregated_output', 'stdout'))
          ? { output: str(pick(item, 'aggregatedOutput', 'aggregated_output', 'stdout'))! } : {}),
        ...(durationMs(pick(item, 'durationMs', 'duration')) !== undefined
          ? { durationMs: durationMs(pick(item, 'durationMs', 'duration'))! } : {}),
        status: running ? 'running' : exitCode !== undefined && exitCode !== 0 ? 'failed' : 'ok',
      }
    }

    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const first = obj(changes[0])
      const path = str(first.path) ?? ''
      const kindType = str(obj(first.kind).type) ?? str(first.kind) ?? 'modify'
      const verb = kindType === 'add' ? 'Added' : kindType === 'delete' ? 'Deleted' : 'Edited'
      const { added, removed } = countChange(str(first.diff) ?? str(first.content) ?? '', verb)
      return { kind: 'fileChange', path, verb, added, removed }
    }

    case 'mcpToolCall': {
      const inv = obj(pick(item, 'invocation') ?? item)
      const server = str(pick(inv, 'server')) ?? ''
      const tool = str(pick(inv, 'tool')) ?? ''
      const d = durationMs(pick(item, 'durationMs', 'duration'))
      const readOnly = pick(item, 'readOnlyHint', 'read_only_hint')
      return {
        kind: 'mcpCall', server, tool,
        ...(inv.arguments !== undefined ? { args: JSON.stringify(inv.arguments).slice(0, 300) } : {}),
        ...(d !== undefined ? { durationMs: d } : {}),
        ...(typeof readOnly === 'boolean' ? { readOnly } : {}),
      }
    }

    case 'extension': {
      // Codex's own wrapper for built-ins. `web.search` is the one with a UI.
      const kindName = str(item.kind) ?? ''
      if (!kindName.startsWith('web.search')) return { kind: 'unknown', raw: JSON.stringify(item).slice(0, 400) }
      return { kind: 'search', query: str(item.query) ?? '', results: sourcesOf(item.results) }
    }

    case 'contextCompaction':
      return { kind: 'compaction' }

    default:
      // A Codex item we have never seen. Draw it quietly rather than lose it.
      return { kind: 'unknown', raw: JSON.stringify(item).slice(0, 400) }
  }
}

export interface FoldedThread {
  blocks: Block[]
  usage?: { used: number; window: number; rateLimitPercent?: number; resetsAt?: number }
  /** Codex's own name for the thread, when it has set one. */
  name?: string
}

/**
 * Streaming accumulator for one thread.
 *
 * STATEFUL ON PURPOSE. `item/agentMessage/delta` arrives once per CHARACTER, so
 * re-folding the whole notification history on each one would be quadratic in
 * the length of the reply — a long answer would slow down as it streamed, which
 * is exactly when the user is watching. State is kept and each notification is
 * applied once.
 *
 * EVERY ITEM ARRIVES TWICE — once started, once completed — so blocks are
 * upserted by item id. Appending both would double every command on the card.
 */
export class CodexBlockStream {
  private readonly order: string[] = []
  private readonly byId = new Map<string, Block>()
  private readonly deltas = new Map<string, string>()
  private usage: FoldedThread['usage']
  private name: string | undefined

  private upsert(id: string, block: Block | null): void {
    if (!block) return
    if (!this.byId.has(id)) this.order.push(id)
    this.byId.set(id, block)
  }

  /** Apply one notification. Returns true when the thread's blocks changed. */
  push(ev: CodexNotification): boolean {
    const before = this.byId.size + this.order.length
    const snapshotBefore = this.order.length ? JSON.stringify(this.byId.get(this.order[this.order.length - 1])) : ''
    this.applyOne(ev)
    const after = this.byId.size + this.order.length
    const snapshotAfter = this.order.length ? JSON.stringify(this.byId.get(this.order[this.order.length - 1])) : ''
    return before !== after || snapshotBefore !== snapshotAfter
  }

  snapshot(): FoldedThread {
    return {
      blocks: this.order.map((id) => this.byId.get(id)!).filter(Boolean),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.name ? { name: this.name } : {}),
    }
  }

  private applyOne(ev: CodexNotification): void {
    const p = obj(ev.params)
    const upsert = (id: string, b: Block | null) => this.upsert(id, b)
    const order = this.order
    const byId = this.byId
    const deltas = this.deltas
    switch (ev.method) {
      case 'item/started':
      case 'item/completed': {
        const item = obj(p.item)
        const id = str(item.id) ?? `anon-${order.length}`
        const block = blockFromCodexItem(item)
        // A COMPLETED MESSAGE WINS OVER THE DELTAS THAT BUILT IT: the deltas are
        // an approximation streamed for latency, the final text is the truth.
        if (ev.method === 'item/completed') deltas.delete(id)
        if (block?.kind === 'message' && deltas.has(id)) {
          upsert(id, { ...block, text: deltas.get(id)! })
        } else {
          upsert(id, block)
        }
        break
      }

      case 'item/agentMessage/delta': {
        const id = str(p.itemId) ?? ''
        if (!id) break
        const next = (deltas.get(id) ?? '') + (str(p.delta) ?? '')
        deltas.set(id, next)
        const existing = byId.get(id)
        if (existing?.kind === 'message') upsert(id, { ...existing, text: next })
        else upsert(id, { kind: 'message', role: 'assistant', text: next })
        break
      }

      case 'item/reasoning/delta':
      case 'item/reasoningSummary/delta': {
        const id = str(p.itemId) ?? ''
        if (!id) break
        const next = (deltas.get('r:' + id) ?? '') + (str(p.delta) ?? '')
        deltas.set('r:' + id, next)
        upsert(id, { kind: 'reasoning', text: next, streaming: true })
        break
      }

      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? p.plan : Array.isArray(obj(p.plan).steps) ? obj(p.plan).steps as unknown[] : []
        if (!steps.length) break
        upsert('plan', {
          kind: 'plan',
          steps: steps.map((s) => {
            const o = obj(s)
            const st = str(o.status) ?? 'todo'
            return {
              text: str(o.text) ?? str(o.step) ?? '',
              status: st === 'completed' || st === 'done' ? 'done' : st === 'inProgress' || st === 'active' ? 'active' : 'todo',
            }
          }),
        })
        break
      }

      case 'thread/tokenUsage/updated': {
        // `last`, NOT `total`. `total` is the thread's LIFETIME spend — on a
        // real 72-turn thread it reads 33.5M against a 258k window, a meter at
        // 13,000% full. What a context meter means is how much of the window
        // the CURRENT context occupies, which is what `last` reports.
        const usage = obj(p.tokenUsage)
        const used = num(obj(usage.last).totalTokens) ?? num(obj(usage.total).totalTokens)
        if (used !== undefined) this.usage = { ...(this.usage ?? { window: 0 }), used, window: this.usage?.window ?? 0 }
        break
      }

      case 'account/rateLimits/updated': {
        const primary = obj(obj(p.rateLimits).primary)
        const pct = num(primary.usedPercent)
        if (pct !== undefined) {
          this.usage = { used: this.usage?.used ?? 0, window: this.usage?.window ?? 0, rateLimitPercent: pct, ...(num(primary.resetsAt) !== undefined ? { resetsAt: num(primary.resetsAt)! } : {}) }
        }
        break
      }

      // THE TURN'S CLOCK. `startedAt` is what lets the header count up live
      // instead of adding up subprocess times, which under-reports by the
      // minutes the model spends thinking between commands.
      case 'turn/started': {
        const startedAt = num(obj(p.turn).startedAt)
        upsert(`turn-start-${str(obj(p.turn).id) ?? order.length}`, {
          kind: 'turnStart',
          // Codex reports seconds here; the surface works in ms.
          startedAt: startedAt !== undefined ? (startedAt < 1e12 ? startedAt * 1000 : startedAt) : 0,
        })
        break
      }

      case 'turn/completed': {
        const t = obj(p.turn)
        const d = num(t.durationMs)
        upsert(`turn-end-${str(t.id) ?? order.length}`, {
          kind: 'turnEnd', ...(d !== undefined ? { durationMs: d } : {}),
        })
        break
      }

      case 'thread/name/updated':
        this.name = str(p.name) ?? str(obj(p.thread).name)
        break

      case 'thread/contextCompacted':
        upsert(`compact-${order.length}`, { kind: 'compaction' })
        break

      case 'error':
        upsert(`err-${order.length}`, { kind: 'error', message: str(p.message) ?? 'Codex reported an error' })
        break

      default:
        // An unknown METHOD is noise with no meaning attached, and is ignored.
        // That is not the same as an unknown ITEM TYPE, which is a future the
        // surface must still draw — see blockFromCodexItem's default branch.
        break
    }
  }
}

/**
 * Fold a whole notification history at once.
 *
 * The batch form, for reading a captured stream or a test fixture. Live traffic
 * uses CodexBlockStream directly so a per-character delta does not re-fold the
 * conversation behind it.
 */
export function foldAppServerBlocks(events: CodexNotification[]): FoldedThread {
  const stream = new CodexBlockStream()
  for (const ev of events) stream.push(ev)
  return stream.snapshot()
}
