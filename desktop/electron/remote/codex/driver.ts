// Unmute Remote — the Codex desktop driver.
//
// This is the second TASK BACKEND. The Claude adapter owns a PTY and reads a
// status file the agent writes; Codex desktop has no PTY, no stdin, no status
// file and no contract we can install — so the shape is different:
//
//   WRITE  → CDP against the running app (cdp.ts). The app the user taps into
//            is the only writer, so what Unmute sends is always what they see.
//   READ   → the rollout JSONL on disk (rollout.ts). Free, renderer-safe,
//            works while Codex is closed.
//   STATE  → polled from that same file, exactly like the status-file poll in
//            task-manager.ts. No hook, no second protocol.
//
// Availability is a first-class concept here. CDP only exists if Codex was
// launched with --remote-debugging-port, so a user who opens Codex from the
// Dock has a live app and a DEAD write channel. Every write therefore checks
// armed-ness and returns a typed reason the UI can act on ("Reconnect Codex")
// rather than throwing an opaque error. Reads never depend on arming.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { createLogger } from '../log'
import { getAxBridge } from '../ax/ax-bridge'
import { CodexCdp, isArmed, listProjects, listThreads, bareThreadId, isTransientThreadId, type CodexProject, readApprovalLabel, readApprovalMenu, selectApprovalLevel, currentConversationId, clickThreadRow, resetSidebarScroll, expandNextSidebarGroup, clickNextSidebarShowMore, advanceSidebarScroll, readReasoning, readReasoningLabel, setReasoning, readPendingConsent, answerConsent, readThreadChips, type CodexConsent, type CodexThreadChip, type ReasoningState, type ReasoningAxis, type SetReasoningTrace } from './cdp'
import { choosePolicy, levelsFromMenu, levelFromLabel, LEVEL_LABEL, type CodexApprovalLevel, type UnmutePermissionMode } from './approval'
import { readThread, newestThreadIdSince, watchThread, type CodexSnapshot } from './rollout'

const log = createLogger('codex-driver')

/** Deterministic default port for the Codex desktop CDP endpoint. */
export const CODEX_CDP_PORT = 9302
export const CODEX_APP_PATH = '/Applications/ChatGPT.app'
/** The Codex desktop bundle ships the CLI — a desktop-only user still has one. */
export const CODEX_BUNDLED_CLI = `${CODEX_APP_PATH}/Contents/Resources/codex`

export type CodexUnavailableReason = 'not-installed' | 'not-running' | 'not-armed'

export interface CodexAvailability {
  ok: boolean
  reason?: CodexUnavailableReason
  /** Present when ok — the port we are talking to. */
  port?: number
}

export interface CreateTaskResult {
  ok: boolean
  threadId?: string
  /**
   * The id the SIDEBAR is using for this thread, when it differs from the
   * durable one.
   *
   * A not-yet-persisted thread is labelled `local:client-new-thread:<uuid>` in
   * the DOM, and that uuid is unrelated to the durable id — there is no shared
   * field on the row to join them (checked: host-id and kind are both just
   * "local", everything else is title-derived, and titles are user-editable).
   *
   * Creation is the ONE moment the correlation is free and unambiguous: exactly
   * one row appears, and it is ours. Captured here rather than guessed later.
   * Without it, sidebar-based blocked detection cannot identify a thread during
   * its first turn — which is exactly when Computer Use consents fire.
   */
  domThreadId?: string
  reason?: CodexUnavailableReason | 'no-composer' | 'no-project' | 'send-failed' | 'id-unresolved'
}

export interface CodexDriverDeps {
  port?: number
  appPath?: string
  /** Background app launch (never `open -a`, which foregrounds). */
  launchApp?: (opts: { bundleId: string; cdpPort: number }) => Promise<void>
  sessionsDir?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Exact thread navigation. Explicit opens use it directly; submission uses
   * it only after background navigation misses and restores focus afterward. */
  openDeepLink?: (url: string) => Promise<void>
  /** Focus boundaries for the exact-thread delivery fallback. Injectable so
   * tests never move the user's real windows. */
  frontmost?: () => Promise<string | null>
  activate?: (bundleId: string) => Promise<boolean>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function defaultActivate(bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('open', ['-b', bundleId], (error) => resolve(!error))
  })
}

async function defaultFrontmost(): Promise<string | null> {
  try {
    return (await getAxBridge().call('frontmostApp', []))?.bundleId ?? null
  } catch {
    return null
  }
}

export interface SidebarSearchPort {
  resetScroll(): Promise<void>
  clickTarget(): Promise<boolean>
  expandOne(): Promise<boolean>
  clickShowMore(): Promise<boolean>
  advanceScroll(): Promise<boolean>
}

/** Search Codex's virtualized sidebar without activating its native window. */
export async function searchSidebarThread(
  port: SidebarSearchPort,
  sleep: (ms: number) => Promise<void>,
  maxSteps = 80,
): Promise<boolean> {
  await port.resetScroll()
  for (let step = 0; step < maxSteps; step++) {
    if (await port.clickTarget()) return true
    if (await port.expandOne()) { await sleep(160); continue }
    if (await port.clickShowMore()) { await sleep(160); continue }
    if (await port.advanceScroll()) { await sleep(100); continue }
    return false
  }
  return false
}

