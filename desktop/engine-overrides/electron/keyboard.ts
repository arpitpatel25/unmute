import { EventEmitter } from 'events'
import { keyListener, KeyEvent } from './keyListener'
import {
  DOUBLE_TAP_WINDOW_MS,
  freshGestureState,
  recogniseTap,
  type GestureEventKind,
  type GestureState,
} from './paywall/remote/capture/agentGesture'
// Remote trigger gate (plan entitlement + the user's session toggle). Static
// import on purpose — a lazy require of a relative path dies in the bundled
// main process, and a silently-missing gate would leave Remote ungated.
import { isRemoteTriggerEnabled } from './remoteTriggerGate'

export type SessionMode = 'dictation' | 'instruction'
export type KeyboardEvent =
  | { type: 'session-start'; mode: SessionMode }
  // ─── Unmute Agent — its own key, its own capture ───
  // Right Command. Independent of dictation (fn) and Remote (right Option) so
  // that adding an agent could not change either. Same tap-toggle shape and the
  // same mutual exclusion; only the destination differs.
  | { type: 'agent-start' }
  /** A press that deliberately did nothing, and why. */
  | { type: 'agent-ignored'; reason: string }
  | { type: 'remote-ignored'; reason: string }
  | { type: 'agent-stop' }
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

// ─── Meeting Notetaker chord (Task 6) ───
// keyListener.ts's exported `KeyEvent` union has not been extended yet for
// these two native-layer events (they are emitted by native-fn-listener —
// see desktop/native-fn-listener/src/listener.mm — as of the commit that
// added them, but the TS-level KeyEvent type in keyListener.ts is a
// separate file, out of this task's scope, and still only lists the
// pre-existing keys). The values ARE what arrives at runtime; this local
// union just lets handleKey's switch compare against them without widening
// keyListener's exported type. Whoever finishes wiring the notetaker
// end-to-end should fold these into KeyEvent for real type safety.
type NotesChordKeyEvent =
  | 'left-control-down'
  | 'left-control-up'
  | 'left-option-down'
  | 'left-option-up'
  /** Some OTHER key (or modifier) arrived while both chord keys were held —
   *  see the notes-chord-spoil block in listener.mm. */
  | 'notes-chord-spoil'

// Exported (was module-private) so tests can construct an isolated instance
// instead of sharing the process-wide `keyboardManager` singleton below.
export class KeyboardManager extends EventEmitter {
  private dictationActive = false
  private instructionActive = false
  private agentActive = false
  /** Tap-recognition state only — it holds no opinion about recording. */
  private agentGesture: GestureState = freshGestureState()
  /** When the first tap of a pending pair landed. 0 = none. */
  private lastAgentTapAt = 0
  private lastAgentToggleTime = 0
  private lastAgentToggleTime = 0
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

  // ─── Meeting Notetaker chord (left-Control + left-Option, double-tap) ───
  // DELIBERATELY NOT part of the dictation/instruction/agent/remote lock
  // group above, and DELIBERATELY not read or written by any of their
  // mutual-exclusion guards. Notes must never block, and never be blocked
  // by, those four lanes (spec §5) — so its state lives in its own section,
  // and stopping is never direct (spec §6): a second double-tap while
  // active only requests confirmation; `confirmNotesStop()` is the sole
  // writer that clears `notesActive` back to false.
  private notesActive = false
  private leftControlHeld = false
  private leftOptionHeld = false
  /** When the first tap of a pending chord pair landed. 0 = none. */
  private lastNotesChordTapAt = 0
  /** Another key arrived while the chord was held, so THIS engagement can
   *  never count as a tap — the same "spoiled" concept agentGesture.ts uses
   *  for right-Command (`GestureState.spoiled`). Cleared only when both chord
   *  keys are back up, i.e. when the gesture has genuinely ended. */
  private notesChordSpoiled = false

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

