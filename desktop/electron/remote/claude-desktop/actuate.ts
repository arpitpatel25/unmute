// Unmute Remote — Claude desktop ACTUATION. The only code here that changes
// anything in the user's app, and the only code that touches their focus.
//
// Everything else in this backend is a file read or a tree read: free,
// backgrounded, unnoticeable. This module is the opposite, and is deliberately
// small and serialized because of it.
//
// ── Why the app must come to the front ────────────────────────────────────
//
// It is not a shortcut. Four independent routes were tested with the app
// backgrounded and ALL FOUR failed — every one of them returning success while
// doing nothing:
//
//   AXPress on a web button              fails backgrounded, works frontmost
//   synthetic mouse (CGEventPostToPid)   fails backgrounded
//   AXPress on a native menu item        fails backgrounded
//   synthetic keyboard (CGEventPostToPid) fails backgrounded, works frontmost
//
// AXRaise (raise the window without activating) is not enough either; the app
// needs a real NSRunningApplication activation. So the shape is fixed:
//
//     remember frontmost -> activate Claude -> do EVERYTHING -> restore
//
// which is why this is a QUEUE rather than a set of callable methods. Fronting
// per action produced ~8-10 switches for one demo in the spike. One user
// intent, one switch.
//
// ── Why keyboard, not AXPress ─────────────────────────────────────────────
//
// The obvious implementation — read the tree, find the Deny button, press its
// id — cannot work with the shipped addon, and it fails in the worst way:
// silently pressing the WRONG control.
//
// press(app, id) and setValue(app, id, text) re-walk the tree at maxDepth 14
// (native-ax src/ax.mm), and ids are POSITIONAL within a walk. Our reads run at
// depth 40 because the real UI is deeper than 14 — the Send button sits at
// depth 28 and the consent buttons around 20. So:
//
//   * every id we hold is from a different walk than the one press performs,
//     so it addresses a different node; and
//   * the nodes we actually want are beyond depth 14, so that walk cannot
//     reach them at all.
//
// A drifted id turning "Deny" into "Allow once" is the exact hazard the spike
// warned about, and here it would be systematic rather than a race.
//
// The keyboard route sidesteps ids entirely. Claude Desktop numbers its own
// prompt options — "Deny 1", "Always allow 2", "Allow once 3 ⌘ ⏎" — so the
// answer is a digit, and typing is how a human answers it too. The spike
// verified this exact path: the same key event that did nothing backgrounded
// cleared the prompt instantly once the app was activated.

import { execFile } from 'node:child_process'
import { getAxBridge, type AxBridge } from '../ax/ax-bridge'
import { createLogger } from '../log'
import { CLAUDE_BUNDLE_ID, readSidebarRows, isTreeAlive, modelPopup, type ClaudeConsent, type AxNode } from './ax'

const log = createLogger('claude-desktop-actuate')

export interface ActuateResult {
  ok: boolean
  /** Why not. 'no-shortcut' = the option carried no digit to type.
   *  'row-not-found' = that conversation is not in the (windowed) sidebar.
   *  'row-moved' = the tree shifted between locating the row and pressing it. */
  reason?: 'not-running' | 'no-shortcut' | 'activate-failed' | 'bridge-failed'
    | 'tree-dead' | 'row-not-found' | 'row-moved'
}

/**
 * Depth for every read AND every press in this module.
 *
 * These must be the SAME number. Node ids are positional within a walk, so a
 * press performed at a different depth than the read that produced the id
 * actuates a different control. Sharing one constant is what keeps that true.
 */
export const ACTUATE_DEPTH = 40

/**
 * The digit Claude Desktop assigns to a prompt option.
 *
 * Labels arrive as "Deny 1" / "Allow once 3 ⌘ ⏎", so the shortcut is a
 * standalone 1-9 in the label. Parsed rather than positional because the ORDER
 * of options is not guaranteed and the app's own numbering is: taking "the
 * first button" would answer a different question than the one shown.
 *
 * Returns null when there is no digit, and callers must fail rather than fall
 * back to a guess — pressing something arbitrary on a permission prompt is the
 * worst possible failure in this feature.
 */
