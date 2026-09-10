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

import { toolStatus, fullContent, type Block, type Source, type FileChange } from '../blocks'
import { basename, extname } from 'node:path'
import type { TaskInput } from '../task-input'

/** One ordered submission, retained independently even when paths repeat. */
export interface CodexInputMetadata { id: string; input: TaskInput[]; turnId?: string }
const inputSignature = (parts: Array<Record<string, unknown>>) => JSON.stringify([
  parts.map(p => typeof p.text === 'string' ? p.text : '').join(''),
  parts.filter(p => p.type === 'localImage' || p.type === 'image').map(p => p.path),
])

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
/**
 * Dig the shell command out of whatever Codex wrapped it in.
 *
 * THIS IS WHERE "Ran const" CAME FROM. Codex CLI does not run bare shell — it
 * runs JavaScript, and the command sits two layers inside:
 *
 *     const r = await tools.exec_command({"cmd":"sed -n '1,240p' …"}); text(r.output);
 *
 * Naming by first token found the keyword `const` and stamped it on every row
 * in the panel. Three wrappers appear in real threads: this one, a bare JSON
 * argument object, and `/bin/zsh -lc "…"`.
 *
 * Anything unrecognised is returned UNCHANGED. A wrong guess here would rename
 * a command to something it never ran, which is worse than showing the source.
 */
export function shellCommandOf(raw: string): string {
  const t = raw.trim()
  if (!t) return t

  // `…exec_command({"cmd":"…"})` or any JSON carrying a cmd/command key.
  const keyed = /["'](?:cmd|command|script)["']\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t)
  if (keyed) {
    try { return JSON.parse(`"${keyed[1]}"`) } catch { return keyed[1] }
  }

  // A shell wrapper: /bin/zsh -lc "the real command"
  const shell = /^\S*(?:sh|zsh|bash)\s+-\w*c\s+["'](.+)["']$/s.exec(t)
  if (shell) return shell[1]

  return t
}

/**
 * `start_session` → "Start session". The way Codex titles a tool call.
 *
 * An identifier is what the protocol calls it; a sentence is what the user
 * reads. Codex shows "Start session", "Get window state", "Web arm" — never the
 * snake_case id, and never the server bolted onto the front.
 */
export function toolTitle(name: string): string {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  if (!words) return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function commandLabel(command: string): string {
  const cmd = shellCommandOf(command).trim()
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
    default:
      // JAVASCRIPT, NOT A SHELL LINE. Codex CLI executes JS, and when no shell
      // command can be lifted out of it the first token is a keyword — which
      // is where "Ran const" came from. Naming the language beats naming the
      // syntax.
      if (/^(const|let|var|await|async|function|return|import)$/.test(bin)) return 'Ran a script'
      return `Ran ${bin}`
  }
}

/**
 * Text Codex injected into the user slot, rather than words the user typed.
 *
 * Retained for rollout readers. Formatting cannot establish injection provenance.
 */
export function isInjectedUserText(_text: string): boolean { return false }

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
    case 'userMessage': {
      const text = textOfContent(item.content)
      // WHAT CODEX INJECTS IS NOT WHAT YOU SAID. <environment_context>,
      // <recommended_plugins> and AGENTS.md preambles arrive as USER-role
      // items; shown, they open the panel with a wall of XML nobody typed.
      // The wire has no text-injection provenance. Literal formatting is user content.
      if (!text) return null
      return { kind: 'message', role: 'user', text }
    }

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
      const raw = Array.isArray(item.command) ? item.command.join(' ') : (str(item.command) ?? '')
      // SHOW THE COMMAND, NOT ITS TRANSPORT. A 400-character JS blob in the
      // panel is unreadable; the shell line inside it is the thing that ran.
      const command = shellCommandOf(raw)
      const named = commandLabel(raw)
      const exitCode = num(pick(item, 'exitCode', 'exit_code'))
      const status = str(item.status)
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
        status: (() => { const s = toolStatus(status, exitCode !== undefined && exitCode !== 0 ? 'failed' : 'succeeded'); return s === 'succeeded' ? 'ok' : s })(),
      }
    }

    case 'fileChange': {
      const changes: FileChange[] = (Array.isArray(item.changes) ? item.changes : []).map(raw => {
        const c = obj(raw), kind = str(obj(c.kind).type) ?? str(c.kind)
        const verb = kind === 'add' ? 'Added' : kind === 'delete' ? 'Deleted' : 'Edited'
        const diff = str(c.diff) ?? str(c.content) ?? ''
        return { path: str(c.path) ?? '', verb, ...countChange(diff, verb), diff }
      })
      return { kind: 'fileChange', ...(changes[0] ?? { path: '', verb: 'Edited', added: 0, removed: 0 }), changes, status: toolStatus(item.status) }
    }

    case 'mcpToolCall': {
      const inv = obj(pick(item, 'invocation') ?? item)
      const server = str(pick(inv, 'server')) ?? ''
      const tool = str(pick(inv, 'tool')) ?? ''
      const d = durationMs(pick(item, 'durationMs', 'duration'))
      const readOnly = pick(item, 'readOnlyHint', 'read_only_hint')
      return {
        kind: 'mcpCall', server, tool,
        ...(inv.arguments !== undefined ? { args: JSON.stringify(inv.arguments) } : {}),
        ...(d !== undefined ? { durationMs: d } : {}),
        ...(typeof readOnly === 'boolean' ? { readOnly } : {}),
        status: toolStatus(item.status, item.error ? 'failed' : 'succeeded'),
        ...(fullContent(item.result ?? item.output) !== undefined ? { output: fullContent(item.result ?? item.output) } : {}),
        ...(fullContent(item.error) !== undefined ? { error: fullContent(item.error) } : {}),
      }
    }

    case 'collabAgentToolCall': {
      const status = toolStatus(item.status)
      return { kind: 'subAgent', name: str(item.tool) ?? 'Subagent', status: status === 'succeeded' ? 'done' : status, output: fullContent(item.agentsStates) }
    }

    case 'extension': {
      // Codex's own wrapper for built-ins. `web.search` is the one with a UI.
      const kindName = str(item.kind) ?? ''
      if (!kindName.startsWith('web.search')) return { kind: 'unknown', raw: JSON.stringify(item) }
      return { kind: 'search', query: str(item.query) ?? '', results: sourcesOf(item.results) }
    }

    case 'contextCompaction':
      return { kind: 'compaction' }

    default:
      // A Codex item we have never seen. Draw it quietly rather than lose it.
      return { kind: 'unknown', raw: JSON.stringify(item) }
  }
}

