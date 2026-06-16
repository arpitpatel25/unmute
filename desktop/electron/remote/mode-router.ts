// Unmute Remote — mode routing: derived Remote key + capture mutual-exclusion.
//
// Governing spec: PRD §2.4.4 (Mode routing & key assignment).
//   * Exactly two trigger keys: function key ('fn') and right-option.
//   * User picks ONE for dictation (existing setting; default 'fn').
//     The OTHER automatically becomes Remote — derived, not configured.
//   * Default: dictation='fn' → Remote='right-option'.
//   * Mutual exclusion: at any instant only ONE capture mode may be active.
//     This locks STARTING a new capture only; already-dispatched background
//     Remote tasks keep running (PRD §4 — they're async).
//
// This module is PURE (no Electron) so it's fully unit-testable and is the
// no-regression-critical seam: get this wrong and dictation breaks (PRD §2.4.1).

import { createLogger } from './log'

const log = createLogger('mode-router')

export type TriggerKey = 'fn' | 'right-option'
export type CaptureMode = 'dictation' | 'remote'

/** PRD §2.4.4: the Remote key is always "the one not chosen for dictation". */
export function deriveRemoteKey(dictationKey: TriggerKey): TriggerKey {
  const remote: TriggerKey = dictationKey === 'fn' ? 'right-option' : 'fn'
  log.event('derive-remote-key', { dictationKey, remoteKey: remote })
  return remote
}

/**
 * PRD §2.4.4: capture-time lock. Only one capture mode may be active at an
 * instant. `tryStart` returns false if a capture is already active (the
 * trigger for the other mode is then ignored/blocked by the caller).
 *
 * NOTE: this is intentionally about *captures*, not *tasks*. Ending a capture
 * frees the lock immediately even though the dispatched Remote task continues
 * running in the background (PRD §4.4).
 */
export class CaptureLock {
  private active: CaptureMode | null = null

  /** Attempt to begin a capture. Returns true if acquired, false if blocked. */
  tryStart(mode: CaptureMode): boolean {
    if (this.active !== null) {
      log.event('capture-blocked', { requested: mode, activeMode: this.active })
      return false
    }
    this.active = mode
    log.event('capture-started', { mode })
    return true
  }

  /** Release the lock for `mode`. No-op if `mode` isn't the active one. */
  end(mode: CaptureMode): void {
    if (this.active === mode) {
      this.active = null
      log.event('capture-ended', { mode })
    } else {
      log.warn('capture-end ignored (not the active mode)', { requested: mode, activeMode: this.active })
    }
  }

  get current(): CaptureMode | null {
    return this.active
  }
}
