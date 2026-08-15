import { EventEmitter } from 'events'
import { keyListener, KeyEvent } from './keyListener'
// Remote trigger gate (plan entitlement + the user's session toggle). Static
// import on purpose — a lazy require of a relative path dies in the bundled
// main process, and a silently-missing gate would leave Remote ungated.
import { isRemoteTriggerEnabled } from './remoteTriggerGate'

export type SessionMode = 'dictation' | 'instruction'
export type KeyboardEvent =
  | { type: 'session-start'; mode: SessionMode }
  | { type: 'session-stop'; mode: SessionMode }
  | { type: 'chain-start'; mode: SessionMode }
  | { type: 'chain-expired' }
  // ─── Unmute Remote (PRD §2.4.4 / §5) — ADDITIVE ───
  // Emitted when the NON-dictation trigger key (the derived Remote key) is
  // pressed/released. Remote is push-to-talk: down = start capture, up = stop +
  // dispatch. main.ts routes these to the Remote capture path; the dictation
  // events above are untouched (no-regression, PRD §2.4.1).
  | { type: 'remote-start' }
  | { type: 'remote-stop' }

export type DictationKey = 'fn' | 'right-option'
export type ActivationMode = 'tap-toggle' | 'push-to-talk' | 'double-tap-push'

// Double-tap-push state machine states
type DualModeState = 'idle' | 'held' | 'awaiting-second' | 'push-recording' | 'hands-free'

class KeyboardManager extends EventEmitter {
  private dictationActive = false
  private instructionActive = false
  private chainTimer: NodeJS.Timeout | null = null
  private chainWindowMs = 2000
  // Separate debounce per logical key so Fn and Caps Lock can't cross-block each other
  private lastDictationToggleTime = 0
  private lastInstructionToggleTime = 0
  private lastRemoteToggleTime = 0
  private readonly DEBOUNCE_MS = 300

  // ─── Configurable dictation key + activation mode ───
  private dictationKey: DictationKey = 'fn'
  private activationMode: ActivationMode = 'tap-toggle'

  // ─── Unmute Remote capture state (ADDITIVE) ───
  // True while a Remote (the non-dictation key) capture is in progress. Used
  // for the capture-time mutual-exclusion lock (PRD §2.4.4): dictation is
  // blocked while this is true, and Remote is blocked while dictation/
  // instruction is active.
  private remoteActive = false

  // Double-tap-push (dual mode) state
  private dualState: DualModeState = 'idle'
  private dualHoldTimer: NodeJS.Timeout | null = null
  private dualDoubleTapTimer: NodeJS.Timeout | null = null
  private readonly DUAL_HOLD_MS = 400
  private readonly DUAL_DOUBLE_TAP_MS = 400

  // Chain tracking
  private _chainPending = false
  private _chainMode: SessionMode | null = null

  start(): void {
    keyListener.on('key', (event: KeyEvent) => this.handleKey(event))
    const started = keyListener.start()
    if (started) {
      console.log('[keyboard] Key listener started')
    } else {
      console.warn('[keyboard] Key listener failed to start — hotkeys will not work')
    }
  }

  stop(): void {
    this.clearChainTimer()
    this.clearDualTimers()
    keyListener.stop()
  }

  /** Reset ALL routing state — call when session ends externally (cancel, processing complete, etc.).
   *  Every mutable variable that influences the next keystroke MUST be reset here. */
  resetState(): void {
    console.log('[keyboard] State RESET (was dictationActive:', this.dictationActive, 'instructionActive:', this.instructionActive, ')')
    this.dictationActive = false
    this.instructionActive = false
    this.lastDictationToggleTime = 0
    this.lastInstructionToggleTime = 0
    this.clearChainTimer()
    this._chainPending = false
    this._chainMode = null
    this.clearDualTimers()
    this.dualState = 'idle'
    this.remoteActive = false // ADDITIVE: clear Remote capture lock on any reset
  }

  setChainWindow(ms: number): void {
    this.chainWindowMs = ms
  }

  setDictationKey(key: DictationKey): void {
    console.log('[keyboard] Dictation key set to:', key)
    this.dictationKey = key
  }

  getDictationKey(): DictationKey {
    return this.dictationKey
  }

  setActivationMode(mode: ActivationMode): void {
    console.log('[keyboard] Activation mode set to:', mode)
    this.activationMode = mode
    // Reset dual-mode state when switching modes
    this.clearDualTimers()
    this.dualState = 'idle'
  }