  /**
   * The session says a capture ended — however it ended.
   *
   * THIS IS THE WIRING THAT WAS MISSING. sessionManager fires onSessionEnded
   * from every ending it has: a completed dispatch, a cancel, a too-short
   * capture with no audio, a junk-STT discard. Nothing was ever subscribed to
   * it, so a lane's lock had exactly ONE path to false — its own stop tap.
   *
   * That is why Escape stranded the Agent: the capture died, the flag did not,
   * and mutual exclusion then refused right-Option indefinitely. A single tap
   * later "stopped" a capture that no longer existed, which is where the
   * phantom "processing" came from.
   *
   * DICTATION IS DELIBERATELY NOT CLEARED HERE. It manages its own toggle, and
   * more importantly it is the user's way out: dictation does not consult the
   * other lanes' locks, so it keeps working even when something else is wedged.
   * That escape hatch is now a property to preserve, not an oversight.
   */
  /**
   * EVERY KEY, AND THE STATE IT LEFT BEHIND.
   *
   * Every bug tonight was a state-transition bug, and each cost an hour because
   * the log recorded INTENTIONS ("agent-key start") and never the state that
   * followed. Two lanes disagreed about whether a capture was live and nothing
   * wrote it down.
   *
   * One line per raw key event, emitted after the handlers have run, carrying
   * every flag that decides what the NEXT key does. Verbose on purpose: a
   * sequence you can read straight through beats a theory every time.
   */
  private emitKeyState(trigger: string): void {
    this.emit('keyboard', {
      type: 'key-state',
      trigger,
      dictationActive: this.dictationActive,
      instructionActive: this.instructionActive,
      remoteActive: this.remoteActive,
      agentActive: this.agentActive,
      agentHeld: this.agentGesture.held,
      agentSpoiled: this.agentGesture.spoiled,
      agentPendingTap: this.lastAgentTapAt > 0,
    } as unknown as KeyboardEvent)
  }

  onCaptureEnded(): void {
    if (this.agentActive || this.remoteActive) {
      console.log('[keyboard] capture ended externally — clearing lane locks',
        '(agent:', this.agentActive, 'remote:', this.remoteActive, ')')
    }
    this.agentActive = false
    this.remoteActive = false
    this.agentGesture = freshGestureState()
    this.lastAgentTapAt = 0
    this.emitKeyState('capture-ended')
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
    // AND THE AGENT'S. main.ts calls resetState() from onSessionEnded — every
    // genuine ending the session has, Escape included — and from
    // onSessionRejected. Those are exactly the moments when no capture is live,
    // so this is the right place and always was.
    //
    // I removed this an hour ago believing resetState fired routinely and would
    // clear the lock mid-capture. It does not: it fires when a session ENDS. The
    // belief came from grepping only the source tree — main.ts lives in the
    // copied engine tree, so "nothing ever calls resetState" was half a search.
    this.agentActive = false
    this.agentGesture = freshGestureState()
    this.lastAgentTapAt = 0
    this.emitKeyState('reset-state')
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
    // See NotesChordKeyEvent above for why this cast exists.
    switch (event as KeyEvent | NotesChordKeyEvent) {
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
      case 'right-command-down':
        this.feedAgentGesture('down')
        break
      case 'right-command-up':
        this.feedAgentGesture('up')
        break
      case 'right-command-chord':
        // Another key arrived while right Command was held: this is a
        // shortcut, so it can never be a tap.
        this.feedAgentGesture('other')
        break
      case 'caps-down':
      case 'caps-up':
        // Caps Lock is a toggle key — macOS alternates between CAPS_DOWN and CAPS_UP
        // on each physical press (reflecting LED state, not press/release).
        // So both events represent a physical key press → treat both as toggle.
        this.handleInstructionToggle()
        break
      // ─── Meeting Notetaker chord — independent of every lane above ───
      case 'left-control-down':
        this.leftControlHeld = true
        this.maybeHandleNotesChordDown()
        break
      case 'left-control-up':
        this.leftControlHeld = false
        this.clearNotesChordSpoilIfReleased()
        break
      case 'left-option-down':
        this.leftOptionHeld = true
        this.maybeHandleNotesChordDown()
        break
      case 'left-option-up':
        this.leftOptionHeld = false
        this.clearNotesChordSpoilIfReleased()
        break
      case 'notes-chord-spoil':
        // Anything else pressed while the chord is held: this is VoiceOver
        // navigation or another Ctrl+Opt shortcut, not a request to record.
        // Kill both the current engagement AND any pending first tap, so two
        // engagements with real work between them cannot pair into a
        // double-tap.
        this.notesChordSpoiled = true
        this.lastNotesChordTapAt = 0
        break
    }
    // AFTER the handlers have run: exactly what the NEXT key will see.
    this.emitKeyState(event)
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

    // First tap → start. Mutual exclusion against EVERY other lane.
    //
    // `agentActive` was missing here while the Agent path already checked
    // `remoteActive`, and that asymmetry is exactly how two captures came to be
    // armed one second apart on 18 August: the Agent key armed one, the Remote
    // key armed another on top of it, and ownership of the utterance was
    // decided seventy seconds later by whichever flag had survived.
    if (this.dictationActive || this.instructionActive || this.agentActive) {
      console.log('[keyboard] Remote key ignored — another capture is active (mutual exclusion)')
      this.emit('keyboard', { type: 'remote-ignored', reason: 'capture-already-live' } as KeyboardEvent)
      return
    }
    this.lastRemoteToggleTime = now
    this.remoteActive = true
    console.log('[keyboard] Remote capture START (tap-toggle)')
    this.emit('keyboard', { type: 'remote-start' } as KeyboardEvent)
  }

