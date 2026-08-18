/**
 * Who the current utterance is addressed to.
 *
 * THE ADDRESS IS OWNED BY THE KEY-DOWN, NOT BY THE DISPATCH. That distinction
 * is the whole point of this module. The address used to live as a boolean in
 * init.ts, set when the Agent key went down and cleared only inside the
 * dispatch it produced — so a capture that never dispatched, because it was
 * cancelled or superseded by the other key, left it set indefinitely.
 *
 * Observed 2026-08-18: an Agent capture was cancelled one second after it
 * began, and from then on every Remote press was silently readdressed to the
 * Agent. The user's task never ran; twelve seconds after they released the
 * Remote key an Agent reply appeared instead, indistinguishable from one they
 * had asked for.
 *
 * Expressed as a fold so the invariant is a test rather than a comment: every
 * capture start states its own address, and no earlier capture can speak for
 * a later one.
 */
export type CaptureAddress = 'agent' | 'task'

export type CaptureAddressEvent =
  /** The Agent key went down: this utterance belongs to the Agent. */
  | 'agent-start'
  /** The Remote key went down: this utterance belongs to a task. */
  | 'remote-start'
  /** A dispatch resolved and spent the address. */
  | 'dispatched'
  /** Dictation began — a separate path that addresses nothing. */
  | 'dictation-start'

export function nextCaptureAddress(
  current: CaptureAddress,
  event: CaptureAddressEvent,
): CaptureAddress {
  switch (event) {
    case 'agent-start': return 'agent'
    case 'remote-start': return 'task'
    case 'dispatched': return 'task'
    // Dictation neither claims nor releases an address; a pending Agent
    // capture is still the Agent's when it lands.
    case 'dictation-start': return current
  }
}