export function shortcutDigit(label: string): string | null {
  const m = label.match(/(?:^|\s)([1-9])(?:\s|$)/)
  return m ? m[1] : null
}

export interface ActuatorDeps {
  bridge?: AxBridge
  bundleId?: string
  /** Bring an app to the front. Injectable so tests never touch real focus. */
  activate?: (bundleId: string) => Promise<boolean>
  /** Who was in front before we started. */
  frontmost?: () => Promise<string | null>
  /** Text that opens the nested model list. Defaults to 'More'. */
  moreModelsLabel?: string
}

/** Default activation: LaunchServices, by bundle id. */
function defaultActivate(bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('open', ['-b', bundleId], (err) => resolve(!err))
  })
}

/**
 * Serializes every focus-stealing action against Claude Desktop.
 *
 * ONE queue for the whole app. Two actuations in flight would fight over which
 * app is frontmost and, worse, over which conversation is open — and only one
 * conversation is ever addressable here, so an interleaved pair could deliver
 * one task's answer to another task's prompt.
 */
export class ClaudeActuator {
  private readonly bundleId: string
  private chain: Promise<unknown> = Promise.resolve()

  /** The submenu's own label. English UI copy, so it is a constructor knob
   *  rather than a literal buried in the method — a localized build needs this
   *  changed, and it should be one obvious place. */
  private readonly moreLabel: string

  constructor(private readonly deps: ActuatorDeps = {}) {
    this.bundleId = deps.bundleId ?? CLAUDE_BUNDLE_ID
    this.moreLabel = deps.moreModelsLabel ?? 'More'
  }

  private bridge(): AxBridge {
    return this.deps.bridge ?? getAxBridge()
  }

  /** Run `fn` with Claude frontmost, then put the user's app back. */
  private run<T>(label: string, fn: () => Promise<T>, onFail: T): Promise<T> {
    const task = this.chain.then(async (): Promise<T> => {
      let prev: string | null = null
      try {
        prev = this.deps.frontmost
          ? await this.deps.frontmost()
          : ((await this.bridge().call('frontmostApp', []))?.bundleId ?? null)
      } catch {
        prev = null   // not knowing where to return is survivable; not acting is not
      }
      const activate = this.deps.activate ?? defaultActivate
      if (!(await activate(this.bundleId))) {
        log.warn('activate-failed', { label })
        return onFail
      }
      try {
        return await fn()
      } finally {
        // ALWAYS restore, including after a throw. Leaving the user staring at
        // an app they did not open is the most visible way this can misbehave.
        if (prev && prev !== this.bundleId) {
          try { await activate(prev) } catch { /* best effort */ }
        }
      }
    })
    // Keep the chain alive even when one action rejects, or a single failure
    // would wedge every later actuation.
    this.chain = task.catch(() => {})
    return task
  }

  /**
   * Answer a pending permission prompt by typing its shortcut.
   *
   * The option is identified by the LABEL the user was shown, so the answer
   * cannot drift onto a different choice between reading and acting — the thing
   * positional ids cannot promise here.
   */
  async answerConsent(consent: ClaudeConsent, optionLabel: string): Promise<ActuateResult> {
    const option = consent.options.find((o) => o.label === optionLabel)
    if (!option) return { ok: false, reason: 'no-shortcut' }
    const digit = shortcutDigit(option.label)
    if (!digit) {
      // No digit means we cannot answer this prompt safely. Say so; do not
      // press something and hope.
      log.warn('consent-no-shortcut', { label: option.label })
      return { ok: false, reason: 'no-shortcut' }
    }
    return this.run<ActuateResult>('answerConsent', async () => {
      const out = await this.bridge().call('typeText', [this.bundleId, digit, false, false])
      if (out?.error) {
        log.warn('consent-type-failed', { error: out.error })
        return { ok: false, reason: 'bridge-failed' }
      }
      log.event('claude-desktop-consent-answered', { option: option.label, digit })
      return { ok: true }
    }, { ok: false, reason: 'activate-failed' })
  }