  /** Right Command — start/stop a capture addressed at the Unmute Agent.
   *
   *  Deliberately a separate flag from `remoteActive`: an agent capture and a
   *  task capture are different addresses, and sharing one flag would let
   *  either key stop the other's recording. */
  /**
   * The Agent key, ordered exactly like right-Option — the lane that has never
   * wedged. Only the gesture differs: two taps to start, one to submit.
   *
   *   1. STOP FIRST  already recording? then this tap ends it. Return.
   *   2. debounce    guards the START only; a stop must always go through.
   *   3. exclusion   only now consider the other lanes.
   *   4. START       second clean tap inside the window.
   *
   * STOPPING BEFORE EXCLUSION IS THE WHOLE PROPERTY. Once a capture is live, the only
   * thing this key can do is end it — no gate, no exclusion, nothing can stand
   * between the user and stopping their own capture. That is why a stuck lock on
   * right-Option has never been reachable, and why the Agent lane wedged when I
   * checked exclusion first and never checked `agentActive` at all.
   *
   * ONE WRITER. `agentActive` is set and cleared here and nowhere else. A second
   * writer (I had added one in resetState) is how a lock gets cleared underneath
   * a live capture, which let both lanes record at once.
   */
  private feedAgentGesture(kind: GestureEventKind): void {
    const result = recogniseTap(this.agentGesture, { kind, at: Date.now() })
    this.agentGesture = result.state
    if (!result.tap) return

    const now = Date.now()

    // 1 · gate — the Agent's availability is checked where it is owned, in
    // init.ts on agent-start. Nothing to gate here.

    // 2 · STOP FIRST — a single clean tap ends a running capture.
    if (this.agentActive) {
      this.lastAgentToggleTime = now
      this.agentActive = false
      this.lastAgentTapAt = 0
      console.log('[keyboard] Agent capture STOP (single tap) → dispatch')
      this.emit('keyboard', { type: 'agent-stop' } as KeyboardEvent)
      return
    }

    // 3 · debounce the START only.
    if (now - this.lastAgentToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Agent toggle DEBOUNCED (too fast)')
      return
    }

    // 5a · pair the taps. A lone tap is remembered, not acted on.
    const paired = this.lastAgentTapAt > 0 && now - this.lastAgentTapAt <= DOUBLE_TAP_WINDOW_MS
    if (!paired) {
      this.lastAgentTapAt = now
      return
    }
    this.lastAgentTapAt = 0

    // 4 · exclusion — only once we know this is a start.
    if (this.dictationActive || this.instructionActive || this.remoteActive) {
      console.log('[keyboard] Agent gesture ignored — another capture is active (mutual exclusion)')
      this.emit('keyboard', { type: 'agent-ignored', reason: 'capture-already-live' } as KeyboardEvent)
      return
    }

    // 5b · start
    this.lastAgentToggleTime = now
    this.agentActive = true
    console.log('[keyboard] Agent capture START (double tap)')
    this.emit('keyboard', { type: 'agent-start' } as KeyboardEvent)
  }

