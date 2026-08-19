// The backend picker's visibility rule, extracted so it can be TESTED against
// the real capture shape instead of eyeballed in JSX.
//
// This exists because of a bug that survived four builds. A Remote capture is
// started as:
//
//     startSession('dictation', 'remote')      // sessionManager.ts:887
//                   ^mode        ^kind
//
// `mode` and `kind` are INDEPENDENT axes. `mode` says what the capture does
// with the text; `kind` says whether it dispatches a task. The widget derives
// its state from MODE, so a Remote capture sits in state 'dictation-active' —
// and the original guard tested `state === 'instruction-active'`, which is
// therefore false for every Remote capture that has ever run. The chip could
// never appear. (The RAW chip renders because it keys off `kind`, which is why
// one showed and the other didn't in the same pill.)
//
// The rule is now a pure function over the two things that actually matter, and
// the test encodes the real values so this cannot silently regress.

export interface AgentOption {
  id: string
  label: string
  /** Can this backend take work RIGHT NOW (Codex armed / Claude always). */
  available: boolean
  /** Is the app installed at all? An installed-but-unconnected backend is still
   *  offered — hiding it left the user with no way to connect it. */
  installed?: boolean
}

export interface AgentPickerState {
  current: string
  options: AgentOption[]
}

/**
 * Capture destination is a separate axis from the backend that executes a
 * normal task. Selecting Unmute must never rewrite the Claude/Codex picker.
 */
export type CaptureDestination = 'task' | 'unmute-agent'

export interface CaptureDestinationOption {
  id: CaptureDestination
  label: string
  available: boolean
}

export interface CaptureDestinationPickerState {
  current: CaptureDestination
  unmuteAgentAvailable: boolean
}

/** The ordinary task route is always present; Agent is offered only when live. */
export function offeredCaptureDestinations(
  picker: CaptureDestinationPickerState | null | undefined,
): CaptureDestinationOption[] {
  const destinations: CaptureDestinationOption[] = [
    { id: 'task', label: 'Task', available: true },
  ]
  if (picker?.unmuteAgentAvailable) {
    destinations.push({ id: 'unmute-agent', label: 'Unmute', available: true })
  }
  return destinations
}

export function currentCaptureDestinationLabel(
  picker: CaptureDestinationPickerState | null | undefined,
): string {
  const offered = offeredCaptureDestinations(picker)
  return offered.find((option) => option.id === picker?.current)?.label ?? offered[0].label
}

/** One-tap destination cycle. This does not read or mutate provider state. */
export function nextCaptureDestination(
  picker: CaptureDestinationPickerState | null | undefined,
): CaptureDestination | null {
  const offered = offeredCaptureDestinations(picker)
  if (offered.length < 2) return null
  const index = offered.findIndex((option) => option.id === picker?.current)
  return offered[(index + 1) % offered.length].id
}

/** Backends worth offering: usable now, or installed and one tap from usable. */
export function offeredAgents(picker: AgentPickerState | null | undefined): AgentOption[] {
  return picker?.options.filter((o) => o.available || o.installed) ?? []
}

/**
 * Should the pill show the backend chip?
 *
 * `isRemote` is the KIND axis (does this capture dispatch a task) — NOT the
 * widget's state, which follows the mode axis and is 'dictation-active' even
 * for Remote captures.
 */
export function shouldShowAgentPicker(args: {
  isRemote: boolean
  picker: AgentPickerState | null | undefined
}): boolean {
  // Dictation types text; it never creates a task, so there is nothing to route.
  if (!args.isRemote) return false
  // One backend is not a choice — a Claude-only machine sees today's pill.
  return offeredAgents(args.picker).length > 1
}

/** Label to display, falling back to the first offered backend. */
export function currentAgentLabel(picker: AgentPickerState | null | undefined): string {
  const offered = offeredAgents(picker)
  return offered.find((o) => o.id === picker?.current)?.label ?? offered[0]?.label ?? ''
}

/** Is the currently selected backend connected? Drives the "· connect" hint. */
export function currentAgentConnected(picker: AgentPickerState | null | undefined): boolean {
  return offeredAgents(picker).find((o) => o.id === picker?.current)?.available ?? true
}

/** The backend one tap away from the current one. */
export function nextAgentId(picker: AgentPickerState | null | undefined): string | null {
  const offered = offeredAgents(picker)
  if (offered.length < 2) return null
  const i = offered.findIndex((o) => o.id === picker?.current)
  return offered[(i + 1) % offered.length].id
}