  /**
   * Open one conversation by title, so a later action lands in the right chat.
   *
   * Everything else in this module acts on "the open conversation", and only
   * ONE is ever addressable on this app (AXWindows is empty) — so this is the
   * step that decides which task an action belongs to. Getting it wrong sends
   * one task's message to another task's thread.
   *
   * GUARDED AGAINST TREE DRIFT. The tree is re-read immediately before the
   * press and the row must still carry the same label at the same id. Positions
   * were observed shifting between renders with no user interaction, and an id
   * that has moved would press whatever is now sitting there. The spike's rule
   * exactly: resolve fresh, re-check the label, then act.
   */
  async openConversation(title: string): Promise<ActuateResult> {
    if (!title.trim()) return { ok: false, reason: 'row-not-found' }
    return this.run<ActuateResult>('openConversation', async () => {
      const bridge = this.bridge()
      const read = async (): Promise<AxNode[]> => {
        const out = await bridge.call('getTree', [this.bundleId, 0, '', ACTUATE_DEPTH, true])
        if (!out || out.error) return []
        return (out.nodes ?? []) as AxNode[]
      }

      const first = await read()
      if (!isTreeAlive(first)) return { ok: false, reason: 'tree-dead' }
      const row = readSidebarRows(first, [title]).find((r) => r.title === title)
      if (!row) {
        // The sidebar is windowed — a conversation can be real and simply not
        // listed. Saying so beats pressing something adjacent.
        log.warn('open-row-not-found', { title: title.slice(0, 60) })
        return { ok: false, reason: 'row-not-found' }
      }

      // Re-read and confirm the id still means the same row.
      const second = await read()
      const stillThere = second.find((n) => n.id === row.id)
      if (!stillThere || !stillThere.label.endsWith(title)) {
        log.warn('open-row-moved', { title: title.slice(0, 60) })
        return { ok: false, reason: 'row-moved' }
      }

      const out = await bridge.call('press', [this.bundleId, row.id, ACTUATE_DEPTH])
      if (out?.error || out?.ok === false) {
        log.warn('open-press-failed', { error: out?.error ?? 'press reported false' })
        return { ok: false, reason: 'bridge-failed' }
      }
      // press() echoes the label of what it ACTUALLY actuated (verified live:
      // {"ok":true,"role":"AXButton","label":"Idle Season preference questions"}).
      // That is authoritative in a way no pre-check can be — the pre-check says
      // what we intended, this says what happened. If they disagree the tree
      // moved between the two reads and we pressed the wrong row, which the
      // caller must know rather than proceed to type into it.
      const pressedLabel = typeof out?.label === 'string' ? out.label : null
      if (pressedLabel !== null && !pressedLabel.endsWith(title)) {
        log.warn('open-pressed-wrong-row', { wanted: title.slice(0, 40), got: pressedLabel.slice(0, 40) })
        return { ok: false, reason: 'row-moved' }
      }
      log.event('claude-desktop-opened', { title: title.slice(0, 60) })
      return { ok: true }
    }, { ok: false, reason: 'activate-failed' })
  }