  private handleRemoteKeyUp(): void {
    // Tap-toggle ignores key-up — the capture ends on the SECOND tap or on
    // Escape, never on release. (Mirrors dictation tap-toggle.)
  }

  // ─── Meeting Notetaker — chord double-tap (left-Control + left-Option) ───
  //
  // Both native events (left-control-down, left-option-down) call this;
  // it bails until BOTH modifiers are held together, so it's direction-
  // independent (either key can complete the chord).
  //
  // Pairing mirrors feedAgentGesture's own tap-pairing above, including the
  // part the brief for this task's sketch got wrong: `lastNotesChordTapAt`
  // must be RESET to 0 once a pair has been consumed into a toggle, not set
  // to `now`. Leaving it set to `now` after a toggle makes the very next
  // chord-engage (e.g. the next double-tap the user performs) pair against
  // the toggle that just fired, rather than starting a fresh pair — which
  // in a synchronous test (or just fast typing) turns one double-tap into
  // two toggles. `feedAgentGesture` already avoids this (`lastAgentTapAt = 0`
  // right before it acts); this follows the same shape.
  //
  // NO EXCLUSION CHECK, ON PURPOSE (spec §5): dictationActive/
  // instructionActive/agentActive/remoteActive are never read here, and
  // notesActive is never read by their guards either — the note-taker is a
  // fully independent lane.
  private maybeHandleNotesChordDown(): void {
    if (!this.leftControlHeld || !this.leftOptionHeld) return // both must be down together
    // SPOILED ENGAGEMENTS ARE NOT TAPS (spec §6's spirit, and a real privacy
    // concern): left-Control+left-Option is macOS's OWN VoiceOver modifier.
    // A VoiceOver user re-engages this exact pair constantly during normal
    // navigation, and without this check two of those engagements landing
    // inside DOUBLE_TAP_WINDOW_MS would start a system-audio recording — and
    // raise its TCC prompt — that nobody asked for. Same rule agentGesture.ts
    // applies to right-Command: a hold with any other key in it is a
    // shortcut, never a tap.
    if (this.notesChordSpoiled) {
      console.log('[keyboard] Notes chord engage IGNORED — spoiled by another key (shortcut, not a tap)')
      return
    }
    const now = Date.now()

    const paired = this.lastNotesChordTapAt > 0 && now - this.lastNotesChordTapAt <= DOUBLE_TAP_WINDOW_MS
    if (!paired) {
      this.lastNotesChordTapAt = now
      return
    }
    this.lastNotesChordTapAt = 0

    if (this.notesActive) {
      // Spec §6: never stop directly — the confirm-dialog flow (owned
      // elsewhere, out of scope for this task) decides whether to call
      // confirmNotesStop().
      console.log('[keyboard] Notes chord double-tap while active — requesting stop confirmation')
      this.emit('notes-stop-confirm-requested')
      return
    }

    this.notesActive = true
    console.log('[keyboard] Notes chord double-tap — START')
    this.emit('notes-start-requested')
  }

  /** The spoil lasts until the gesture genuinely ends — BOTH chord keys back
   *  up. Clearing it on the first release instead would hand the spoil back
   *  the moment a VoiceOver user lifts one key mid-navigation, which is
   *  exactly when they are most likely to press it again. */
  private clearNotesChordSpoilIfReleased(): void {
    if (!this.leftControlHeld && !this.leftOptionHeld) this.notesChordSpoiled = false
  }

  /** Called by the owning module once the user has confirmed they want to
   *  stop (spec §6). The ONLY place `notesActive` is cleared back to false —
   *  a double-tap while active never clears it directly. */
  confirmNotesStop(): void {
    this.notesActive = false
    console.log('[keyboard] Notes STOPPED (confirmed)')
    this.emit('notes-stopped')
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
