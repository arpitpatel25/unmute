/**
 * CHAT VIEW BLOCKS — one open vocabulary, three very different sources.
 *
 * Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md
 *
 * The surface used to take a flat row — `{role, text, title?, code?, output?,
 * durationMs?, ok?}` — declared four times by hand across TS and Swift and
 * collapsed to three render kinds. Every provider had to squeeze into it, so a
 * file diff, an MCP call and a shell command all arrived as the same grey row,
 * and anything richer was dropped at parse time. Some of that loss was not
 * cosmetic: a REJECTED tool call rendered identically to a successful one.
 *
 * A block is what one thing the agent did looks like. Each provider's reader
 * emits only the kinds its source actually supports — see the mapping table in
 * §5 of the spec — and the renderer draws a view per kind.
 *
 * THE OPEN RULE, which is the whole reason this is a union and not a wider row:
 * an unrecognised kind becomes `unknown` and draws as a quiet plain row. It must
 * NEVER fall through to a message. The old `default:` branch did exactly that,
 * turning anything it did not recognise into an assistant bubble — wrong rather
 * than absent, which is the worse of the two failures. Degrading properly is
 * what lets one lane ship a richer kind without every other lane, and the Swift
 * surface, being taught about it first.
 */

export interface Source {
  title: string
  domain: string
  url: string
  snippet?: string
}

export interface PlanStep {
  text: string
  status: 'todo' | 'active' | 'done'
}

export type ToolStatus = 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled'
export type TurnOutcome = 'completed' | 'failed' | 'cancelled'
export type FileChange = { path: string; verb: 'Added' | 'Edited' | 'Deleted'; added: number; removed: number; diff?: string }
/** Provider status takes precedence over absent exit codes. */
export function toolStatus(value: unknown, fallback: ToolStatus = 'succeeded'): ToolStatus {
  const status = String(value ?? '').toLowerCase().replace(/[_-]/g, '')
  if (['inprogress', 'running', 'pending'].includes(status)) return 'running'
  if (['cancelled', 'canceled', 'interrupted', 'shutdown'].includes(status)) return 'cancelled'
  if (['denied', 'declined', 'rejected'].includes(status)) return 'denied'
  if (['failed', 'error', 'errored'].includes(status)) return 'failed'
  return fallback
}
export function fullContent(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export type Block =
  | { kind: 'attachment'; path: string; name: string; mimeType: string; bytes?: number }
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; at?: number }
  | { kind: 'reasoning'; text: string; streaming?: boolean }
  | {
      kind: 'command'
      /** What to call it in the UI — "Ran command", "Running", "Bash". */
      label: string
      command: string
      cwd?: string
      exitCode?: number
      output?: string
      durationMs?: number
      status: 'running' | 'ok' | 'failed' | 'denied' | 'cancelled'
    }
  | ({ kind: 'fileChange'; changes?: FileChange[]; status?: ToolStatus } & FileChange)
  | { kind: 'mcpCall'; server: string; tool: string; args?: string; durationMs?: number; ok?: boolean; readOnly?: boolean; output?: string; error?: string; status?: ToolStatus }
  | { kind: 'fileRead'; path: string; lines?: number }
  | { kind: 'search'; query: string; results: Source[] }
  | { kind: 'plan'; steps: PlanStep[]; turnId?: string }
  | { kind: 'subAgent'; name: string; output?: string; status: 'running' | 'done' | 'failed' | 'denied' | 'cancelled' }
  | { kind: 'denied'; what: string; reason?: string }
  | { kind: 'error'; message: string }
  | { kind: 'compaction'; before?: number; after?: number; trigger?: string }
  /**
   * A turn boundary, carrying its clock.
   *
   * THE HEADER NEEDS ELAPSED TIME, NOT SUMMED STEP TIME. The old surface added
   * up each step's wall time and called it "Worked for 44s" while Codex's own
   * window read "Working for 4m 19s" — the steps only account for the seconds
   * the agent spent in a subprocess, not the minutes it spent thinking between
   * them. `startedAt` lets the surface run a live clock; `durationMs` is what
   * the agent reported once the turn ended.
   */
  | { kind: 'turnStart'; startedAt: number }
  | { kind: 'turnEnd'; durationMs?: number; outcome?: TurnOutcome }
  | { kind: 'unknown'; raw: string }

export type BlockKind = Block['kind']

const KNOWN: ReadonlySet<string> = new Set<BlockKind>([
  'attachment',
  'message', 'reasoning', 'command', 'fileChange', 'mcpCall', 'fileRead',
  'search', 'plan', 'subAgent', 'denied', 'error', 'compaction',
  'turnStart', 'turnEnd', 'unknown',
])

/**
 * Coerce anything into a Block. The one place the open rule is enforced.
 *
 * Deliberately shallow: it validates the DISCRIMINANT, not every member. A
 * reader that emits a malformed known block is our bug and should surface as a
 * broken row we can see, whereas an unknown kind is an expected future and must
 * degrade quietly. Validating deeply here would turn the first into the second
 * and hide it.
 */