export interface FoldedThread {
  blocks: Block[]
  usage?: { used: number; window: number; rateLimitPercent?: number; resetsAt?: number }
  /** Codex's own name for the thread, when it has set one. */
  name?: string
}

export type BlockUpdate = { index: number; block: Block }

export function applyBlockUpdates(blocks: Block[] | undefined, updates: BlockUpdate[]): Block[] {
  const next = [...(blocks ?? [])]
  for (const update of updates) {
    if (!Number.isInteger(update.index) || update.index < 0 || update.index > next.length) {
      throw new Error(`Codex block update index ${update.index} is outside transcript length ${next.length}`)
    }
    if (update.index === next.length) next.push(update.block)
    else next[update.index] = update.block
  }
  return next
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
  private inputMetadata: Array<{ signature: string; parts: TaskInput[]; used: boolean; turnId?: string }> = []
  private metadataByItem = new Map<string, TaskInput[]>()
  registerInputMetadata(parts: TaskInput[], turnId?: string): { turnId?: string } {
    const record = { signature: inputSignature(parts), parts, used: false, turnId }
    this.inputMetadata.push(record)
    return record
  }
  private readonly order: string[] = []
  private readonly byId = new Map<string, Block>()
  private readonly indexById = new Map<string, number>()
  private readonly deltas = new Map<string, string>()
  private readonly changed = new Map<number, Block>()
  private revision = 0
  private usage: FoldedThread['usage']
  private name: string | undefined
  private currentTurn: string | undefined

  private upsert(id: string, block: Block | null): void {
    if (!block) return
    if (JSON.stringify(this.byId.get(id)) === JSON.stringify(block)) return
    if (!this.byId.has(id)) {
      this.indexById.set(id, this.order.length)
      this.order.push(id)
    }
    this.byId.set(id, block)
    this.changed.set(this.indexById.get(id)!, block)
    this.revision++
  }

  /** Apply one notification. Returns true when the thread's blocks changed. */
  push(ev: CodexNotification, receivedAt?: number): boolean {
    const revision = this.revision
    const metadata = JSON.stringify([this.usage, this.name])
    this.applyOne(ev, receivedAt)
    return revision !== this.revision || metadata !== JSON.stringify([this.usage, this.name])
  }

  snapshot(): FoldedThread {
    return {
      blocks: this.order.map((id) => this.byId.get(id)!).filter(Boolean),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.name ? { name: this.name } : {}),
    }
  }

  /** Drain only blocks changed since the previous transport boundary. */
  takeBlockUpdates(): BlockUpdate[] {
    const updates = [...this.changed].sort(([a], [b]) => a - b).map(([index, block]) => ({ index, block }))
    this.changed.clear()
    return updates
  }

  metadata(): Omit<FoldedThread, 'blocks'> {
    return { ...(this.usage ? { usage: this.usage } : {}), ...(this.name ? { name: this.name } : {}) }
  }

  /** Pending approval details use the same item the transcript renders. */
  item(id: string): Block | undefined { return this.byId.get(id) }

  private applyOne(ev: CodexNotification, receivedAt?: number): void {
    const p = obj(ev.params)
    const upsert = (id: string, b: Block | null) => {
      if (b?.kind === 'message') {
        const previous = this.byId.get(id)
        const at = b.at ?? (previous?.kind === 'message' ? previous.at : undefined) ?? receivedAt
        if (at !== undefined) b = { ...b, at }
      }
      this.upsert(id, b)
    }
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
        if (item.type === 'userMessage' && Array.isArray(item.content)) {
          if (!this.metadataByItem.has(id)) {
            const signature = inputSignature(item.content as Array<Record<string, unknown>>)
            const matches = this.inputMetadata.filter(r => !r.used && r.signature === signature)
            const record = matches.find(r => r.turnId && r.turnId === p.turnId) ?? matches.find(r => !r.turnId)
            if (record) { record.used = true; this.metadataByItem.set(id, record.parts) }
          }
          const metadata = this.metadataByItem.get(id)
          if (metadata) {
            const prose = metadata.filter(part => part.type === 'text' && !part.attachment).map(part => part.type === 'text' ? part.text : '').join('')
            if (prose) upsert(id, { kind: 'message', role: 'user', text: prose })
            else if (byId.delete(id)) { order.splice(order.indexOf(id), 1); this.revision++ }
            metadata.forEach((part, index) => {
              const attachment = part.type === 'image' ? { path: part.path, name: part.name ?? basename(part.path), mimeType: part.mimeType ?? 'application/octet-stream', ...(part.bytes !== undefined ? { bytes: part.bytes } : {}) } : part.attachment
              if (attachment) upsert(`${id}:attachment:${index}`, { kind: 'attachment', ...attachment })
            })
            break
          }
          item.content.forEach((raw, index) => {
            const part = obj(raw)
            if (part.type !== 'localImage' || !str(part.path)) return
            const path = str(part.path)!
            const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
            upsert(`${id}:attachment:${index}`, { kind: 'attachment', path, name: basename(path), mimeType })
          })
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
        upsert(`plan:${str(p.turnId) ?? this.currentTurn ?? 'unscoped'}`, {
          kind: 'plan',
          turnId: str(p.turnId) ?? this.currentTurn,
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
        this.currentTurn = str(obj(p.turn).id) ?? `unscoped-${order.length}`
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
          ...(t.status ? { outcome: t.status === 'interrupted' || t.status === 'cancelled' ? 'cancelled' : t.status === 'failed' ? 'failed' : 'completed' } : {}),
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
