// The two axes gate independently, which is the point of keeping them separate.
//
// Capture does NOT depend on the scratchpad: with the scratchpad disabled, a
// copy made during a dictation still lands inline in the pasted text. That is
// baseline behaviour, not a scratchpad feature. And capture being off does not
// disable the scratchpad — a pad can still be built from speech alone.
//
// Both default to ON when unset, matching the existing settings convention
// where `!== false` means enabled.

export interface CaptureSettings {
  scratchpadEnabled: boolean
  captureEnabled: boolean
}

export function canArmScratchpad(s: Partial<CaptureSettings>): boolean {
  return s.scratchpadEnabled !== false
}

export function canObserve(s: Partial<CaptureSettings>): boolean {
  return s.captureEnabled !== false
}
