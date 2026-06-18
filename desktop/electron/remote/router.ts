// Unmute Remote — warm routing classifier (DECIDED architecture).
//
// One WARM, tool-less Claude Code REPL session on the user's subscription whose
// ONLY job is to decide, per utterance: is this a NEW task, or a follow-up to an
// existing one — and if so, which. It also cleans the raw transcript in the same
// turn (folds in intent-cleanup), so we don't pay a separate managed-LLM call.
//
// Why a session and not a one-off model call: classification needs intelligence
// (vague utterances, "apply it to the most recent one"), and the user's flat
// subscription is the only zero-incremental-cost place to get it. Kept WARM so
// there's no per-utterance cold start; killed after idle.
//
// Topology (star, Unmute = hub): Unmute composes a fresh snapshot from its own
// task map and hands it here; the router writes a decision FILE (the REPL's TUI
// stream is too messy to parse from stdout — same reason executors use a status
// file); Unmute reads it. The router NEVER talks to task sessions directly.
//
// Safety: every failure path (no session, timeout, bad parse, unknown id) returns
// action:'new' with the raw transcript — routing can never block or mis-inject.

import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { createLogger } from './log'
import type { AgentExecutor, ExecutorFactory } from './executor'

const log = createLogger('router')

/** A task the router may route a follow-up into (Unmute supplies this snapshot). */
export interface RoutableTask {
  id: string
  intent: string
  state: string
  category?: string | null
  ageSec: number
  /** the task currently expanded/surfaced in the overlay — a strong prior. */
  surfaced?: boolean
}

export interface RouteDecision {
  action: 'new' | 'continue'
  targetTaskId?: string
  /** cleaned intent (router folds in transcript cleanup). */
  intent: string
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────

/** The instruction we type into the warm REPL each call. Self-contained: the
 *  router relies on THIS snapshot, not on accumulated memory (keeps it thin). */
export function buildRoutingPrompt(utterance: string, tasks: RoutableTask[], decisionPath: string): string {
  const lines = tasks.map((t) =>
    `  [${t.id}] "${t.intent}" — ${t.state}${t.category ? ` · ${t.category}` : ''} · ${t.ageSec}s ago${t.surfaced ? ' · ON SCREEN' : ''}`,
  )
  return [
    `[Unmute router] You route a spoken command to where it belongs. Reply ONLY by writing JSON to ${decisionPath} (atomically: write ${decisionPath}.tmp then rename). Do nothing else — no tools, no browser, no research.`,
    ``,
    `Spoken command: "${utterance}"`,
    ``,
    `Open tasks you could continue — each is a SEPARATE live session that already`,
    `holds its own context (most recent first):`,
    ...(lines.length ? lines : ['  (none)']),
    ``,
    `Decide: does this command START a new task, or CONTINUE one of the open ones?`,
    `Reason about it genuinely — this is a judgement, not a default.`,
    ``,
    `Lean CONTINUE when the command DEPENDS on an existing task to make sense: it`,
    `refers back to it (a pronoun or a relative phrase), leaves the subject implied,`,
    `or reads as the natural next step of something already open. People speak`,
    `tersely to a task in progress and don't repeat context they just gave — so a`,
    `short or context-light command is frequently a follow-up, NOT a new request.`,
    `Match on the shared subject/entity and on recency; when the command is terse,`,
    `the ON SCREEN task is the most likely target. A brand-new session would NOT`,
    `know the missing context — so if the command only makes sense given an open`,
    `task, route it there.`,
    ``,
    `Choose NEW only when the command fully stands on its own (it specifies its own`,
    `goal without needing prior context) or when no open task plausibly relates to`,
    `it. Do not pick "new" out of caution when there is a real dependency, and do`,
    `not force a "continue" onto a self-contained command.`,
    ``,
    `Also clean the command into one natural line (fix transcription slips, keep the`,
    `exact meaning).`,
    ``,
    `Write exactly: {"action":"new"|"continue","targetTaskId":"<id when continue>","intent":"<cleaned one-line command>"}`,
  ].join('\n')
}

/** Parse the decision file. Fail-safe: anything malformed/unknown ⇒ new task. */
export function parseDecision(raw: string | null, fallbackIntent: string, validIds: Set<string>): RouteDecision {
  const safe = (intent?: string): RouteDecision => ({ action: 'new', intent: (intent || fallbackIntent).trim() || fallbackIntent })
  if (!raw) return safe()
  let obj: { action?: string; targetTaskId?: string; intent?: string }
  try { obj = JSON.parse(raw) } catch { return safe() }
  const intent = (obj.intent && obj.intent.trim()) || fallbackIntent
  if (obj.action === 'continue' && obj.targetTaskId && validIds.has(obj.targetTaskId)) {
    return { action: 'continue', targetTaskId: obj.targetTaskId, intent }
  }
  return { action: 'new', intent }
}

// ─── The warm session ─────────────────────────────────────────────

export interface RouterOpts {
  /** Builds the tool-less classifier session (a minimal claude REPL). */
  executorFactory: ExecutorFactory
  baseDir?: string
  /** Kill the warm session after this idle (default 5 min). */
  idleMs?: number
  /** Per-call wait for the decision file (default 8s). */
  decisionTimeoutMs?: number
  /** ms to let the REPL boot before the first prompt. */
  readyGraceMs?: number
  pollMs?: number
  now?: () => number
}

export class Router {
  private ex: AgentExecutor | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<unknown> = Promise.resolve() // single-flight serializer
  private readonly dir: string
  private readonly decisionPath: string
  private readonly o: Required<Omit<RouterOpts, 'now'>> & Pick<RouterOpts, 'now'>

