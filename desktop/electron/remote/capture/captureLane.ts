/**
 * Which lane owns the microphone, and the rule that only one may.
 *
 * THE LANE IS A PROPERTY OF THE CAPTURE, NOT A FLAG BESIDE IT. The predecessor
 * of this module was a module-level boolean set on the Agent key and cleared
 * only by a dispatch that completed. A capture that was cancelled — or
 * superseded by the other key — left it set, and every later Remote press was
 * silently readdressed to the Agent. Observed twice, in both directions.
 *
 * Here the live capture carries its own lane. There is nothing to go stale,
 * because there is nothing beside the capture to hold an opinion about it.
 *
 * EXCLUSIVITY is the second, independent defence. On 18 August the Agent key
 * armed a capture and the Remote key armed another one second later, on top of
 * it. Refusing that at the input layer means the routing question never arises.
 */
export type Lane = 'dictation' | 'orchestrator' | 'agent'

export interface LiveCapture {
  lane: Lane
  startedAt: number
}

export type AdmitResult =
  | { admitted: true; capture: LiveCapture }
  /** Refusals name their blocker: a capture that goes nowhere must not go
   *  nowhere SILENTLY, which is exactly how the original bug hid. */
  | { admitted: false; reason: 'capture-already-live'; blockedBy: Lane }

export function admitCapture(current: LiveCapture | null, wanted: Lane, at: number): AdmitResult {
  if (current) {
    return { admitted: false, reason: 'capture-already-live', blockedBy: current.lane }
  }
  return { admitted: true, capture: { lane: wanted, startedAt: at } }
}