  getActivationMode(): ActivationMode {
    return this.activationMode
  }

  handleKey(event: KeyEvent): void {
    console.log('[keyboard] Raw key event:', event, '| dictationActive:', this.dictationActive, '| instructionActive:', this.instructionActive)
    switch (event) {
      case 'fn-down':
        // fn is either the dictation key OR (when right-option is dictation)
        // the derived Remote key. The non-dictation branch is ADDITIVE — it
        // was previously a no-op (PRD §2.4.4).
        if (this.dictationKey === 'fn') this.handleDictationKeyDown()
        else this.handleRemoteKeyDown()
        break
      case 'fn-up':
        if (this.dictationKey === 'fn') this.handleDictationKeyUp()
        else this.handleRemoteKeyUp()
        break
      case 'right-option-down':
        if (this.dictationKey === 'right-option') this.handleDictationKeyDown()
        else this.handleRemoteKeyDown()
        break
      case 'right-option-up':
        if (this.dictationKey === 'right-option') this.handleDictationKeyUp()
        else this.handleRemoteKeyUp()
        break
      case 'caps-down':
      case 'caps-up':
        // Caps Lock is a toggle key — macOS alternates between CAPS_DOWN and CAPS_UP
        // on each physical press (reflecting LED state, not press/release).
        // So both events represent a physical key press → treat both as toggle.
        this.handleInstructionToggle()
        break
    }
  }

  // ─── Unmute Remote (task creation) key dispatchers (ADDITIVE, PRD §2.4.4 / §5) ───
  // The task key is ALWAYS tap-toggle — never push-to-talk, and not configurable.
  // A task is a commit (spawns a Claude session, spends tokens), so it deserves a
  // deliberate two-action submit: TAP to start capturing, TAP again to stop +
  // dispatch. Escape (during capture) cancels — which a held push-to-talk key
  // can't offer, since release would submit before there's any moment to cancel.
  // Key-UP is ignored (it's a toggle). Cancel resets remoteActive via resetState()
  // (onSessionEnded), so a cancelled task can't leak its lock into dictation.
  // Mutual exclusion: a task capture can't START while dictation/instruction is
  // active; while a task capture is active, the dictation handlers below bail out.

  private handleRemoteKeyDown(): void {
    // Gate (Pro entitlement + the user's per-session toggle). A capture already
    // in progress is still allowed to STOP — turning the trigger off mid-capture
    // must never strand `remoteActive` and block dictation's mutual exclusion.
    if (!isRemoteTriggerEnabled() && !this.remoteActive) {
      console.log('[keyboard] Remote key ignored — Unmute Remote trigger is off')
      return
    }
    const now = Date.now()
    // Debounce only the START (a too-fast re-tap right after toggling). The STOP
    // tap must always go through so the user can submit/cancel without delay.
    if (!this.remoteActive && now - this.lastRemoteToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Remote toggle DEBOUNCED (too fast)')
      return
    }

    if (this.remoteActive) {
      // Second tap → stop + dispatch.
      this.lastRemoteToggleTime = now
      this.remoteActive = false
      console.log('[keyboard] Remote capture STOP (tap-toggle) → dispatch')
      this.emit('keyboard', { type: 'remote-stop' } as KeyboardEvent)
      return
    }

    // First tap → start. Mutual exclusion with an active dictation/instruction.
    if (this.dictationActive || this.instructionActive) {
      console.log('[keyboard] Remote key ignored — a dictation capture is active (mutual exclusion)')
      return
    }
    this.lastRemoteToggleTime = now
    this.remoteActive = true
    console.log('[keyboard] Remote capture START (tap-toggle)')
    this.emit('keyboard', { type: 'remote-start' } as KeyboardEvent)
  }

  private handleRemoteKeyUp(): void {
    // Tap-toggle ignores key-up — the capture ends on the SECOND tap or on
    // Escape, never on release. (Mirrors dictation tap-toggle.)
  }

  // ─── Dictation key-down/up dispatchers ───

  private handleDictationKeyDown(): void {
    // Mutual exclusion (PRD §2.4.4): ignore the dictation key while a Remote
    // capture is in progress.
    if (this.remoteActive) {
      console.log('[keyboard] Dictation key ignored — a Remote capture is active (mutual exclusion)')
      return
    }
    switch (this.activationMode) {
      case 'tap-toggle':
        this.handleTapToggleDown()
        break
      case 'push-to-talk':
        this.handlePushToTalkDown()
        break
      case 'double-tap-push':
        this.handleDualModeDown()
        break
    }
  }