export function threadNavigationFallback(background: boolean): 'fail' | 'deeplink' {
  return background ? 'fail' : 'deeplink'
}

/**
 * Relaunch Codex with the debug port WITHOUT stealing focus.
 *
 * `open -a` foregrounds the app — during development that flash was visible and
 * is exactly the interruption Unmute promises not to cause. `open -g` launches
 * in the background instead. Arming still requires a quit+relaunch (the flag is
 * only read at process start), so this stays an explicit user-initiated
 * "Connect Codex" action, never something we do mid-utterance.
 */
function defaultLaunchApp(appPath: string): (opts: { bundleId: string; cdpPort: number }) => Promise<void> {
  return ({ cdpPort }) => new Promise<void>((resolve) => {
    execFile('osascript', ['-e', 'tell application "ChatGPT" to quit'], () => {
      setTimeout(() => {
        execFile('open', ['-g', '-a', appPath, '--args', `--remote-debugging-port=${cdpPort}`], () => resolve())
      }, 2500)
    })
  })
}

export class CodexDesktopDriver {
  private cdp: CodexCdp | null = null
  private readonly port: number
  private readonly appPath: string
  private readonly sessionsDir: string | undefined
  private readonly sleep: (ms: number) => Promise<void>
  private readonly openDeepLink: (url: string) => Promise<void>
  private readonly frontmost: () => Promise<string | null>
  private readonly activate: (bundleId: string) => Promise<boolean>
  /** Codex has one visible composer. Serialize exact-thread deliveries so two
   * task replies can never navigate or type across one another. */
  private deliveryChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: CodexDriverDeps = {}) {
    this.port = deps.port ?? CODEX_CDP_PORT
    this.appPath = deps.appPath ?? CODEX_APP_PATH
    this.sessionsDir = deps.sessionsDir
    this.sleep = deps.sleep ?? defaultSleep
    this.openDeepLink = deps.openDeepLink ?? ((url) => new Promise<void>((resolve, reject) => {
      execFile('open', [url], (err) => (err ? reject(err) : resolve()))
    }))
    this.frontmost = deps.frontmost ?? defaultFrontmost
    this.activate = deps.activate ?? defaultActivate
  }

  /** Is the Codex desktop app installed at all? Drives the picker's enabled state. */
  async isInstalled(): Promise<boolean> {
    try { await fs.stat(this.appPath); return true } catch { return false }
  }

  /** Can we WRITE right now? Reads do not need this. */
  async availability(): Promise<CodexAvailability> {
    if (!(await this.isInstalled())) return { ok: false, reason: 'not-installed' }
    if (await isArmed(this.port)) return { ok: true, port: this.port }
    return { ok: false, reason: 'not-armed' }
  }

  /**
   * Bring up a usable CDP session, arming the app if needed. Arming requires a
   * relaunch, which is the ONE unavoidable interruption in this lane — callers
   * should surface it as an explicit "Connect Codex" action rather than doing
   * it silently mid-utterance.
   */
  async connect(opts: { autoArm?: boolean } = {}): Promise<CodexCdp | null> {
    if (this.cdp?.connected) return this.cdp
    if (!(await isArmed(this.port))) {
      if (!opts.autoArm) return null
      const launch = this.deps.launchApp ?? defaultLaunchApp(this.appPath)
      log.event('codex-arming', { port: this.port })
      await launch({ bundleId: 'com.openai.codex', cdpPort: this.port })
      // Give the renderer time to come up; poll rather than sleeping blindly.
      for (let i = 0; i < 30; i++) {
        if (await isArmed(this.port)) break
        await this.sleep(1000)
      }
      if (!(await isArmed(this.port))) { log.warn('codex-arm-failed', { port: this.port }); return null }
    }
    const cdp = new CodexCdp(this.port)
    try { await cdp.connect() } catch (e) {
      log.warn('codex-connect-failed', { error: String((e as Error).message).slice(0, 160) })
      return null
    }
    this.cdp = cdp
    return cdp
  }

  disconnect(): void { this.cdp?.close(); this.cdp = null }

  /** Projects as the sidebar shows them (for the router + the picker). */
  async projects(): Promise<CodexProject[]> {
    const cdp = await this.connect()
    if (!cdp) return []
    return listProjects(cdp)
  }

  /**
   * What approval levels does THIS device offer, and which is selected?
   *
   * The composer's own menu is the authority — not a hardcoded list and not the
   * app-server. A user on a company/managed plan is not offered "Full access" at
   * all, so a fixed maximum would either fail or be silently downgraded.
   */
  async approvalOptions(): Promise<{ available: CodexApprovalLevel[]; current: CodexApprovalLevel | null }> {
    const cdp = await this.connect()
    if (!cdp) return { available: [], current: null }
    const current = levelFromLabel(await readApprovalLabel(cdp))
    const available = levelsFromMenu(await readApprovalMenu(cdp, (ms) => this.sleep(ms)))
    log.event('codex-approval-options', { available, current })
    return { available, current }
  }

  /**
   * Raise the approval level as far as the DEVICE and the USER'S OWN SETTING
   * both allow, before the thread starts.
   *
   * This is the Codex half of what the Claude adapter already does when it
   * passes --dangerously-skip-permissions for an auto-approve user: same
   * intent, same user setting, one behaviour across both backends. It is capped
   * twice on purpose (see approval.ts) and it NEVER escalates past what the
   * composer menu actually lists.
   *
   * Note what this cannot do: on a capped device the ceiling still blocks, so
   * tasks will still stop for approval. That is why the hooks channel exists.
   */
  private async applyApprovalPolicy(cdp: CodexCdp, userMode: UnmutePermissionMode): Promise<void> {
    try {
      const current = levelFromLabel(await readApprovalLabel(cdp))

      // CHEAP PRE-CHECK, and it has to come BEFORE readApprovalMenu.
      //
      // readApprovalMenu OPENS the permissions menu to enumerate levels, and it
      // ran on every dispatch — the `policy.level === current` early-return
      // below fires only AFTER the menu has already been opened. So every Codex
      // task touched a menu before typing, which is the thing that leaves the
      // composer unable to submit. Reading the button's own label costs one
      // evaluate and opens nothing.
      //
      // The ceiling logic is choosePolicy's, mirrored: auto-approve wants
      // full-access, anything else wants approve-for-me. If we are already
      // there, nothing about opening the menu could change the outcome.
      // NEVER DOWNGRADE. A user who has deliberately turned Full Access on —
      // reading the dialog and confirming it — must not have it quietly taken
      // away by a dictated task. We only ever raise, and only as far as
      // choosePolicy allows.
      const ORDER: CodexApprovalLevel[] = ['ask', 'approve-for-me', 'full-access']
      // MUST track choosePolicy's user ceiling. Hardcoding 'approve-for-me'
      // here would early-return before the menu is ever opened, so an
      // auto-approve user would silently stay one level short of what they
      // asked for — the ceiling raise in approval.ts would never be reached.
      const ceiling: CodexApprovalLevel = userMode === 'auto-approve' ? 'full-access' : 'approve-for-me'
      if (current && ORDER.indexOf(current) >= ORDER.indexOf(ceiling)) {
        log.event('codex-approval-unchanged', { level: current, userMode, atOrAbove: ceiling })
        return
      }

      const available = levelsFromMenu(await readApprovalMenu(cdp, (ms) => this.sleep(ms)))
      if (!available.length) { log.warn('codex-approval-menu-empty', {}); return }
      const policy = choosePolicy(available, userMode)
      if (policy.level === current) {
        log.event('codex-approval-unchanged', { level: policy.level, available, userMode })
        return
      }
      const ok = await selectApprovalLevel(cdp, LEVEL_LABEL[policy.level], (ms) => this.sleep(ms))
      log[ok ? 'event' : 'warn']('codex-approval-set', {
        from: current, to: policy.level, available, userMode, canBlock: policy.canBlock, ok,
      })
    } catch (e) {
      // Never fail task creation over this — a task at the user's existing level
      // is far better than no task.
      log.warn('codex-approval-error', { error: (e as Error).message })
    }
  }

  /**
   * What model / effort / speed does THIS device offer, and what is selected?
   *
   * Read live, never hardcoded: "5.6 Terra" will not exist in two releases, and
   * a managed plan may not offer every tier. Same rule the approval levels
   * follow, for the same reason.
   */
  async reasoningOptions(): Promise<ReasoningState> {
    return await this.serialize('read', async () => {
      const cdp = await this.connect()
      if (!cdp) {
        log.warn('codex-reasoning-read', { ok: false, reason: 'no-cdp' })
        return { label: null, current: {}, options: {} }
      }
      const state = await readReasoning(cdp, (ms) => this.sleep(ms))
      log.event('codex-reasoning-read', { label: state.label, current: state.current })
      return state
    })
  }

  /**
   * Set one axis of the reasoning control on the current composer.
   *
   * The returned trace is the whole point: `ok` alone was what let three builds
   * ship with every pick dead. Callers log it verbatim.
   */
  async setReasoningAxis(axis: ReasoningAxis, value: string): Promise<SetReasoningTrace> {
    return await this.serialize('set', async () => {
      const cdp = await this.connect()
      if (!cdp) {
        const t: SetReasoningTrace = { axis, want: value, stage: 'menu-closed', ok: false, ms: 0 }
        log.warn('codex-reasoning-set', { ...t, reason: 'no-cdp' })
        return t
      }
      const trace = await setReasoning(cdp, axis, value, (ms) => this.sleep(ms))
      // A click that changed nothing is a FAILURE, however cleanly it ran.
      log[trace.ok && trace.changed ? 'event' : 'warn']('codex-reasoning-set', { ...trace })
      return trace
    })
  }

  /**
   * One reasoning operation at a time, app-wide.
   *
   * Each pick used to fire a multi-second refresh walk that opens, reads and
   * ESCAPES the same menu the next pick needs. Five clicks in twelve seconds
   * meant pick N+1 opened into pick N's teardown, and the log showed a submenu
   * read of `[]` — nothing was open at all. These operations share one piece of
   * global state (the open menu), so they cannot overlap.
   */
  private reasoningChain: Promise<unknown> = Promise.resolve()
  private async serialize<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now()
    const run = this.reasoningChain.then(async () => {
      const waited = Date.now() - queuedAt
      if (waited > 250) log.info('codex-reasoning-queued', { kind, waitedMs: waited })
      return await fn()
    })
    // Keep the chain alive even when this link rejects, or one thrown error
    // would wedge every later pick.
    this.reasoningChain = run.catch(() => undefined)
    return await run
  }

  /**
   * Apply the user's model choice to the FRESH composer, before the first turn.
   *
   * Restores whatever was selected before, because this control is the
   * composer's sticky default: without the restore, running one unmute task on
   * a cheaper model would silently change what the user's next MANUAL Codex
   * chat runs on. Returns the restore thunk so the caller can run it after the
   * turn is sent.
   */
  private async applyReasoning(
    cdp: CodexCdp, want: { model?: string; effort?: string; speed?: string },
  ): Promise<() => Promise<void>> {
    const wanted: Array<[ReasoningAxis, string | undefined]> =
      [['Model', want.model], ['Effort', want.effort], ['Speed', want.speed]]
    if (!wanted.some(([, v]) => v)) return async () => {}

    // CHEAP PRE-CHECK — do not open a single menu unless something must change.
    //
    // The button already states what is live ("5.6 Sol High"), and reading it is
    // one evaluate. Walking the menus to discover the same thing costs seconds
    // AND leaves the composer unable to submit: a dispatch that opened them
    // typed its intent correctly and then sat there while Enter did nothing
    // (codex-create-send-unconfirmed). Dispatches that never touched a menu sent
    // instantly. Since the pill writes these preferences from the SAME live
    // values it reads, the overwhelmingly common case is that nothing differs.
    const liveLabel = (await readReasoningLabel(cdp)).toLowerCase().replace(/[\s-]+/g, '')
    const satisfied = wanted.every(([, v]) =>
      !v || liveLabel.includes(v.toLowerCase().replace(/[\s-]+/g, '')))
    if (satisfied) {
      log.event('codex-reasoning-already-set', { want, label: liveLabel })
      return async () => {}
    }

    const before = await readReasoning(cdp, (ms) => this.sleep(ms))
    const changed: Array<[ReasoningAxis, string]> = []
    for (const [axis, value] of wanted) {
      if (!value) continue
      const offered = before.options[axis] ?? []
      if (offered.length && !offered.includes(value)) {
        log.warn('codex-reasoning-unavailable', { axis, value, offered })
        continue
      }
      if (before.current[axis] === value) continue
      const trace = await setReasoning(cdp, axis, value, (ms) => this.sleep(ms))
      log[trace.ok && trace.changed ? 'event' : 'warn']('codex-reasoning-dispatch-set', { ...trace })
      if (trace.ok) {
        const prev = before.current[axis]
        if (prev) changed.push([axis, prev])
      }
    }
    log.event('codex-reasoning-applied', { want, restoring: changed.map(([a]) => a) })
    return async () => {
      for (const [axis, prev] of changed) {
        await setReasoning(cdp, axis, prev, (ms) => this.sleep(ms))
      }
    }
  }

  /**
   * Create a task: open a new chat (project-scoped when asked), type the intent,
   * submit. Returns the DURABLE thread id — we deliberately wait past the
   * transient `client-new-thread:` id so the handle we persist is the real one.
   */
  async createTask(
    intent: string,
    opts: {
      project?: string | null
      autoArm?: boolean
      permissionMode?: UnmutePermissionMode
      /** Durable thread ids ALREADY owned by live tasks. A thread being created
       *  now cannot be one of them, so passing them makes it impossible to hand
       *  a newcomer a running thread's id — see newestThreadIdSince. */
      knownThreadIds?: ReadonlySet<string>
      /** Codex's own labels, e.g. "5.6 Luna" / "High" / "Fast". */
      model?: string
      effort?: string
      speed?: string
      attachments?: readonly string[]
    } = {},
  ): Promise<CreateTaskResult> {
    const avail = await this.availability()
    if (!avail.ok && !opts.autoArm) return { ok: false, reason: avail.reason }
    const cdp = await this.connect({ autoArm: opts.autoArm })
    if (!cdp) return { ok: false, reason: avail.reason ?? 'not-armed' }

    // Stamp BEFORE touching the app: the durable thread id is recovered by
    // finding the rollout file created after this instant (see rollout.ts —
    // the DOM never reveals it).
    const startedAt = Date.now() - 2000 // small slack for clock/fs granularity
    const before = new Set((await listThreads(cdp)).map((t) => t.id))
    log.event('codex-create-begin', { project: opts.project ?? null, threadsBefore: before.size })

    // Project-scoped creation. Codex exposes a per-project button, so a task
    // lands INSIDE the project rather than being created then moved.
    let opened = false
    if (opts.project) {
      opened = await cdp.clickAriaLabel(`Start new chat in ${opts.project}`)
      if (!opened) log.warn('codex-project-button-missing', { project: opts.project })
    }
    if (!opened) opened = await cdp.clickAriaLabel('New chat')
    if (!opened) { log.warn('codex-create-no-newchat-button', { project: opts.project ?? null }); return { ok: false, reason: 'no-project' } }
    log.event('codex-create-newchat-clicked', { projectScoped: !!opts.project })
    await this.sleep(700)

    // Set the policy on the FRESH composer — before the first turn, so it holds
    // for the whole thread rather than being changed under a running task.
    if (opts.permissionMode) await this.applyApprovalPolicy(cdp, opts.permissionMode)
    const restoreReasoning = await this.applyReasoning(cdp, opts)

    if (!(await cdp.focusComposer())) { log.warn('codex-create-no-composer', {}); return { ok: false, reason: 'no-composer' } }
    if (opts.attachments?.length && !(await cdp.attachFiles(opts.attachments))) {
      return { ok: false, reason: 'send-failed' }
    }
    await this.sleep(120)
    if (intent) await cdp.typeText(intent)
    await this.sleep(180)
    const typed = await cdp.composerText()
    if (typed !== intent) {
      log.warn('codex-create-text-mismatch', { intentLen: intent.length, typedLen: typed.length })
      return { ok: false, reason: 'send-failed' }
    }
    log.event('codex-create-typed', { chars: typed.length })
    await cdp.pressEnter()

    // Submission is confirmed by the composer emptying — the same observable
    // the manual probe used, and cheaper than watching the timeline.
    let sent = false
    for (let i = 0; i < 20; i++) {
      await this.sleep(200)
      if (!(await cdp.composerText()).trim()) { sent = true; break }
    }

    // FALL BACK TO THE SEND BUTTON.
    //
    // Enter is a key event to whatever holds focus; the button is the app's own
    // submit path and does not care what the page thinks the pointer or focus
    // is doing. A dispatch once typed its whole intent correctly and then died
    // because Enter did nothing after some menus had been opened — the work was
    // done and the task stranded on the last inch.
    if (!sent) {
      log.warn('codex-create-enter-ignored', { retrying: 'send-button' })
      // FOUND BY EXCLUSION, because Codex's send control has no identity of its
      // own: no aria-label, no data-app-action-id, no data-testid. The composer
      // chrome holds exactly three buttons — the reasoning picker (which carries
      // data-composer-navigation-target), "Dictate" (aria-label), and the submit
      // arrow, which is the one with neither. Guessing at [aria-label="Send"]
      // matched nothing and made this whole fallback dead code.
      const clicked = await cdp.evaluate<string>(`(() => {
        const anchor = document.querySelector('[data-composer-navigation-target="reasoning"]');
        if (!anchor) return '';
        let root = anchor;
        for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
        const btns = [...root.querySelectorAll('button')].filter((b) =>
          !b.getAttribute('data-composer-navigation-target') && !b.getAttribute('aria-label'));
        // Rightmost wins if more than one survives — submit sits at the end.
        const el = btns.sort((a, b) =>
          a.getBoundingClientRect().left - b.getBoundingClientRect().left).pop();
        if (!el) return '';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`)
      if (typeof clicked === 'string' && clicked) {
        const at = JSON.parse(clicked) as { x: number; y: number }
        await cdp.click(at.x, at.y)
        for (let i = 0; i < 15; i++) {
          await this.sleep(200)
          if (!(await cdp.composerText()).trim()) { sent = true; break }
        }
        log.event('codex-create-send-button', { ok: sent })
      } else {
        log.warn('codex-create-no-send-button', {})
      }
    }
    if (!sent) { log.warn('codex-create-send-unconfirmed', {}); return { ok: false, reason: 'send-failed' } }
    log.event('codex-create-sent', {})

    // Which sidebar row appeared? Diffed against the snapshot taken before we
    // clicked New, so it needs no name and no timing heuristic.
    let domThreadId: string | undefined
    try {
      const added = (await listThreads(cdp)).map((t) => t.id).filter((id) => id && !before.has(id))
      if (added.length === 1) domThreadId = added[0]
      else if (added.length > 1) log.warn('codex-create-ambiguous-row', { added: added.length })
      if (domThreadId) log.event('codex-create-dom-row', { domThreadId, transient: isTransientThreadId(domThreadId) })
    } catch { /* best effort — the durable id below is what the task is keyed on */ }

    const threadId = await this.resolveNewThreadId(startedAt, 20, opts.knownThreadIds)
    if (!threadId) {
      // The message IS in Codex at this point — the send was confirmed above.
      // Report the id failure distinctly so it is never mistaken for "the task
      // did not start", which is what caused a duplicate run on another agent.
      log.warn('codex-create-id-unresolved', { startedAt, note: 'thread exists in Codex but id not recovered' })
      return { ok: false, reason: 'id-unresolved' }
    }
    // The turn is away; hand the composer back to whatever the user had.
    await restoreReasoning().catch(() => {})
    log.event('codex-task-created', { threadId, domThreadId: domThreadId ?? null, project: opts.project ?? null })
    return { ok: true, threadId, domThreadId }
  }

  /**
   * Wait for the durable thread id of the newly created chat. A row appears
   * immediately with a transient `local:client-new-thread:<uuid>` id; the real
   * `local:019f…` id lands once Codex persists it.
   */
  /**
   * Recover the durable thread id from the FILE SYSTEM.
   *
   * Never from the DOM: a freshly created row carries a transient
   * `client-new-thread:` id and the durable one is never written there, so the
   * old DOM poll could only ever time out.
   */
  private async resolveNewThreadId(startedAt: number, tries = 20, exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
    for (let i = 0; i < tries; i++) {
      const id = await newestThreadIdSince(startedAt, this.sessionsDir, exclude)
      if (id) { log.event('codex-id-resolved', { threadId: id, attempts: i + 1 }); return id }
      await this.sleep(400)
    }
    return null
  }

  /** Send a follow-up / unblock into an existing thread. */
  async send(threadId: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    return this.sendWithAttachments(threadId, text, [])
  }

  /** Run one delivery against the exact Codex thread.
   *
   * The non-activating sidebar search remains the first choice. When Codex has
   * virtualized the thread out of its sidebar, submission may use the app's
   * exact deep link, but the whole navigation + compose + submit transaction is
   * serialized and the previously frontmost app is restored in `finally`.
   * Capture and manual paste never call this; only an explicit draft submit
   * crosses this focus boundary. */
  private deliverToExactThread<T>(
    threadId: string,
    cdp: CodexCdp,
    observer: (stage: string, fields?: Record<string, unknown>) => void,
    deliver: () => Promise<T>,
  ): Promise<{ opened: boolean; value?: T }> {
    return (async (): Promise<{ opened: boolean; value?: T }> => {
      const backgroundOpened = await this.openThread(threadId, cdp, { background: true })
      if (backgroundOpened) {
        observer('thread-open', { ok: true, threadId, background: true, via: 'background' })
        return { opened: true, value: await deliver() }
      }

      observer('thread-open-background-miss', { ok: false, threadId, draftRetainedUntilVerified: true })
      let previousBundleId: string | null = null
      try {
        previousBundleId = await this.frontmost()
        observer('focus-snapshot', { ok: !!previousBundleId, previousBundleId })
      } catch (error) {
        observer('focus-snapshot', { ok: false, error: (error as Error).message })
      }

      try {
        const exactOpened = await this.openThread(threadId, cdp)
        observer('thread-open-exact', { ok: exactOpened, threadId, via: 'deeplink' })
        observer('thread-open', { ok: exactOpened, threadId, background: false, via: 'deeplink' })
        if (!exactOpened) return { opened: false }
        return { opened: true, value: await deliver() }
      } finally {
        if (previousBundleId) {
          let restored = false
          try { restored = await this.activate(previousBundleId) } catch { restored = false }
          observer('focus-restored', { ok: restored, bundleId: previousBundleId })
        } else {
          observer('focus-restored', { ok: false, reason: 'frontmost-app-unknown' })
        }
      }
    })()
  }

  async sendWithAttachments(
    threadId: string,
    text: string,
    attachments: readonly string[],
    observer?: (stage: string, fields: Record<string, unknown>) => void,
  ): Promise<{ ok: boolean; reason?: string }> {
    const observe = (stage: string, fields: Record<string, unknown> = {}) => {
      try { observer?.(stage, fields) } catch { /* diagnostics never alter delivery */ }
    }
    // One Codex window has one mounted composer and one rollout counter. Keep
    // the queue through durable proof so concurrent replies cannot share an
    // acknowledgement or navigate away from a send still being confirmed.
    const run = this.deliveryChain.then(() => this.sendWithAttachmentsNow(threadId, text, attachments, observe))
    this.deliveryChain = run.catch(() => {})
    return run
  }

  private async sendWithAttachmentsNow(
    threadId: string,
    text: string,
    attachments: readonly string[],
    observe: (stage: string, fields?: Record<string, unknown>) => void,
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      const cdp = await this.connect()
      observe('cdp-connect', { ok: !!cdp })
      if (!cdp) return { ok: false, reason: 'not-armed' }
      const transaction = await this.deliverToExactThread(threadId, cdp, observe, async () => {
        const before = await this.snapshot(threadId)
        observe('baseline-read', { turnsStarted: before.turnsStarted })
        await this.sleep(500)
        if (!(await this.mountedThreadMatches(threadId, cdp, observe, 'thread-identity-before-compose'))) {
          return { ok: false as const, reason: 'thread-drifted' }
        }
        const focused = await cdp.focusComposer()
        observe('composer-focused', { ok: focused })
        if (!focused) return { ok: false as const, reason: 'no-composer' }
        if (attachments.length) {
          const attached = await cdp.attachFiles(attachments)
          observe('files-attached', { ok: attached, count: attachments.length })
          if (!attached) return { ok: false as const, reason: 'attach-failed' }
          await this.sleep(180)
        } else {
          observe('files-attached', { ok: true, count: 0, skipped: true })
        }
        if (text) {
          await cdp.focusComposer()
          await cdp.typeText(text)
          observe('text-typed', { chars: text.length })
          await this.sleep(180)
          const typed = await cdp.composerText()
          observe('text-verified', { ok: typed === text, expectedChars: text.length, actualChars: typed.length })
          if (typed !== text) return { ok: false as const, reason: 'text-mismatch' }
        }
        if (!(await this.mountedThreadMatches(threadId, cdp, observe, 'thread-identity-before-submit'))) {
          return { ok: false as const, reason: 'thread-drifted' }
        }
        await cdp.pressEnter()
        observe('submit-key', { key: 'Enter' })
        return { ok: true as const, turnsStartedBefore: before.turnsStarted }
      })
      if (!transaction.opened) return { ok: false, reason: 'thread-not-found' }
      const composed = transaction.value
      if (!composed?.ok) return composed ?? { ok: false, reason: 'send-failed' }

      // Pressing Enter is only an attempt. The rollout is the durable authority:
      // a new task_started event proves Codex accepted this turn, including an
      // image-only turn whose text composer was empty before submission. Exact
      // navigation has already restored the user's previous app at this point;
      // proof is a renderer-free disk read and never needs Codex foregrounded.
      for (let i = 0; i < 20; i++) {
        await this.sleep(200)
        const after = await this.snapshot(threadId)
        if (after.turnsStarted > composed.turnsStartedBefore) {
          observe('rollout-confirmed', { poll: i + 1, before: composed.turnsStartedBefore, after: after.turnsStarted })
          return { ok: true }
        }
      }
      observe('rollout-timeout', { polls: 20, turnsStarted: composed.turnsStartedBefore })
      return { ok: false, reason: 'send-failed' }
    } catch (error) {
      observe('delivery-exception', { ok: false, error: (error as Error).message, draftRetained: true })
      log.warn('codex-delivery-exception', { threadId: bareThreadId(threadId), error: (error as Error).message })
      return { ok: false, reason: 'delivery-exception' }
    }
  }

  private async mountedThreadMatches(
    threadId: string,
    cdp: CodexCdp,
    observe: (stage: string, fields?: Record<string, unknown>) => void,
    stage: string,
  ): Promise<boolean> {
    const expected = bareThreadId(threadId)
    const current = await currentConversationId(cdp)
    const actual = current ? bareThreadId(current) : null
    const ok = actual === expected
    observe(stage, { ok, expectedThreadId: expected, actualThreadId: actual })
    return ok
  }

  /**
   * Switch the app to a thread. Used both before a send and by the cockpit's
   * tap-through — the Codex analogue of "show me the terminal", except we hand
   * the user the real chat instead of re-rendering it (ORCHESTRATE-VISION §3:
   * no chat-bubble transcript re-rendering).
   */
  async openThread(
    threadId: string,
    existing?: CodexCdp,
    opts: { background?: boolean } = {},
  ): Promise<boolean> {
    const bare = bareThreadId(threadId)

    // THE DEEP LINK, NOT THE SIDEBAR.
    //
    // This used to click the thread's row in the sidebar, which fails for any
    // thread not currently rendered there — and that is most of them. Measured
    // on a live machine: 8 rows in the DOM against 20+ threads, because the
    // Recents section was collapsed; the section's contents are not merely
    // hidden, they are absent. Lists are truncated too (`show-all` buttons).
    // So the DOM route could only ever reach whatever happened to be on screen,
    // which is why "open in Codex" landed on the wrong chat and every send
    // failed with thread-not-found.
    //
    // Codex registers a `codex://` scheme and uses `codex://threads/<id>` for
    // its own "Open in app" menu item. It resolves the thread properly, with no
    // dependence on what the sidebar is showing — verified against a thread
    // inside a collapsed section.
    //
    // ...but it ACTIVATES Codex. `open -g` suppresses `open`'s own activation,
    // yet the app's URL handler raises the window itself — measured: Finder
    // frontmost, deep link, ChatGPT frontmost. For a dictated follow-up that
    // would yank the user out of whatever they were doing, which is the one
    // thing this whole lane exists to avoid.
    //
    // So the deep link is reserved for an EXPLICIT user-facing open. The
    // background send ladder never activates another app:
    //   0. already there            — nothing to do (the common repeat-send case)
    //   1. bounded sidebar search   — expand, paginate, scroll, click via CDP
    //   2. fail safely              — preserve the draft; never steal focus
    const cdp = existing ?? (await this.connect())
    if (!cdp) return false

    const isThere = async (): Promise<boolean> => {
      const current = await currentConversationId(cdp)
      return !!current && bareThreadId(current) === bare
    }
    const settle = async (via: string): Promise<boolean> => {
      for (let i = 0; i < 12; i++) {
        await this.sleep(200)
        if (await isThere()) { log.event('codex-thread-opened', { threadId: bare, via }); return true }
      }
      return false
    }

    if (await isThere()) { log.event('codex-thread-already-open', { threadId: bare }); return true }
    if (threadNavigationFallback(!!opts.background) === 'deeplink') {
      try {
        await this.openDeepLink(`codex://threads/${bare}`)
      } catch (e) {
        log.warn('codex-deeplink-failed', { threadId: bare, error: (e as Error).message })
        return false
      }
      const landed = await settle('deeplink')
      if (!landed) log.warn('codex-thread-open-unconfirmed', { threadId: bare })
      return landed
    }

    const found = await searchSidebarThread({
      resetScroll: () => resetSidebarScroll(cdp),
      clickTarget: () => clickThreadRow(cdp, threadId),
      expandOne: () => expandNextSidebarGroup(cdp),
      clickShowMore: () => clickNextSidebarShowMore(cdp),
      advanceScroll: () => advanceSidebarScroll(cdp),
    }, (ms) => this.sleep(ms))
    if (found && await settle('sidebar-search')) return true
    log.warn('codex-thread-background-unreachable', { threadId: bare })
    return false
  }

  /** Read a thread's state + recent turns from disk. Never touches the renderer. */
  /**
   * Status chip for EVERY thread, in one call, without switching Codex's view.
   *
   * This is the cross-task detector: the consent panel exists only for the
   * mounted thread, so per-task reads would thrash the window. Verified live
   * against a NON-mounted blocked thread — that case is the whole point.
   *
   * Empty array means UNKNOWN (not armed / sidebar not rendered), never
   * "nothing is blocked". Callers keep whatever the disk signal said.
   */
  async threadChips(): Promise<CodexThreadChip[]> {
    const cdp = await this.connect()
    if (!cdp) return []
    try { return await readThreadChips(cdp) } catch { return [] }
  }

  /**
   * Read the Computer Use consent this thread is parked on, or null.
   *
   * Costs a thread switch, so callers must only reach for it once the CHEAP
   * disk signal (snapshot.pendingToolCalls on a rollout that stopped growing)
   * says the turn is parked. Backgrounded — the user's window is never raised.
   *
   * Returns null for "no consent" AND for "could not tell" (not armed, thread
   * not mounted, DOM reworded). Callers must treat null as unknown and keep the
   * disk-derived blocked state rather than clearing it.
   */
  async readConsent(threadId: string): Promise<CodexConsent | null> {
    const cdp = await this.connect()
    if (!cdp) return null
    if (!(await this.openThread(threadId, cdp, { background: true }))) return null
    await this.sleep(300)
    try { return await readPendingConsent(cdp) } catch { return null }
  }

  /**
   * Answer a consent by the option's own label, as read from readConsent().
   * False when not armed, not mounted, or Codex is not offering that option —
   * never a guess, because the options differ per consent.
   */
  async answerConsent(threadId: string, option: string): Promise<boolean> {
    const cdp = await this.connect()
    if (!cdp) return false
    if (!(await this.openThread(threadId, cdp, { background: true }))) return false
    await this.sleep(300)
    try { return await answerConsent(cdp, option) } catch { return false }
  }

  /**
   * Call back the moment Codex appends to this thread's rollout.
   *
   * Purely a latency shortcut on top of polling — see watchThread(). Returns a
   * disposer that is safe to call twice, and a no-op disposer when a watcher
   * could not be started, so callers never branch on whether it worked.
   */
  async watch(threadId: string, onChange: () => void): Promise<() => void> {
    return watchThread(threadId, onChange, this.sessionsDir)
  }

  async snapshot(threadId: string): Promise<CodexSnapshot> {
    // The DEFAULT limit is 6, and passing nothing meant a whole conversation
    // was cut to its last 6 ITEMS at parse time — and items are per-step now, so
    // six is often less than one turn. The user's own messages were sliced off,
    // which is why the panel never read as a chat: there was no alternation left
    // to see. 400 is "the whole thread" for any realistic session; the transport
    // cost is handled by not re-sending an unchanged transcript (notch) rather
    // than by throwing history away here.
    return readThread(threadId, this.sessionsDir, 400)
  }
}

/** Resolve the Codex CLI binary: PATH first, else the desktop bundle's copy. */
export async function resolveCodexCli(which: (bin: string) => Promise<string | null>): Promise<string | null> {
  const onPath = await which('codex').catch(() => null)
  if (onPath) return onPath
  try { await fs.stat(CODEX_BUNDLED_CLI); return CODEX_BUNDLED_CLI } catch { return null }
}

export const codexHome = () => join(homedir(), '.codex')
