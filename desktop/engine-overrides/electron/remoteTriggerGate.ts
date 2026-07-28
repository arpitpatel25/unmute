// Unmute Remote trigger gate — is the Remote key (the trigger OPPOSITE the
// dictation key) allowed to start a task capture right now?
//
// Two independent inputs, deliberately kept apart:
//
//   1. ENTITLEMENT (`entitled`) — does this user's plan include Remote at all?
//      Owned by paywall-glue, which derives it from the subscription status
//      (active + plan 'unmute'). Users without it see the toggle OFF and
//      LOCKED: there is nothing for them to turn on.
//
//   2. USER PREFERENCE (`userPref`) — a Pro user's own on/off for THIS app
//      session. Deliberately NOT persisted: the spec is "on by default every
//      time the app opens, off only until you quit". A module-level variable
//      IS the session, so reopening the app resets it to on.
//
// Effective = entitled && (userPref ?? true). Consumed by keyboard.ts, which
// drops the Remote key press before it can emit 'remote-start' — the dictation
// key path is untouched either way.
//
// This module deliberately imports nothing (no electron) so the rule is unit
// testable and so both the main-process keyboard layer and the paywall layer
// can share one source of truth instead of pushing state at each other.

export interface RemoteTriggerState {
  /** Is the Remote trigger key live right now? */
  enabled: boolean
  /** True when the user's plan doesn't include Remote — the UI shows the
   *  toggle off and non-interactive (upgrade prompt), not merely unchecked. */
  locked: boolean
}

let entitled = false
let userPref: boolean | null = null

/** Plan-level entitlement. Called by paywall-glue whenever the subscription
 *  status is (re)read. Dropping entitlement does NOT clear the user's
 *  preference — regaining it should restore what they last chose this session. */
export function setRemoteTriggerEntitled(value: boolean): void {
  entitled = !!value
}

export function isRemoteTriggerEntitled(): boolean {
  return entitled
}

/** The user's own toggle for this app session. Ignored (and reported back as
 *  such) when they aren't entitled, so a stale renderer can't unlock Remote. */
export function setRemoteTriggerUserPref(value: boolean): boolean {
  if (!entitled) return false
  userPref = !!value
  return true
}

/** Back to "untouched this session" (→ on for an entitled user). Used on
 *  sign-out, so the next account starts from its own default. */
export function resetRemoteTriggerUserPref(): void {
  userPref = null
}

/** The single question keyboard.ts asks on every Remote key press. */
export function isRemoteTriggerEnabled(): boolean {
  return entitled && (userPref ?? true)
}

export function getRemoteTriggerState(): RemoteTriggerState {
  return { enabled: isRemoteTriggerEnabled(), locked: !entitled }
}