  /**
   * Switch the composer's model, BY NAME.
   *
   * ── What the app does, all measured 2026-08-01 ───────────────────────────
   *
   *   AXPress / AXShowMenu on the popup   success, opens nothing
   *   a REAL synthetic click              opens the menu
   *   the open menu, in the AX tree       invisible — AXWindows still 1
   *   the shortcut digits it shows        do NOT work; "3" lands in the
   *                                       composer as text
   *   arrows + Return                     selects
   *   TYPE-AHEAD + Return                 selects, by name
   *
   * ── Why by name and not by position ──────────────────────────────────────
   *
   * Counting keypresses couples us to a layout we cannot see: a reordered menu,
   * an inserted row, a new model, and every mapping silently shifts. It also
   * cannot reach the four models behind "More models >" at all. Type-ahead
   * addresses a row by its own text, so the app can rearrange freely.
   *
   * TWO LEVELS. Typing at the top level reaches four models; the rest live in a
   * submenu. Type-ahead there matches only what is on the CURRENT level and
   * fails DANGEROUSLY rather than loudly — asking for "Opus 4.8" matched the
   * prefix "Opus" and silently selected Opus 5. So the top level is tried
   * first, and on a wrong landing we step into the submenu ("More", then Right)
   * and try again there.
   *
   * Either way the popup label is read back afterwards. It is the only thing
   * that knows what actually happened.
   */
  async setModel(label: string): Promise<ActuateResult & { landedOn?: string }> {
    if (!label.trim()) return { ok: false, reason: 'no-shortcut' }
    return this.run<ActuateResult & { landedOn?: string }>('setModel', async () => {
      const bridge = this.bridge()
      const RETURN = 36, RIGHT = 124, ESCAPE = 53
      const read = async (): Promise<AxNode[]> => {
        const out = await bridge.call('getTree', [this.bundleId, 0, '', ACTUATE_DEPTH, true])
        return (!out || out.error) ? [] : ((out.nodes ?? []) as AxNode[])
      }
      const current = async (): Promise<string | null> => modelPopup(await read())?.label?.trim() ?? null

      const pop = modelPopup(await read())
      if (!pop || pop.x === undefined || pop.w === undefined) return { ok: false, reason: 'row-not-found' }
      const wasOn = pop.label.trim()
      if (wasOn === label) return { ok: true }          // already there; touch nothing

      const openMenu = async (): Promise<boolean> => {
        const c = await bridge.call('clickPoint', [pop.x! + pop.w! / 2, (pop.y ?? 0) + (pop.h ?? 0) / 2])
        if (c?.error) return false
        await new Promise((r) => setTimeout(r, 700))    // the menu takes a beat to mount
        return true
      }

      // ── attempt 1: the top level ──
      if (!(await openMenu())) return { ok: false, reason: 'bridge-failed' }
      await bridge.call('typeText', [this.bundleId, label, false, false])
      await new Promise((r) => setTimeout(r, 400))
      await bridge.call('sendKeys', [[RETURN], 120])
      await new Promise((r) => setTimeout(r, 900))

      let landed = await current()
      if (landed === label) {
        log.event('claude-desktop-model-set', { from: wasOn, to: landed, via: 'top-level' })
        return { ok: true }
      }

      // ── attempt 2: inside "More models" ──
      // A miss here is expected for the four nested models, and is NOT a
      // failure yet — but it may have moved us, which the final read settles.
      if (!(await openMenu())) return { ok: false, reason: 'bridge-failed' }
      await bridge.call('typeText', [this.bundleId, this.moreLabel, false, false])
      await new Promise((r) => setTimeout(r, 400))
      await bridge.call('sendKeys', [[RIGHT], 150])
      await new Promise((r) => setTimeout(r, 500))
      await bridge.call('typeText', [this.bundleId, label, false, false])
      await new Promise((r) => setTimeout(r, 400))
      await bridge.call('sendKeys', [[RETURN], 120])
      await new Promise((r) => setTimeout(r, 900))

      landed = await current()
      if (landed === label) {
        log.event('claude-desktop-model-set', { from: wasOn, to: landed, via: 'submenu' })
        return { ok: true }
      }

      // Neither level had it. Close anything still open so the user is not left
      // staring at a menu we abandoned.
      await bridge.call('sendKeys', [[ESCAPE], 80])
      log.warn('claude-desktop-model-not-found', { wanted: label, landedOn: landed, wasOn })
      return { ok: false, reason: 'row-not-found', ...(landed ? { landedOn: landed } : {}) }
    }, { ok: false, reason: 'activate-failed' })
  }