  private handleDictationKeyUp(): void {
    switch (this.activationMode) {
      case 'tap-toggle':
        // Tap-toggle ignores key-up
        break
      case 'push-to-talk':
        this.handlePushToTalkUp()
        break
      case 'double-tap-push':
        this.handleDualModeUp()
        break
    }
  }

  // ─── Tap-toggle mode ───

  private handleTapToggleDown(): void {
    const now = Date.now()
    if (!this.dictationActive && now - this.lastDictationToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Dictation toggle DEBOUNCED (too fast)')
      return
    }
    this.lastDictationToggleTime = now

    if (this.dictationActive) {
      this.stopDictation()
    } else {
      this.startDictation()
    }
  }

  // ─── Push-to-talk mode ───

  private handlePushToTalkDown(): void {
    const now = Date.now()
    if (this.dictationActive) return
    if (now - this.lastDictationToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Push-to-talk DEBOUNCED (too fast)')
      return
    }
    this.lastDictationToggleTime = now
    this.startDictation()
  }

  private handlePushToTalkUp(): void {
    if (this.dictationActive) {
      this.stopDictation()
    }
  }

  // ─── Double-tap-push (dual) mode state machine ───

  private handleDualModeDown(): void {
    const now = Date.now()

    switch (this.dualState) {
      case 'idle': {
        if (now - this.lastDictationToggleTime < this.DEBOUNCE_MS) {
          console.log('[keyboard] Dual mode DEBOUNCED (too fast)')
          return
        }
        this.lastDictationToggleTime = now
        this.dualState = 'held'
        console.log('[keyboard] Dual mode: idle → held')
        this.dualHoldTimer = setTimeout(() => {
          this.dualHoldTimer = null
          if (this.dualState === 'held') {
            this.dualState = 'push-recording'
            console.log('[keyboard] Dual mode: held → push-recording (hold expired, starting dictation)')
            this.startDictation()
          }
        }, this.DUAL_HOLD_MS)
        break
      }
      case 'awaiting-second': {
        this.clearDualTimers()
        this.dualState = 'hands-free'
        console.log('[keyboard] Dual mode: awaiting-second → hands-free (double-tap, starting dictation)')
        this.startDictation()
        break
      }
      case 'hands-free': {
        console.log('[keyboard] Dual mode: hands-free → idle (tap to stop)')
        this.dualState = 'idle'
        this.stopDictation()
        break
      }
      default:
        break
    }
  }

  private handleDualModeUp(): void {
    switch (this.dualState) {
      case 'held': {
        this.clearDualTimers()
        this.dualState = 'awaiting-second'
        console.log('[keyboard] Dual mode: held → awaiting-second')
        this.dualDoubleTapTimer = setTimeout(() => {
          this.dualDoubleTapTimer = null
          if (this.dualState === 'awaiting-second') {
            console.log('[keyboard] Dual mode: awaiting-second → idle (double-tap window expired)')
            this.dualState = 'idle'
          }
        }, this.DUAL_DOUBLE_TAP_MS)
        break
      }
      case 'push-recording': {
        console.log('[keyboard] Dual mode: push-recording → idle (released, stopping dictation)')
        this.dualState = 'idle'
        this.stopDictation()
        break
      }
      case 'hands-free':
        break
      default:
        break
    }
  }

  private clearDualTimers(): void {
    if (this.dualHoldTimer) {
      clearTimeout(this.dualHoldTimer)
      this.dualHoldTimer = null
    }
    if (this.dualDoubleTapTimer) {
      clearTimeout(this.dualDoubleTapTimer)
      this.dualDoubleTapTimer = null
    }
  }

  // ─── Shared dictation start/stop helpers ───