export function asBlock(value: unknown): Block {
  if (!value || typeof value !== 'object') {
    return { kind: 'unknown', raw: safeStringify(value) }
  }
  const kind = (value as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !KNOWN.has(kind)) {
    return { kind: 'unknown', raw: safeStringify(value) }
  }
  return value as Block
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

/** Everything a turn's header needs. Derived, never stored twice. */
export interface TurnMeta {
  status: 'running' | 'done' | 'failed' | 'denied' | 'cancelled'
  durationMs?: number
  /** Epoch ms the turn began, so a running header can count. */
  startedAt?: number
  /** Work blocks in the turn. Messages are not steps. */
  steps: number
  files: number
  added: number
  removed: number
  plan?: { done: number; total: number }
}

/** One exchange: what was asked, what was done, what came back. */
export interface Turn {
  /** The user's message, when this slice of transcript contains one. */
  prompt?: Extract<Block, { kind: 'message' }>
  /** Everything between the prompt and the reply, in order. */
  work: Block[]
  /** The assistant's message, absent while the turn is still running. */
  reply?: Extract<Block, { kind: 'message' }>
  meta: TurnMeta
}

const isMessage = (b: Block): b is Extract<Block, { kind: 'message' }> => b.kind === 'message'

/**
 * Counts for ONE turn.
 *
 * Per turn, never per panel. A panel-level progress strip was the first design
 * and it was wrong twice over: it described a single turn while floating above
 * all of them, and once you scroll up it reports something off-screen. In a
 * three-turn thread "4 steps" does not say which.
 */
export function turnMetaOf(work: Block[], durationMs?: number): TurnMeta {
  let files = 0, added = 0, removed = 0, steps = 0
  let running = false, failed = false, cancelled = false, denied = false
  let outcome: TurnOutcome | undefined
  let plan: TurnMeta['plan']
  let startedAt: number | undefined
  let reported: number | undefined

  for (const b of work) {
    if (isMessage(b) || b.kind === 'attachment') continue // submitted context is not agent work
    // The clock markers bound the turn; they are not work the user did.
    if (b.kind === 'turnStart') { startedAt = b.startedAt; continue }
    if (b.kind === 'turnEnd') { reported = b.durationMs; outcome = b.outcome; continue }
    steps++
    switch (b.kind) {
      case 'fileChange':
        for (const c of b.changes ?? [b]) { files++; added += c.added; removed += c.removed }
        break
      case 'mcpCall':
        if (b.status === 'running') running = true
        if (b.status === 'failed' || b.status === undefined && b.ok === false) failed = true
        if (b.status === 'cancelled') cancelled = true
        if (b.status === 'denied') denied = true
        break
      case 'command':
        if (b.status === 'running') running = true
        if (b.status === 'failed') failed = true
        if (b.status === 'cancelled') cancelled = true
        if (b.status === 'denied') denied = true
        break
      case 'subAgent':
        if (b.status === 'running') running = true
        if (b.status === 'failed') failed = true
        if (b.status === 'cancelled') cancelled = true
        if (b.status === 'denied') denied = true
        break
      case 'reasoning':
        if (b.streaming) running = true
        break
      case 'error':
        failed = true
        break
      case 'plan':
        // NEWEST WINS. A plan is republished in full on every update, so the
        // last one in the turn is the current one; summing them would count
        // the same step several times over.
        plan = { done: b.steps.filter((s) => s.status === 'done').length, total: b.steps.length }
        break
      default:
        break
    }
  }

  // Running beats failed: a turn that hit an error and kept going is still
  // working, and calling it failed would settle a card that is still moving.
  const status: TurnMeta['status'] = outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : outcome === 'completed' ? 'done' : running ? 'running' : failed ? 'failed' : cancelled ? 'cancelled' : denied ? 'denied' : 'done'
  // The turn's own reported wall time wins over anything the caller guessed.
  const ms = reported ?? durationMs
  return {
    status,
    ...(ms !== undefined ? { durationMs: ms } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    steps, files, added, removed, ...(plan ? { plan } : {}),
  }
}

/**
 * Split a flat block stream into turns.
 *
 * A turn opens at a user message and closes at the assistant message that
 * answers it. Work in between belongs to that turn and nowhere else, which is
 * what lets an old turn keep its own counts forever while a new one runs.
 */
export function groupIntoTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = []
  let prompt: Extract<Block, { kind: 'message' }> | undefined
  let work: Block[] = []

  const close = (reply?: Extract<Block, { kind: 'message' }>) => {
    // Nothing at all to show — do not manufacture an empty turn.
    if (!prompt && !reply && work.length === 0) return
    turns.push({ ...(prompt ? { prompt } : {}), work, ...(reply ? { reply } : {}), meta: turnMetaOf(work) })
    prompt = undefined
    work = []
  }

  for (const b of blocks) {
    if (isMessage(b) && b.role === 'user') {
      // A new question ends whatever came before, answered or not — an
      // unanswered turn is a real state (interrupted, or still thinking when
      // the user typed again) and must keep its own work rather than donating
      // it to the next turn.
      if (prompt || !work.every(b => b.kind === 'turnStart')) close()
      prompt = b
      continue
    }
    if (isMessage(b) && b.role === 'assistant') {
      close(b)
      continue
    }
    work.push(b)
  }
  close()
  return turns
}
