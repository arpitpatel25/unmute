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
import { CodexCdp, isArmed, listProjects, listThreads, bareThreadId, isTransientThreadId, type CodexProject } from './cdp'
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
   * Create a task: open a new chat (project-scoped when asked), type the intent,
   * submit. Returns the DURABLE thread id — we deliberately wait past the
   * transient `client-new-thread:` id so the handle we persist is the real one.
   */
  async createTask(intent: string, opts: { project?: string | null; autoArm?: boolean } = {}): Promise<CreateTaskResult> {
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
    if (!(await this.openThread(threadId, cdp))) return { ok: false, reason: 'thread-not-found' }
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
  async openThread(threadId: string, existing?: CodexCdp): Promise<boolean> {
    const cdp = existing ?? (await this.connect())
    if (!cdp) return false
    const domId = threadId.startsWith('local:') ? threadId : `local:${threadId}`
    const box = await cdp.evaluate<string>(`(() => {
      const el = document.querySelector('[data-app-action-sidebar-thread-id=' + ${JSON.stringify(JSON.stringify(domId))} + ']');
      if (!el) return '';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`)
    if (!box) return false
    const { x, y } = JSON.parse(box)
    await cdp.click(x, y)
    return true
  }

  /** Read a thread's state + recent turns from disk. Never touches the renderer. */
  async snapshot(threadId: string): Promise<CodexSnapshot> {
    return readThread(threadId, this.sessionsDir)
  }
}

/** Resolve the Codex CLI binary: PATH first, else the desktop bundle's copy. */
export async function resolveCodexCli(which: (bin: string) => Promise<string | null>): Promise<string | null> {
  const onPath = await which('codex').catch(() => null)
  if (onPath) return onPath
  try { await fs.stat(CODEX_BUNDLED_CLI); return CODEX_BUNDLED_CLI } catch { return null }
}

export const codexHome = () => join(homedir(), '.codex')