  private startDictation(): void {
    if (this.instructionActive) {
      this.instructionActive = false
      console.log('[keyboard] Instruction STOPPED (direct chain to dictation)')
      this.emit('keyboard', { type: 'session-stop', mode: 'instruction' } as KeyboardEvent)

      this.dictationActive = true
      console.log('[keyboard] Dictation CHAIN-START (direct)')
      this.emit('keyboard', { type: 'chain-start', mode: 'dictation' } as KeyboardEvent)
      return
    }

    this.clearChainTimer()

    const chainResult = this.wasChainPending('dictation')
    if (chainResult === 'chain') {
      this.dictationActive = true
      console.log('[keyboard] Dictation CHAIN-START')
      this.emit('keyboard', { type: 'chain-start', mode: 'dictation' } as KeyboardEvent)
    } else if (chainResult === 'same-mode-restart') {
      console.log('[keyboard] Same-mode re-press — expiring chain immediately (process now)')
      this.emit('keyboard', { type: 'chain-expired' } as KeyboardEvent)
    } else {
      this.dictationActive = true
      console.log('[keyboard] Dictation SESSION-START')
      this.emit('keyboard', { type: 'session-start', mode: 'dictation' } as KeyboardEvent)
    }
  }

  private stopDictation(): void {
    this.dictationActive = false
    console.log('[keyboard] Dictation STOPPED')
    this.emit('keyboard', { type: 'session-stop', mode: 'dictation' } as KeyboardEvent)
    console.log('[keyboard] Dictation done — processing immediately (no chain wait)')
    this.emit('keyboard', { type: 'chain-expired' } as KeyboardEvent)
  }

  // ─── Instruction toggle (Caps Lock) ───

  private handleInstructionToggle(): void {
    // Mutual exclusion (PRD §2.4.4): ignore the instruction (Caps) key while a
    // Remote capture is in progress. ADDITIVE guard.
    if (this.remoteActive) {
      console.log('[keyboard] Instruction key ignored — a Remote capture is active (mutual exclusion)')
      return
    }
    const now = Date.now()
    if (now - this.lastInstructionToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Instruction toggle DEBOUNCED (too fast)')
      return
    }
    this.lastInstructionToggleTime = now

    if (this.instructionActive) {
      this.instructionActive = false
      console.log('[keyboard] Instruction STOPPED')
      this.emit('keyboard', { type: 'session-stop', mode: 'instruction' } as KeyboardEvent)
      console.log('[keyboard] Instruction done — processing immediately (no chain wait)')
      this.emit('keyboard', { type: 'chain-expired' } as KeyboardEvent)
      return
    }

    if (this.dictationActive) {
      this.dictationActive = false
      console.log('[keyboard] Dictation STOPPED (direct chain to instruction)')
      this.emit('keyboard', { type: 'session-stop', mode: 'dictation' } as KeyboardEvent)

      this.instructionActive = true
      console.log('[keyboard] Instruction CHAIN-START (direct)')
      this.emit('keyboard', { type: 'chain-start', mode: 'instruction' } as KeyboardEvent)
      return
    }

    this.clearChainTimer()

    const chainResult = this.wasChainPending('instruction')
    if (chainResult === 'chain') {
      this.instructionActive = true
      console.log('[keyboard] Instruction CHAIN-START')
      this.emit('keyboard', { type: 'chain-start', mode: 'instruction' } as KeyboardEvent)
    } else if (chainResult === 'same-mode-restart') {
      console.log('[keyboard] Same-mode re-press — expiring chain immediately (process now)')
      this.emit('keyboard', { type: 'chain-expired' } as KeyboardEvent)
    } else {
      this.instructionActive = true
      console.log('[keyboard] Instruction SESSION-START')
      this.emit('keyboard', { type: 'session-start', mode: 'instruction' } as KeyboardEvent)
    }
  }

  // ─── Chain timer ───

  private clearChainTimer(): void {
    if (this.chainTimer) {
      clearTimeout(this.chainTimer)
      this.chainTimer = null
    }
  }

  /**
   * Check if a chain was pending and what kind of transition this is.
   *  - 'none': no chain was pending — start fresh session
   *  - 'chain': cross-mode chain (e.g. dictation → instruction) — chain into same session
   *  - 'same-mode-restart': same-mode re-press — process old, start new
   */
  private wasChainPending(newMode: SessionMode): 'none' | 'chain' | 'same-mode-restart' {
    const was = this._chainPending
    const prevMode = this._chainMode
    this._chainPending = false
    this._chainMode = null

    if (!was) return 'none'

    if (prevMode === newMode) {
      console.log('[keyboard] Same-mode re-press during chain window (', newMode, '→', newMode, ')')
      return 'same-mode-restart'
    }

    return 'chain'
  }
}

export const keyboardManager = new KeyboardManager()
