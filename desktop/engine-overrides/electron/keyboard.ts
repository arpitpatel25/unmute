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
// Persistent, always-on log for the notes key specifically — console.log
// alone (used throughout this file for every OTHER key) only survives while
// DevTools/Console.app happens to be open, which made "what exactly did the
// key do, and when" undiagnosable after the fact. Same-directory import
// (both live in engine-overrides/electron/), so it resolves identically pre-
// and post-wire — no cross-tree hazard the way this file's own
// './paywall/remote/capture/agentGesture' import has.
import { createNotetakerLogger } from './notetaker/notetakerLog'
// Where a live capture is headed, and what a lane key press means while one is
// already running. Same-directory import (both live in engine-overrides/
// electron/), so it resolves identically pre- and post-wire — unlike this
// file's own './paywall/remote/capture/agentGesture' import, which only
// resolves after the copy.
import { decidePress, routeOfLanes, type CaptureRoute } from './captureRoute'

export type { CaptureRoute } from './captureRoute'

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
  // ─── The live capture changed lanes — NOT a lifecycle event ───
  // Emitted when a lane key is pressed while a DIFFERENT lane is recording.
  // The recording continues untouched; only its destination moves. There is
  // deliberately no matching stop/start pair: a switch that ended one capture
  // and began another would lose the audio already spoken, which is the entire
  // thing this exists to prevent.
  | { type: 'capture-route'; route: CaptureRoute }
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
  // ─── The pocket chord — right Command held, right Option tapped ───
  // NOT a capture lane. It carries no audio, holds no state here and is
  // mutually exclusive with nothing: it opens the pocket, and pressed again it
  // expands the card the pocket is on. The native listener has already decided
  // this is a chord and has withheld the Remote key's own down/up, so this
  // arrives as one event with no lifecycle to pair it with.
  | { type: 'pocket-chord' }

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
  /** Some OTHER key (or modifier) arrived while left-Control was held — see
   *  the notes-chord-spoil block in listener.mm. */
  | 'notes-chord-spoil'