  /**
   * Start a new conversation and send the first message into it.
   *
   * Pressing New, waiting for the composer, typing and submitting is ONE
   * actuation for the same reason open+send is: anything admitted in between
   * could re-target the app, and the first message of a task is exactly the
   * moment where landing in the wrong conversation is least recoverable.
   *
   * The caller resolves which task was created by diffing the store afterwards
   * — the UI gives us no id at creation, and guessing "the newest" without a
   * before-set is how the Codex backend once bound two cards to one thread.
   */
  async createTask(text: string, opts: { newLabel?: string; settleMs?: number } = {}): Promise<ActuateResult> {
    if (!text.trim()) return { ok: false, reason: 'no-shortcut' }
    const newLabel = opts.newLabel ?? 'New'
    const settleMs = opts.settleMs ?? 2500
    return this.run<ActuateResult>('createTask', async () => {
      const bridge = this.bridge()
      const out = await bridge.call('getTree', [this.bundleId, 0, '', ACTUATE_DEPTH, true])
      const nodes = ((out?.nodes ?? []) as AxNode[])
      if (!isTreeAlive(nodes)) return { ok: false, reason: 'tree-dead' }

      // Exact label match, not a prefix: 'New' must not resolve to a row whose
      // title merely begins with it.
      const btn = nodes.find((n) => n.role === 'AXButton' && n.label.trim() === newLabel)
      if (!btn) {
        log.warn('create-no-new-button', { newLabel })
        return { ok: false, reason: 'row-not-found' }
      }
      const pressed = await bridge.call('press', [this.bundleId, btn.id, ACTUATE_DEPTH])
      if (pressed?.error || pressed?.ok === false) return { ok: false, reason: 'bridge-failed' }

      // The composer takes a moment to mount (~2.5s observed in the spike).
      // Typing before it exists drops the message on the floor silently.
      await new Promise((r) => setTimeout(r, settleMs))

      const typed = await bridge.call('typeText', [this.bundleId, text, false, true])
      if (typed?.error) return { ok: false, reason: 'bridge-failed' }
      log.event('claude-desktop-created', { chars: text.length })
      return { ok: true }
    }, { ok: false, reason: 'activate-failed' })
  }

  /**
   * Open a conversation and send into it, as ONE actuation.
   *
   * These must not be two calls from outside. Between an open and a send the
   * queue could admit another intent, re-open a different conversation, and
   * the message would land in the wrong thread — the single worst outcome this
   * backend can produce, and completely silent when it happens.
   *
   * Runs inside a single fronting, so it is also one focus switch rather than
   * two.
   */
  async sendTo(title: string, text: string): Promise<ActuateResult> {
    if (!text.trim()) return { ok: false, reason: 'no-shortcut' }
    const opened = await this.openConversation(title)
    if (!opened.ok) return opened
    return this.send(text)
  }

  /**
   * Type a message into the open conversation and submit it.
   *
   * typeText(app, text, replace, submit) drives real key events into whatever
   * is focused, so it needs no node id — which is what makes it usable when the
   * composer sits at depth 28, past the reach of the addon's id-based calls.
   *
   * The caller is responsible for having opened the right conversation first:
   * only one is addressable, and this types into whichever that is.
   */
  async send(text: string): Promise<ActuateResult> {
    if (!text.trim()) return { ok: false, reason: 'no-shortcut' }
    return this.run<ActuateResult>('send', async () => {
      const out = await this.bridge().call('typeText', [this.bundleId, text, false, true])
      if (out?.error) {
        log.warn('send-failed', { error: out.error })
        return { ok: false, reason: 'bridge-failed' }
      }
      log.event('claude-desktop-sent', { chars: text.length })
      return { ok: true }
    }, { ok: false, reason: 'activate-failed' })
  }
}
