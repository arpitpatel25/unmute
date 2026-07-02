// Unmute Remote — warm routing classifier (DECIDED architecture).
//
// One WARM, tool-less Claude Code REPL session on the user's subscription whose
// ONLY job is to decide, per utterance: is this a NEW task, or a follow-up to an
// existing one — and if so, which. It also cleans the raw transcript in the same
// turn (folds in intent-cleanup), so we don't pay a separate managed-LLM call.
//
// Why a session and not a one-off model call: classification needs intelligence
// (vague utterances, "apply it to the most recent one"), and the user's flat
// subscription is the only zero-incremental-cost place to get it. RESIDENT from
// app startup (warm()) so there's never a per-utterance cold start; kept lean by
// a post-decision /clear and recycled periodically; killed only on app shutdown.
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
import { SURFACES, normalizeSurface } from './surface'
import type { AgentExecutor, ExecutorFactory } from './executor'

const log = createLogger('router')

/** A task the router may route a follow-up into (Unmute supplies this snapshot). */
export interface RoutableTask {
  id: string
  intent: string
  /** short display name (what the user calls it) — a strong match signal. */
  name?: string | null
  state: string
  /** 'session' = persistent working session (multi-day, often project-bound) —
   *  the likelier target of "keep going / now do X" follow-ups. 'oneoff' =
   *  quick fire-and-forget errand. */
  kind?: 'oneoff' | 'session'
  /** project directory name for project-bound sessions ("unmute-cloud") — what
   *  people SAY when addressing them. */
  project?: string | null
  category?: string | null
  ageSec: number
  /** the task currently expanded/surfaced in the overlay — a strong prior. */
  surfaced?: boolean
  /** the task is BLOCKED on a question to the user (state needs-user). */
  awaiting?: boolean
  /** the pending question text, when awaiting — so the router can judge whether
   *  this utterance answers it. */
  question?: string | null
}

/** A known project a NEW session can be bound to (curated by projects.ts). */
export interface RoutableProject {
  name: string
  path: string
}

export interface RouteDecision {
  action: 'new' | 'continue'
  targetTaskId?: string
  /** cleaned intent (router folds in transcript cleanup). */
  intent: string
  /** the app/tool surface this task operates on (e.g. gmail, google-sheets), or
   *  undefined when none applies — caller falls back to detectSurface. */
  surface?: string
  /** managed = short dictated task; raw = open-ended session where injected
   *  memory hints would pollute long reasoning. Default: managed. */
  mode?: 'managed' | 'raw'
  /** Species for a NEW task: 'session' (persistent working session — never
   *  idle-killed/purged) vs 'oneoff' (today's errand). Omitted → oneoff. */
  kind?: 'oneoff' | 'session'
  /** Project directory to bind a NEW session to — ONLY ever one of the known
   *  project paths offered in the prompt (validated at parse; anything else is
   *  dropped). The task then runs IN that directory. */
  dir?: string
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────

/** Humanize an age for the prompt — "260000s ago" is noise for a 3-day session. */
export function fmtAge(ageSec: number): string {
  if (ageSec < 90) return `${ageSec}s ago`
  if (ageSec < 90 * 60) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 36 * 3600) return `${Math.round(ageSec / 3600)}h ago`
  return `${Math.round(ageSec / 86400)}d ago`
}

/** The instruction we type into the warm REPL each call. Self-contained: the
 *  router relies on THIS snapshot, not on accumulated memory (keeps it thin). */