  constructor(opts: RouterOpts) {
    this.o = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      idleMs: opts.idleMs ?? 5 * 60_000,
      decisionTimeoutMs: opts.decisionTimeoutMs ?? 8000,
      readyGraceMs: opts.readyGraceMs ?? 1500,
      pollMs: opts.pollMs ?? 150,
      now: opts.now,
    }
    this.dir = join(this.o.baseDir, 'router')
    this.decisionPath = join(this.dir, 'decision.json')
  }

  /** Classify one utterance against the current task snapshot. Single-flighted;
   *  always resolves (fail-safe to a new task). */
  route(utterance: string, tasks: RoutableTask[]): Promise<RouteDecision> {
    const run = this.chain.then(() => this.routeOnce(utterance, tasks))
    // keep the chain alive regardless of this call's outcome
    this.chain = run.catch(() => undefined)
    return run
  }

  private async routeOnce(utterance: string, tasks: RoutableTask[]): Promise<RouteDecision> {
    const validIds = new Set(tasks.map((t) => t.id))
    const fallback = (utterance || '').trim()
    try {
      await this.ensureSession()
      await fs.mkdir(this.dir, { recursive: true })
      await fs.rm(this.decisionPath, { force: true }).catch(() => {})
      const prompt = buildRoutingPrompt(utterance, tasks, this.decisionPath)
      this.ex!.writeStdin(prompt)
      const raw = await this.waitForDecision()
      const decision = parseDecision(raw, fallback, validIds)
      log.event('route-decision', { action: decision.action, targetTaskId: decision.targetTaskId ?? null, tasks: tasks.length })
      this.touchIdle()
      return decision
    } catch (e) {
      log.warn('route failed — defaulting to new task', { error: (e as Error).message })
      this.touchIdle()
      return { action: 'new', intent: fallback }
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ex?.alive) return
    log.event('router-spawn', {})
    const ex = this.o.executorFactory()
    this.ex = ex
    await ex.spawn({ cwd: this.dir, env: process.env, taskId: 'router' })
    await fs.mkdir(this.dir, { recursive: true }).catch(() => {})
    await ex.isReady()
    ex.writeStdin('') // accept any folder-trust prompt
    await this.sleep(this.o.readyGraceMs)
  }

  private async waitForDecision(): Promise<string | null> {
    const deadline = this.clock() + this.o.decisionTimeoutMs
    while (this.clock() < deadline) {
      try {
        const raw = await fs.readFile(this.decisionPath, 'utf8')
        if (raw.trim()) return raw
      } catch { /* not written yet */ }
      await this.sleep(this.o.pollMs)
    }
    log.warn('router decision timed out', { ms: this.o.decisionTimeoutMs })
    return null
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      log.event('router-idle-kill', { idleMs: this.o.idleMs })
      this.dispose()
    }, this.o.idleMs)
    this.idleTimer.unref?.()
  }

  /** Kill the warm session (idle, or app shutdown). */
  dispose(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.ex?.alive) { try { this.ex.kill() } catch { /* best-effort */ } }
    this.ex = null
  }

  private clock(): number { return this.o.now ? this.o.now() : Date.now() }
  // NOT unref'd — these drive an in-flight route; unref'ing would let the loop
  // drain mid-route and stall the decision. (Only the idle timer is unref'd.)
  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
}