// Module-level, not per-instance: every KeyboardManager in a test file gets
// its own instance, but they should all still log to the same run's file
// (createNotetakerLogger is itself idempotent per component name — see its
// own module-level RUN_ID/logFilePath caching).
const notesLog = createNotetakerLogger('keyboard')

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

  // ─── Is the Unmute Agent usable right now? ───
  // Pushed in by the paywall layer (init.ts owns the setting), the same
  // inversion remoteTriggerGate uses for the Orchestrator's entitlement —
  // this file asks a question, it never reads paywall state.
  //
  // IT IS CHECKED BEFORE THE LANE LATCHES, and that is the point. The check
  // used to live only in init.ts, on the agent-start it received — by which
  // time this file had already set `agentActive = true`. An unavailable Agent
  // therefore left the lane locked with no capture behind it and no session
  // whose ending could clear it, so right-Option stayed refused until some
  // unrelated dictation happened to run resetState. Asking first makes that
  // state unreachable rather than merely unlikely.
  private unmuteAgentAvailable = false

  /**
   * Which lane OPENED the live capture — not where it is going now.
   *
   * The route moves; this does not. It answers one question: does finishing
   * this capture need the remote-shaped stop (release the held modifier, grab
   * the selection, then process) or the plain dictation one? That shape
   * belongs to the key that is physically held, so a capture opened on
   * right-Option and submitted on fn after a switch still has to take it —
   * otherwise the deferred selection grab never happens and the
   * select-text→command flow silently loses its input.
   *
   * Null whenever nothing is recording.
   */
  private openedLane: CaptureRoute | null = null

  // Double-tap-push (dual mode) state
  private dualState: DualModeState = 'idle'
  private dualHoldTimer: NodeJS.Timeout | null = null
  private dualDoubleTapTimer: NodeJS.Timeout | null = null
  private readonly DUAL_HOLD_MS = 400
  private readonly DUAL_DOUBLE_TAP_MS = 400

  // Chain tracking
  private _chainPending = false
  private _chainMode: SessionMode | null = null

  // ─── Meeting Notetaker (left-Control, double-tap start / double-tap stop) ───
  // DELIBERATELY NOT part of the dictation/instruction/agent/remote lock
  // group above, and DELIBERATELY not read or written by any of their
  // mutual-exclusion guards. Notes must never block, and never be blocked
  // by, those four lanes (spec §5) — so its state lives in its own section.
  //
  // Same GestureState tap-recogniser right-Command already uses for the
  // Agent (agentGesture.ts) — reused rather than re-derived, because it is
  // what correctly waits for the key to come back UP, with nothing else
  // pressed in between, before counting a press as a genuine tap. A naive
  // "act on key-down" check cannot do that: Ctrl+C typed while a meeting is
  // running would stop it the instant Control goes down, before the C ever
  // arrives to spoil it.
  private notesActive = false
  private notesGesture: GestureState = freshGestureState()
  /** When the first tap of a pending start-pair landed. 0 = none. */
  private lastNotesTapAt = 0
  private lastNotesToggleTime = 0

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
      // The derived answer, beside the flags it comes from — a switch is then
      // one field moving in a line you can read straight through, rather than
      // three booleans a reader has to recombine.
      route: this.liveRoute(),
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
    this.openedLane = null
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
    this.openedLane = null
    this.emitKeyState('reset-state')
  }

  setChainWindow(ms: number): void {
    this.chainWindowMs = ms
  }

  /** Pushed by the paywall layer whenever the Agent's availability changes. */
  setUnmuteAgentAvailable(value: boolean): void {
    this.unmuteAgentAvailable = value === true
    console.log('[keyboard] Unmute Agent available:', this.unmuteAgentAvailable)
  }

  /**
   * Which lane is recording right now.
   *
   * A READ of the four booleans, never a fifth field beside them. Those flags
   * are entangled with the chain timer, the Caps Lock chain and the dual-mode
   * state machine; a parallel `activeRoute` would be one more pair of things
   * that can disagree, and every transition bug in this file has had exactly
   * that shape.
   */
  private liveRoute(): CaptureRoute | null {
    return routeOfLanes({
      dictation: this.dictationActive,
      remote: this.remoteActive,
      agent: this.agentActive,
    })
  }

  /**
   * Move the live capture to another lane.
   *
   * THE ONLY PLACE ALL THREE FLAGS MOVE TOGETHER, so "at most one lane is
   * live" is enforced by one assignment block rather than asserted at four
   * call sites. It emits `capture-route` and nothing else: no session-stop, no
   * session-start, no chain event. Nothing is ending, so nothing may be torn
   * down — the recorder, the session, the open capture segment and the
   * scratchpad all carry straight through.
   */
  private applyRouteSwitch(to: CaptureRoute): void {
    const from = this.liveRoute()
    this.dictationActive = to === 'cursor'
    this.remoteActive = to === 'task'
    this.agentActive = to === 'agent'
    // A pending FIRST tap of an Agent double-tap belongs to the gesture that
    // has just been resolved. Left set, it could pair with an unrelated later
    // tap and arm something the user never asked for.
    this.lastAgentTapAt = 0
    console.log('[keyboard] Capture route SWITCH:', from, '→', to)
    this.emit('keyboard', { type: 'capture-route', route: to } as KeyboardEvent)
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
      case 'pocket-chord':
        // DELIBERATELY STATELESS. Every other key here owns a capture and has
        // to be reconciled with the others — dictation blocks Remote, Remote
        // blocks dictation, the Agent spoils on a chord. This one records
        // nothing and blocks nothing, because opening a surface is not a
        // capture. Note the Agent has already stood down on its own: right
        // Option joining right Command emits right-command-chord above.
        console.log('[keyboard] pocket chord (right Command + right Option)')
        this.emit('keyboard', { type: 'pocket-chord' } as KeyboardEvent)
        break
      case 'caps-down':
      case 'caps-up':
        // Caps Lock is a toggle key — macOS alternates between CAPS_DOWN and CAPS_UP
        // on each physical press (reflecting LED state, not press/release).
        // So both events represent a physical key press → treat both as toggle.
        this.handleInstructionToggle()
        break
      // ─── Meeting Notetaker — independent of every lane above ───
      case 'left-control-down':
        this.feedNotesGesture('down')
        break
      case 'left-control-up':
        this.feedNotesGesture('up')
        break
      case 'notes-chord-spoil':
        this.feedNotesGesture('other')
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
    const now = Date.now()
    const gateOn = isRemoteTriggerEnabled()
    // ONE DECISION, IN A PURE MODULE. The four inline branches this replaces —
    // gate, debounce, stop, exclusion — each answered a piece of "what does
    // this press mean", and the exclusion one answered it wrongly for the case
    // this feature is about: another lane being live now moves the capture
    // here instead of refusing it.
    const action = decidePress({
      lane: 'task',
      live: this.liveRoute(),
      instructionActive: this.instructionActive,
      activationMode: this.activationMode,
      // A capture already in progress is still allowed to STOP — decidePress
      // answers `submit` above every gate, so turning the trigger off
      // mid-capture can never strand `remoteActive`.
      laneAvailable: gateOn,
    })

    if (action === 'submit') {
      this.lastRemoteToggleTime = now
      this.remoteActive = false
      this.openedLane = null
      console.log('[keyboard] Remote capture STOP (tap-toggle) → dispatch')
      this.emit('keyboard', { type: 'remote-stop' } as KeyboardEvent)
      return
    }

    if (action === 'ignore') {
      if (!gateOn) {
        console.log('[keyboard] Remote key ignored — Unmute Remote trigger is off')
        return
      }
      console.log('[keyboard] Remote key ignored — another capture is active (mutual exclusion)')
      this.emit('keyboard', { type: 'remote-ignored', reason: 'capture-already-live' } as KeyboardEvent)
      return
    }

    // Debounce only the START (a too-fast re-tap right after toggling), exactly
    // as before. A SWITCH is deliberately not debounced: it is a press of a
    // DIFFERENT key from the one that opened the capture, so it can never be a
    // bounce of this one, and rate-limiting it would break the whole promise
    // that you may change your mind as often as you like.
    if (action === 'start' && now - this.lastRemoteToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Remote toggle DEBOUNCED (too fast)')
      return
    }

    this.lastRemoteToggleTime = now
    if (action === 'switch') {
      this.applyRouteSwitch('task')
      return
    }
    this.remoteActive = true
    this.openedLane = 'task'
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

    // 2 · STOP FIRST — a single clean tap ends a running Agent capture.
    //     Still ahead of everything, still unconditional.
    if (this.agentActive) {
      this.lastAgentToggleTime = now
      this.agentActive = false
      this.lastAgentTapAt = 0
      this.openedLane = null
      console.log('[keyboard] Agent capture STOP (single tap) → dispatch')
      this.emit('keyboard', { type: 'agent-stop' } as KeyboardEvent)
      return
    }

    // 3 · debounce the START only — and a START is only possible when nothing
    //     is recording. With another lane live this press is a SWITCH, and
    //     this lane's own toggle history has no bearing on it.
    //
    //     THE DEBOUNCE HAD TO MOVE, and the bug it caused is the one this
    //     whole feature is most at risk of: switch into the Agent, switch
    //     away, and switch back inside 300ms, and `lastAgentToggleTime` was
    //     still warm from the first switch — so the check fired above the tap
    //     pairing and ate BOTH taps. Nothing latched, nothing was logged, and
    //     the key simply did nothing. Caught by keyboard.lanes.test.ts.
    const live = this.liveRoute()
    if (live === null && now - this.lastAgentToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Agent toggle DEBOUNCED (too fast)')
      return
    }

    // 5a · pair the taps. A lone tap is remembered, not acted on.
    //
    //      THE PAIRING GUARDS THE SWITCH TOO. Entering a lane always costs
    //      that lane's own start gesture, so moving a live dictation to the
    //      Agent takes two taps, exactly as starting one from cold does. Only
    //      LEAVING is a single tap, because by then this is the live lane.
    const paired = this.lastAgentTapAt > 0 && now - this.lastAgentTapAt <= DOUBLE_TAP_WINDOW_MS
    if (!paired) {
      this.lastAgentTapAt = now
      return
    }
    this.lastAgentTapAt = 0

    // 4 · start or switch — decided once, in captureRoute.ts.
    const action = decidePress({
      lane: 'agent',
      live,
      instructionActive: this.instructionActive,
      activationMode: this.activationMode,
      laneAvailable: this.unmuteAgentAvailable,
    })
    if (action === 'ignore') {
      console.log('[keyboard] Agent gesture ignored —',
        this.unmuteAgentAvailable ? 'another capture is active (mutual exclusion)' : 'the Agent is unavailable')
      this.emit('keyboard', {
        type: 'agent-ignored',
        reason: this.unmuteAgentAvailable ? 'capture-already-live' : 'not-available',
      } as KeyboardEvent)
      return
    }
    if (action === 'switch') {
      this.lastAgentToggleTime = now
      this.applyRouteSwitch('agent')
      return
    }

    // 5b · start
    this.lastAgentToggleTime = now
    this.agentActive = true
    this.openedLane = 'agent'
    console.log('[keyboard] Agent capture START (double tap)')
    this.emit('keyboard', { type: 'agent-start' } as KeyboardEvent)
  }

  private handleRemoteKeyUp(): void {
    // Tap-toggle ignores key-up — the capture ends on the SECOND tap or on
    // Escape, never on release. (Mirrors dictation tap-toggle.)
  }

  // ─── Meeting Notetaker — left-Control, double-tap start / double-tap end ───
  //
  // Fed by left-control-down/up and notes-chord-spoil (an event pressed
  // while Control is held — see listener.mm). recogniseTap does the actual
  // work: it only reports a tap once the key has gone back UP with nothing
  // else pressed in between, which is what makes a Ctrl+C typed while a
  // meeting is running spoil the gesture instead of stopping it the instant
  // Control goes down (see the class-level comment on `notesGesture`).
  //
  // The gesture is symmetric: double-tap starts when idle and ends when
  // recording. A single tap is harmless; it only records the first half of
  // a possible pair.
  //
  // NO EXCLUSION CHECK, ON PURPOSE (spec §5): dictationActive/
  // instructionActive/agentActive/remoteActive are never read here, and
  // notesActive is never read by their guards either — the note-taker is a
  // fully independent lane.
  private feedNotesGesture(kind: GestureEventKind): void {
    const before = this.notesGesture
    const result = recogniseTap(this.notesGesture, { kind, at: Date.now() })
    this.notesGesture = result.state
    // Every raw left-Control event, logged BEFORE any decision below — this
    // is the "what button, when" record: kind is 'down'/'up'/'other' (a
    // spoiling key or modifier), heldBefore/heldAfter and spoiledBefore/
    // spoiledAfter show exactly how the hold's state moved, and `tap` is
    // whether this event completed a clean tap at all (most 'down'/'other'
    // events won't — only a clean 'up' can).
    notesLog.debug('raw key event', {
      kind,
      heldBefore: before.held,
      spoiledBefore: before.spoiled,
      heldAfter: this.notesGesture.held,
      spoiledAfter: this.notesGesture.spoiled,
      tap: result.tap,
      notesActive: this.notesActive,
    })
    if (!result.tap) return

    const now = Date.now()

    // End also requires a pair. This avoids a single Control press ending a
    // meeting while preserving the same muscle-memory gesture for both
    // transitions.
    if (this.notesActive) {
      const paired = this.lastNotesTapAt > 0 && now - this.lastNotesTapAt <= DOUBLE_TAP_WINDOW_MS
      if (!paired) {
        this.lastNotesTapAt = now
        notesLog.event('tap-1-of-2-end-recorded', { at: now })
        return
      }
      const msBetweenTaps = now - this.lastNotesTapAt
      this.lastNotesToggleTime = now
      this.lastNotesTapAt = 0
      console.log('[keyboard] Notes STOP (double tap)')
      notesLog.event('tap-stop-emitted', { at: now, msBetweenTaps })
      this.emit('notes-stop-requested')
      return
    }

    // Debounce only the START.
    if (now - this.lastNotesToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Notes toggle DEBOUNCED (too fast)')
      notesLog.event('tap-debounced', { at: now, msSinceLastToggle: now - this.lastNotesToggleTime })
      return
    }

    // Pair the taps. A lone tap is remembered, not acted on. Reset to 0 (not
    // left at `now`) once consumed — see feedAgentGesture's own comment on
    // why, same shape here.
    const paired = this.lastNotesTapAt > 0 && now - this.lastNotesTapAt <= DOUBLE_TAP_WINDOW_MS
    if (!paired) {
      this.lastNotesTapAt = now
      notesLog.event('tap-1-of-2-recorded', { at: now })
      return
    }
    const msBetweenTaps = now - this.lastNotesTapAt
    this.lastNotesTapAt = 0

    this.lastNotesToggleTime = now
    this.notesActive = true
    console.log('[keyboard] Notes START (double tap)')
    notesLog.event('tap-start-emitted', { at: now, msBetweenTaps })
    this.emit('notes-start-requested')
  }

  /** Called by the owning module once a stop has actually happened — either
   *  the automatic confirm-dialog flow (onMeetingEnded) or this key's own
   *  double-tap stop. The ONLY place `notesActive` is cleared back to
   *  false. */
  confirmNotesStop(): void {
    this.notesActive = false
    console.log('[keyboard] Notes STOPPED (confirmed)')
    notesLog.event('notes-stopped-confirmed', { at: Date.now() })
    this.emit('notes-stopped')
  }

  // ─── Dictation key-down/up dispatchers ───

  private handleDictationKeyDown(): void {
    // Mutual exclusion (PRD §2.4.4) — for the HELD modes only.
    //
    // Tap-toggle now routes through decidePress, which moves a live task or
    // agent capture to the cursor instead of refusing the key. Push-to-talk
    // and double-tap-push keep the old refusal untouched: fn is physically
    // held for the duration there, so "the key that submits" is a release
    // rather than a press, and the tap-toggle symmetry a switch relies on does
    // not exist. See captureRoute.ts.
    if (this.activationMode !== 'tap-toggle' && this.remoteActive) {
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
    const action = decidePress({
      lane: 'cursor',
      live: this.liveRoute(),
      instructionActive: this.instructionActive,
      activationMode: this.activationMode,
      // Dictation has no gate, and deliberately so: it is the user's way out
      // when another lane is wedged, so nothing may make it unavailable.
      laneAvailable: true,
    })

    // Debounce the START only — a submit must always go through, and a SWITCH
    // is a press of a different key from the one that opened the capture.
    if (action === 'start' && now - this.lastDictationToggleTime < this.DEBOUNCE_MS) {
      console.log('[keyboard] Dictation toggle DEBOUNCED (too fast)')
      return
    }
    this.lastDictationToggleTime = now

    // `ignore` here can only be Instruct owning the mic. Every other lane is
    // now a switch rather than a refusal.
    if (action === 'ignore') {
      console.log('[keyboard] Dictation key ignored — Instruct owns the capture')
      return
    }
    if (action === 'switch') {
      this.applyRouteSwitch('cursor')
      return
    }
    if (action === 'submit') {
      this.stopDictation()
      return
    }
    this.startDictation()
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
      this.openedLane = 'cursor'
      console.log('[keyboard] Dictation CHAIN-START (direct)')
      this.emit('keyboard', { type: 'chain-start', mode: 'dictation' } as KeyboardEvent)
      return
    }

    this.clearChainTimer()

    const chainResult = this.wasChainPending('dictation')
    if (chainResult === 'chain') {
      this.dictationActive = true
      this.openedLane = 'cursor'
      console.log('[keyboard] Dictation CHAIN-START')
      this.emit('keyboard', { type: 'chain-start', mode: 'dictation' } as KeyboardEvent)
    } else if (chainResult === 'same-mode-restart') {
      console.log('[keyboard] Same-mode re-press — expiring chain immediately (process now)')
      this.emit('keyboard', { type: 'chain-expired' } as KeyboardEvent)
    } else {
      this.dictationActive = true
      this.openedLane = 'cursor'
      console.log('[keyboard] Dictation SESSION-START')
      this.emit('keyboard', { type: 'session-start', mode: 'dictation' } as KeyboardEvent)
    }
  }

  private stopDictation(): void {
    const opened = this.openedLane
    this.dictationActive = false
    this.openedLane = null

    // A CAPTURE OPENED BY A HELD KEY TAKES THE HELD KEY'S STOP, wherever it
    // ended up being addressed. right-Option and right-Command are physically
    // down for the whole capture, so their stop has to release the modifier,
    // settle, and only then synthesise the selection grab — otherwise Cmd+C
    // lands as Cmd+Opt+C and Chrome opens DevTools instead. Submitting such a
    // capture on fn, after switching it to the cursor, still needs that shape:
    // the modifier is a fact about the user's hand, not about where the words
    // are going. init.ts answers 'remote-stop' with the same finishCapture()
    // the other two lanes use.
    if (opened !== null && opened !== 'cursor') {
      console.log('[keyboard] Dictation STOPPED — switched capture, opened on', opened, '→ held-key stop')
      this.emit('keyboard', { type: 'remote-stop' } as KeyboardEvent)
      return
    }

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