export function buildRoutingPrompt(utterance: string, tasks: RoutableTask[], decisionPath: string, projects: RoutableProject[] = []): string {
  const lines = tasks.map((t) =>
    `  [${t.id}]${t.name ? ` "${t.name}" —` : ''} "${t.intent}" — ${t.state}` +
    `${t.kind === 'session' ? ' · PERSISTENT SESSION' : ''}${t.project ? ` · project: ${t.project}` : ''}` +
    `${t.category ? ` · ${t.category}` : ''} · ${fmtAge(t.ageSec)}${t.surfaced ? ' · ON SCREEN' : ''}` +
    (t.awaiting ? ` · ⏳ BLOCKED — awaiting your answer to: "${t.question || ''}"` : ''),
  )
  const projectLines = projects.map((p) => `  ${p.name} → ${p.path}`)
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
    `A task marked "⏳ BLOCKED — awaiting your answer" stopped to ask the user`,
    `something and is waiting. If this command is plausibly the ANSWER to that`,
    `question (it supplies what was asked, even loosely), CONTINUE that task — the`,
    `answer is piped straight back into it. Only choose otherwise if the command`,
    `clearly ignores the question and starts something unrelated.`,
    ``,
    `Lean CONTINUE when the command DEPENDS on an existing task to make sense: it`,
    `refers back to it (a pronoun or a relative phrase), leaves the subject implied,`,
    `or reads as the natural next step of something already open. People speak`,
    `tersely to a task in progress and don't repeat context they just gave — so a`,
    `short or context-light command is frequently a follow-up, NOT a new request.`,
    `Topical continuity counts on its own: if the command digs deeper into, asks`,
    `more about, or builds on the SAME specific subject as a recent open task,`,
    `CONTINUE it even when the command is fully formed and never refers back`,
    `explicitly — people keep probing the same thread in complete sentences.`,
    `Match on the shared subject/entity and on recency; when the command is terse,`,
    `the ON SCREEN task is the most likely target. A brand-new session would NOT`,
    `know the missing context — so if the command only makes sense given an open`,
    `task, route it there.`,
    ``,
    `Choose NEW when the command opens a DIFFERENT subject from every open task, or`,
    `when no open task plausibly relates to it. A command can be self-contained and`,
    `still be a continuation — so do not start a parallel session merely because the`,
    `sentence could stand alone; if it stays on the same specific thread, CONTINUE.`,
    `But guard the other way just as hard: sharing only a BROAD area (both about git,`,
    `both about email) is NOT the same task — the subject AND goal must match a`,
    `SPECIFIC open task, not just fall in the same general domain. When the command`,
    `pursues its own distinct goal, or relates only loosely or coincidentally to an`,
    `open task, choose NEW. Do NOT collapse every command onto an existing task —`,
    `when nothing clearly matches, NEW is correct. Equally, don't pick NEW out of`,
    `caution when there is a real dependency or a clear same-thread continuation.`,
    ``,
    `Weigh the task metadata: a task named like what the user SAID (its "name" or`,
    `project) is a strong continue-target. A PERSISTENT SESSION is a long-lived`,
    `working thread — the natural home of "keep going", "now do X there", and any`,
    `command about ITS project; prefer it over an old one-off errand on the same`,
    `topic. Recency matters most among one-offs (people rarely return to an errand`,
    `from hours ago) and least for persistent sessions (returning after hours or`,
    `days is normal for them).`,
    ...(projectLines.length ? [
      ``,
      `Known project directories (name → path). If the command asks to work in/on one`,
      `of THESE — start a session there, fix/build something in that repo — and no`,
      `open task already covers it, choose NEW with "dir" set to that EXACT path`,
      `(copy it verbatim; never invent or modify a path, never use one not listed):`,
      ...projectLines,
    ] : []),
    ``,
    `Also clean the command into one natural line (fix transcription slips, keep the`,
    `exact meaning).`,
    ``,
    `Write exactly: {"action":"new"|"continue","targetTaskId":"<id when continue>","intent":"<cleaned one-line command>","surface":"<app/tool or omit>","mode":"managed"|"raw","kind":"oneoff"|"session","dir":"<known project path or omit>"}`,
    `surface: the app/tool the task operates on. Use EXACTLY one of these canonical labels (never invent a new one): ${SURFACES.join(', ')}. Omit if none applies. (e.g. a tweet/X task = "x"; a Mac app/system task = "macos"; streaming on Hotstar = "jiohotstar".)`,
    `mode: use "raw" for "open me a session to work in" / open-ended coding where injected memory hints would pollute long reasoning; use "managed" for short, surface-operating dictated tasks. If ambiguous, choose "raw".`,
    `kind (only for action "new"): "session" for a working session the user will keep coming back to — coding, a project (anything with "dir"), open-ended "work on X" — it stays alive until they end it. "oneoff" for a quick errand they fire and forget (open/check/find something). If ambiguous, "oneoff".`,
  ].join('\n')
}

