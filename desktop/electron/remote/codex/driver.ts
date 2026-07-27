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
import { CodexCdp, isArmed, listProjects, listThreads, bareThreadId, isTransientThreadId, type CodexProject, readApprovalLabel, readApprovalMenu, selectApprovalLevel, currentConversationId, clickThreadRow, expandSidebarSections, readReasoning, readReasoningLabel, setReasoning, type ReasoningState, type ReasoningAxis, type SetReasoningTrace } from './cdp'
import { choosePolicy, levelsFromMenu, levelFromLabel, LEVEL_LABEL, type CodexApprovalLevel, type UnmutePermissionMode } from './approval'
import { readThread, newestThreadIdSince, type CodexSnapshot } from './rollout'

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
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

  constructor(private readonly deps: CodexDriverDeps = {}) {
    this.port = deps.port ?? CODEX_CDP_PORT
    this.appPath = deps.appPath ?? CODEX_APP_PATH
    this.sessionsDir = deps.sessionsDir
    this.sleep = deps.sleep ?? defaultSleep
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
      const ceiling: CodexApprovalLevel = 'approve-for-me'
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
      /** Codex's own labels, e.g. "5.6 Luna" / "High" / "Fast". */
      model?: string
      effort?: string
      speed?: string
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
    await this.sleep(120)
    await cdp.typeText(intent)
    await this.sleep(180)
    const typed = await cdp.composerText()
    if (!typed.trim()) { log.warn('codex-create-type-failed', { intentLen: intent.length }); return { ok: false, reason: 'no-composer' } }
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

    const threadId = await this.resolveNewThreadId(startedAt)
    if (!threadId) {
      // The message IS in Codex at this point — the send was confirmed above.
      // Report the id failure distinctly so it is never mistaken for "the task
      // did not start", which is what caused a duplicate run on another agent.
      log.warn('codex-create-id-unresolved', { startedAt, note: 'thread exists in Codex but id not recovered' })
      return { ok: false, reason: 'id-unresolved' }
    }
    // The turn is away; hand the composer back to whatever the user had.
    await restoreReasoning().catch(() => {})
    log.event('codex-task-created', { threadId, project: opts.project ?? null })
    return { ok: true, threadId }
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
  private async resolveNewThreadId(startedAt: number, tries = 20): Promise<string | null> {
    for (let i = 0; i < tries; i++) {
      const id = await newestThreadIdSince(startedAt, this.sessionsDir)
      if (id) { log.event('codex-id-resolved', { threadId: id, attempts: i + 1 }); return id }
      await this.sleep(400)
    }
    return null
  }

  /** Send a follow-up / unblock into an existing thread. */
  async send(threadId: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    const cdp = await this.connect()
    if (!cdp) return { ok: false, reason: 'not-armed' }
    // Background: sending must never yank the user's window to the front.
    if (!(await this.openThread(threadId, cdp, { background: true }))) return { ok: false, reason: 'thread-not-found' }
    await this.sleep(500)
    if (!(await cdp.focusComposer())) return { ok: false, reason: 'no-composer' }
    await this.sleep(120)
    await cdp.typeText(text)
    await this.sleep(180)
    await cdp.pressEnter()
    for (let i = 0; i < 20; i++) {
      await this.sleep(200)
      if (!(await cdp.composerText()).trim()) return { ok: true }
    }
    return { ok: false, reason: 'send-failed' }
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
    // So the deep link is the LAST rung, not the first. The ladder:
    //   0. already there            — nothing to do (the common repeat-send case)
    //   1. click the sidebar row    — CDP input never steals focus
    //   2. expand collapsed sections and retry — still focus-free (8 rows → 16)
    //   3. deep link                — always correct, and for a background
    //      switch we put the user's app back in front afterwards
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
    if (await clickThreadRow(cdp, threadId) && await settle('sidebar-row')) return true
    if (await expandSidebarSections(cdp, (ms) => this.sleep(ms))) {
      if (await clickThreadRow(cdp, threadId) && await settle('sidebar-row-expanded')) return true
    }

    const restore = opts.background ? await frontmostApp() : null
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('open', ['-g', `codex://threads/${bare}`], (err) => (err ? reject(err) : resolve()))
      })
    } catch (e) {
      log.warn('codex-deeplink-failed', { threadId: bare, error: (e as Error).message })
      return false
    }
    const landed = await settle('deeplink')
    if (restore) {
      // Hand focus straight back. Not cosmetic: without it every voice
      // follow-up to an off-screen thread steals the user's window.
      await activateApp(restore)
      log.event('codex-focus-restored', { app: restore })
    }
    if (!landed) log.warn('codex-thread-open-unconfirmed', { threadId: bare })
    return landed
  }

  /** Read a thread's state + recent turns from disk. Never touches the renderer. */
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


/** The app the user is actually looking at, so we can hand focus back. */
async function frontmostApp(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      (err, stdout) => resolve(err ? null : stdout.trim() || null))
  })
}

async function activateApp(name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "${name.replace(/"/g, '')}" to activate`], () => resolve())
  })
}
