// captureRoute — where an utterance is going, and what a key press means while
// one is already being recorded.
//
// THE OLD RULE, AND WHY IT CHANGED. A capture's destination used to be welded
// to the key that started it, at the instant it was pressed: fn typed at the
// cursor, right-Option dispatched a task, right-Command addressed the Agent,
// and pressing any of the other two mid-capture was simply refused ("another
// capture is active"). That refusal was correct while a capture and a key were
// the same object. They are not: people change their mind about where an
// utterance should go while they are still saying it, and re-dictating a
// paragraph because you pressed the wrong key first is the whole cost of
// getting that wrong.
//
// So the route is now LATE-BOUND. A press on a lane that is not the live one
// SWITCHES the running capture to that lane — no stop, no restart, not a
// syllable lost — and only a press on the lane that IS live submits.
//
// PURE by construction (no electron, no clock, no state of its own), so the
// whole decision is a table a test can hold. Same house style as vadPolicy and
// correctionGate.

/** Where a capture is headed. The same three values `Destination` uses in
 *  capture/types.ts, deliberately — the pad's origin and the capture's route
 *  are one vocabulary, not two that have to be kept in step. */
export type CaptureRoute = 'cursor' | 'task' | 'agent'

export type PressAction =
  /** Nothing was recording; open a capture on this lane. */
  | 'start'
  /** This lane is the live one; finish and deliver. */
  | 'submit'
  /** Another lane is live; move it here, keeping the recording. */
  | 'switch'
  /** Do nothing at all. */
  | 'ignore'

export type ActivationModeLike = 'tap-toggle' | 'push-to-talk' | 'double-tap-push'

export interface PressContext {
  /** The lane whose key was pressed. */
  lane: CaptureRoute
  /** The lane recording right now, or null when nothing is. */
  live: CaptureRoute | null
  /** Caps Lock owns the mic. Instruct is a separate two-part flow, not a
   *  destination, and this feature does not touch it. */
  instructionActive: boolean
  /** fn's activation mode. Constrains ONLY the cursor lane — see below. */
  activationMode: ActivationModeLike
  /** This lane's own gate already said yes (plan entitlement for `task`,
   *  availability for `agent`; `cursor` is never gated). */
  laneAvailable: boolean
}

/** The lane booleans, exactly as keyboard.ts holds them. */
export interface LaneFlags {
  dictation: boolean
  remote: boolean
  agent: boolean
}

/**
 * Which route is live, derived from the lane flags.
 *
 * A DERIVATION, NOT A SECOND SOURCE OF TRUTH. The booleans stay authoritative
 * — they are entangled with the chain timer, the Caps Lock chain and the
 * dual-mode state machine, and a parallel field would be one more pair of
 * things that can disagree. This just reads them.
 *
 * Two flags set at once should be unreachable (applyRouteSwitch moves all
 * three together). If it ever happens anyway, answering with a live lane keeps
 * `submit` reachable, which is the way out; answering null would leave the
 * user with a capture they cannot stop.
 */
export function routeOfLanes(flags: LaneFlags): CaptureRoute | null {
  if (flags.dictation) return 'cursor'
  if (flags.remote) return 'task'
  if (flags.agent) return 'agent'
  return null
}

/** Does a proposed switch involve the fn lane on either side? */
function touchesCursor(live: CaptureRoute | null, lane: CaptureRoute): boolean {
  return live === 'cursor' || lane === 'cursor'
}

/**
 * What one lane key press means.
 *
 * ORDER IS THE DESIGN. `submit` is answered FIRST and unconditionally: once a
 * capture is live, the only thing its own key can do is end it, and no gate,
 * no Caps Lock and no activation mode may stand in the way. That ordering is
 * why a stuck lock on right-Option has never been reachable, and dropping it
 * is how the Agent lane wedged the one time exclusion was checked first.
 *
 * Everything below it may therefore refuse freely: a gate can only ever block
 * a START or a SWITCH INTO a lane — never a submit, and never a switch OUT.
 */
export function decidePress(ctx: PressContext): PressAction {
  // 1 · Stopping your own capture always works.
  if (ctx.live !== null && ctx.live === ctx.lane) return 'submit'

  // 2 · Instruct owns the mic. Unchanged from today.
  if (ctx.instructionActive) return 'ignore'

  // 3 · Nothing running: an ordinary start, subject to this lane's gate.
  if (ctx.live === null) return ctx.laneAvailable ? 'start' : 'ignore'

  // 4 · Another lane is live, so this is a switch.
  //
  //     PUSH-TO-TALK AND DOUBLE-TAP-PUSH ARE LEFT ALONE. In those modes fn is
  //     physically held for the duration, so "the key that submits" is a
  //     release, not a press, and the tap-toggle symmetry this feature rests
  //     on does not exist. Rather than invent a hold-to-switch gesture nobody
  //     asked for, any switch touching the cursor lane is refused there and
  //     the capture continues exactly as it does today.
  //
  //     Note this is scoped to switches TOUCHING the cursor lane. fn's mode is
  //     a property of the fn key; it has no business deciding whether the other
  //     two keys may hand a capture between them.
  if (touchesCursor(ctx.live, ctx.lane) && ctx.activationMode !== 'tap-toggle') return 'ignore'

  // 5 · The destination's own gate. Refusing here leaves the capture running
  //     on the lane it was already on — never stranded, never stopped.
  if (!ctx.laneAvailable) return 'ignore'

  return 'switch'
}