/** The default decision when the router gives us nothing usable (timeout, bad
 *  parse, unknown id). A follow-up is far likelier than a coincidental brand-new
 *  request when exactly ONE recent task is open — so continue it rather than
 *  start blind and lose its context (the cold-timeout bug). Anything ambiguous
 *  (0 or 2+ tasks, or a stale lone task) stays NEW. */
export function failsafeDecision(tasks: RoutableTask[], intent: string, maxAgeSec = 180): RouteDecision {
  const clean = (intent || '').trim()
  if (tasks.length === 1 && tasks[0].ageSec <= maxAgeSec) {
    return { action: 'continue', targetTaskId: tasks[0].id, intent: clean, mode: 'managed' }
  }
  return { action: 'new', intent: clean, mode: 'managed' }
}

/** Parse the decision file. EXPLICIT router decisions (new, or continue→known id)
 *  are honored. Everything else — null/malformed/unknown-action/unknown-id —
 *  routes through failsafeDecision (continue-latest-if-single). */
export function parseDecision(raw: string | null, fallbackIntent: string, tasks: RoutableTask[], projects: RoutableProject[] = []): RouteDecision {
  const validIds = new Set(tasks.map((t) => t.id))
  if (!raw) return failsafeDecision(tasks, fallbackIntent)
  let obj: { action?: string; targetTaskId?: string; intent?: string; surface?: string; mode?: string; kind?: string; dir?: string }
  try { obj = JSON.parse(raw) } catch { return failsafeDecision(tasks, fallbackIntent) }
  const intent = (obj.intent && obj.intent.trim()) || fallbackIntent
  const mode = obj.mode === 'raw' ? 'raw' : 'managed'
  // Pin to the canonical vocabulary: an off-list / invented surface (the LM
  // emitted "jiohotstar", "x", etc. freely) becomes undefined, and the caller
  // falls back to the deterministic detectSurface — so the store can't fragment.
  const surface = normalizeSurface(obj.surface)
  if (obj.action === 'continue' && obj.targetTaskId && validIds.has(obj.targetTaskId)) {
    return { action: 'continue', targetTaskId: obj.targetTaskId, intent, mode, surface }
  }
  if (obj.action === 'new') {
    // dir is honored ONLY when it's one of the paths we offered — an invented
    // or modified path must never become a spawn cwd (dispatch would fall back
    // to scratch anyway, but the guard belongs at the trust boundary).
    const dir = obj.dir && projects.some((p) => p.path === obj.dir) ? obj.dir : undefined
    // A project-bound task is inherently a working session, whatever the model
    // labeled it — dir implies kind.
    const kind = obj.kind === 'session' || dir ? 'session' as const : 'oneoff' as const
    return { action: 'new', intent, mode, surface, kind, dir }
  }
  return failsafeDecision(tasks, intent)
}

// ─── The warm session ─────────────────────────────────────────────

export interface RouterOpts {
  /** Builds the tool-less classifier session (a minimal claude REPL). */
  executorFactory: ExecutorFactory
  baseDir?: string
  /** Per-call wait for the decision file (default 60s — cloud inference + a
   *  tool-driven file write can be slow; we are diagnosing the true latency). */
  decisionTimeoutMs?: number
  /** ms to let the REPL boot before the first prompt. */
  readyGraceMs?: number
  /** ms to wait after typing the multi-line prompt before sending an explicit
   *  confirm Enter. Claude's TUI captures a multi-line write as a paste that
   *  lands one Enter short of submitting (same quirk the task dispatch path
   *  confirm-Enters for). Without this the prompt sits unsubmitted as a paste. */
  submitConfirmMs?: number
  pollMs?: number
  /** Recycle (full respawn) the resident session after this many decisions. */
  recycleEvery?: number
  /** Recycle the resident session once it is older than this (ms). */
  maxSessionMs?: number
  now?: () => number
}

export class Router {
  private ex: AgentExecutor | null = null
  private chain: Promise<unknown> = Promise.resolve() // single-flight serializer
  private decisionCount = 0
  private spawnedAt = 0
  private readonly dir: string
  private readonly decisionPath: string
  private readonly o: Required<Omit<RouterOpts, 'now'>> & Pick<RouterOpts, 'now'>

  constructor(opts: RouterOpts) {
    this.o = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      decisionTimeoutMs: opts.decisionTimeoutMs ?? 60000,
      readyGraceMs: opts.readyGraceMs ?? 1500,
      submitConfirmMs: opts.submitConfirmMs ?? 450,
      pollMs: opts.pollMs ?? 150,
      recycleEvery: opts.recycleEvery ?? 50,
      maxSessionMs: opts.maxSessionMs ?? 2 * 60 * 60_000,
      now: opts.now,
    }
    this.dir = join(this.o.baseDir, 'router')
    this.decisionPath = join(this.dir, 'decision.json')
  }

  /** Classify one utterance against the current task snapshot. Single-flighted;
   *  always resolves (fail-safe to a new task). */
  route(utterance: string, tasks: RoutableTask[], projects: RoutableProject[] = []): Promise<RouteDecision> {
    const run = this.chain.then(() => this.routeOnce(utterance, tasks, projects))
    // After the decision resolves to the caller, keep the chain alive with
    // housekeeping (/clear + maybe-recycle) — off the hot path, but serialized
    // so it can never overlap the next route.
    this.chain = run.then(() => this.housekeep(), () => this.housekeep())
    return run
  }

  /** Bring the session up (or respawn it if it died) BEFORE it is needed, so a
   *  real utterance never pays cold-start. Idempotent and single-flighted: safe
   *  to call at app init and again on every Remote key-down. */
  warm(): Promise<void> {
    const run = this.chain.then(() => this.ensureSession())
    this.chain = run.catch(() => undefined)
    return run
  }

  private async routeOnce(utterance: string, tasks: RoutableTask[], projects: RoutableProject[] = []): Promise<RouteDecision> {
    const fallback = (utterance || '').trim()
    try {
      await this.ensureSession()
      await fs.mkdir(this.dir, { recursive: true })
      await fs.rm(this.decisionPath, { force: true }).catch(() => {})
      const prompt = buildRoutingPrompt(utterance, tasks, this.decisionPath, projects)
      this.ex!.writeStdin(prompt)
      // The multi-line prompt is captured by Claude's TUI as a paste that lands
      // one Enter short of submitting — so it sits as "[Pasted text]" and the
      // model never runs. Mirror the task dispatch path: settle, then send an
      // explicit confirm Enter to actually submit it. (Proven on the task lane.)
      await this.sleep(this.o.submitConfirmMs)
      if (this.ex?.alive) { this.ex.write('\r'); log.event('router-submit-confirm', { afterMs: this.o.submitConfirmMs }) }
      const raw = await this.waitForDecision()
      const decision = parseDecision(raw, fallback, tasks, projects)
      // TEMP(memory-debug)
      log.event('route-decision', { action: decision.action, targetTaskId: decision.targetTaskId ?? null, tasks: tasks.length, surface: decision.surface ?? null, mode: decision.mode ?? null, kind: decision.kind ?? null, dir: decision.dir ?? null, MEMORY_DEBUG: true })
      return decision
    } catch (e) {
      log.warn('route failed — using failsafe', { error: (e as Error).message })
      return failsafeDecision(tasks, fallback)
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ex?.alive) return
    log.event('router-spawn', {})
    this.ex = await this.spawnSession()
    this.spawnedAt = this.clock()
    this.decisionCount = 0
  }

  /** Spawn + ready a new executor (shared by ensureSession and recycle). */
  private async spawnSession(): Promise<AgentExecutor> {
    const ex = this.o.executorFactory()
    // DIAGNOSTIC: mirror the router REPL's own output into our logs. The router
    // executor (unlike task executors) was never subscribed, so we were blind to
    // what the model actually says/does with the routing prompt. Strip ANSI +
    // OSC sequences, collapse whitespace, and log any non-empty text so we can
    // SEE whether it writes the file, prints JSON to chat, stalls on a prompt, etc.
    ex.onData((chunk) => {
      // Log a compact view of whatever the router REPL emits. The logger
      // JSON-escapes control bytes, so ANSI shows as \u001b... — readable
      // enough to see if the model writes the file, prints JSON to chat, or
      // stalls. Skip pure cursor/redraw noise (chunks with no letters).
      const text = chunk.replace(/\s+/g, ' ').trim()
      if (/[A-Za-z0-9{}"]/.test(text)) log.event('router-output', { text: text.slice(0, 500) })
    })
    await ex.spawn({ cwd: this.dir, env: process.env, taskId: 'router' })
    await fs.mkdir(this.dir, { recursive: true }).catch(() => {})
    await ex.isReady()
    ex.writeStdin('') // accept any folder-trust prompt
    await this.sleep(this.o.readyGraceMs)
    return ex
  }

  /** Runs in the idle gap AFTER a decision (chained, never on the hot path):
   *  wipe the conversation context so the resident session stays lean (routing
   *  is stateless — the full snapshot is supplied every turn), and periodically
   *  recycle the whole process to cap long-run drift. */
  private async housekeep(): Promise<void> {
    this.decisionCount++
    if (this.ex?.alive) {
      try { this.ex.writeStdin('/clear') } catch { /* best-effort */ }
    }
    const aged = this.spawnedAt > 0 && this.clock() - this.spawnedAt > this.o.maxSessionMs
    if (this.decisionCount >= this.o.recycleEvery || aged) {
      await this.recycle().catch(() => {})
    }
  }

  /** Proactive full respawn: bring a fresh session up, then kill the old one and
   *  swap. Done in idle time so a real decision never pays cold-start. */
  private async recycle(): Promise<void> {
    log.event('router-recycle', { decisions: this.decisionCount })
    const fresh = await this.spawnSession()
    const old = this.ex
    this.ex = fresh
    this.spawnedAt = this.clock()
    this.decisionCount = 0
    if (old?.alive) { try { old.kill() } catch { /* best-effort */ } }
  }

  /** Test hook: await any trailing housekeeping queued on the chain. */
  settleHousekeeping(): Promise<void> { return this.chain.then(() => undefined, () => undefined) }

  private async waitForDecision(): Promise<string | null> {
    const start = this.clock()
    const deadline = start + this.o.decisionTimeoutMs
    let lastBeat = 0
    while (this.clock() < deadline) {
      try {
        const raw = await fs.readFile(this.decisionPath, 'utf8')
        if (raw.trim()) {
          log.event('router-decision-file-read', { afterMs: this.clock() - start, raw: raw.slice(0, 500) })
          return raw
        }
      } catch { /* not written yet */ }
      // DIAGNOSTIC heartbeat: prove we are still polling and show elapsed, so a
      // slow-but-eventual write is distinguishable from a never-write.
      const elapsed = this.clock() - start
      if (elapsed - lastBeat >= 5000) { lastBeat = elapsed; log.event('router-waiting', { elapsedMs: elapsed, decisionPath: this.decisionPath }) }
      await this.sleep(this.o.pollMs)
    }
    log.warn('router decision timed out', { ms: this.o.decisionTimeoutMs })
    return null
  }

  /** Kill the resident session (app shutdown). */
  dispose(): void {
    if (this.ex?.alive) { try { this.ex.kill() } catch { /* best-effort */ } }
    this.ex = null
  }

  private clock(): number { return this.o.now ? this.o.now() : Date.now() }
  // NOT unref'd — these drive an in-flight route; unref'ing would let the loop
  // drain mid-route and stall the decision. (Only the idle timer is unref'd.)
  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
}
