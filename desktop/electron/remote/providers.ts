/**
 * THE PROVIDER REGISTRY — the one place a backend is described.
 *
 * Dependency-free on purpose (same shape as remoteTriggerGate): the renderer,
 * the main process and the tests all read the same table, and it stays unit
 * testable without electron.
 *
 * WHY THIS EXISTS. "Which backends are desktop apps" used to be expressed in
 * three separate places, which had already drifted apart:
 *
 *   1. isExternalAgent() in codex-executor.ts   — `agent === 'codex-desktop'`
 *   2. `desktopBackends` in Swift (IPC.swift)   — already listed a
 *      'claude-code-desktop' that does not exist in this union at all
 *   3. four ad-hoc `!== 'codex-desktop'` checks in the renderer
 *
 * Written as negations of Codex, every one of them silently mis-classifies the
 * NEXT backend to arrive: unknown reads as "Claude, with a terminal, resumable".
 * That is the shape of the 2026-07-28 bug, where a resumed Claude task was
 * rebuilt on whatever the picker said. Adding a provider is now one entry here.
 */

/** Every backend Unmute can run work on. The values are wire/disk format — they
 *  appear in meta.json and in the notch IPC — so they are append-only. */
export type ProviderId = 'claude' | 'codex' | 'codex-desktop'

export interface Provider {
  id: ProviderId
  /** Who makes it. The same vendor may ship several surfaces. */
  vendor: string
  /** How the user meets it: a CLI we run, or an app we drive. */
  surface: 'cli' | 'desktop'
  /** Human name for the task card. */
  label: string
  /** Who owns the process. 'pty' = Unmute spawns it and holds the handle.
   *  'driver' = it lives in another app; there is no executor to build. */
  transport: 'pty' | 'driver'
  /** Is there live scrollback to show? Drives the notch surface share (a live
   *  terminal gets 80% of the screen, a conversation 60%) and whether the task
   *  panel renders a terminal at all. */
  hasTerminal: boolean
  /** Can a finished/interrupted task be brought back? Gates the Resume button. */
  canResume: boolean
}

/** Absent `agent` ⇒ Claude. PTY tasks have always been persisted with no agent
 *  key, so this default is a compatibility contract, not a convenience. */
export const DEFAULT_PROVIDER: ProviderId = 'claude'

export const PROVIDERS: Record<ProviderId, Provider> = {
  claude: {
    id: 'claude',
    vendor: 'Claude',
    surface: 'cli',
    label: 'Claude Code CLI',
    transport: 'pty',
    hasTerminal: true,
    canResume: true,
  },
  codex: {
    id: 'codex',
    vendor: 'Codex',
    surface: 'cli',
    label: 'Codex CLI',
    transport: 'pty',
    hasTerminal: true,
    // TRUE because that is what ships today: the checks this replaces were
    // negations of 'codex-desktop', so the Resume button already showed for the
    // Codex CLI. CodexExecutor notes its resume is not really wired — but fixing
    // that is a behaviour change, and this table exists to preserve behaviour
    // exactly while moving where it is decided.
    canResume: true,
  },
  'codex-desktop': {
    id: 'codex-desktop',
    vendor: 'Codex',
    surface: 'desktop',
    label: 'Codex desktop',
    transport: 'driver',
    hasTerminal: false,
    canResume: false,
  },
}

/** Look up a provider, defaulting an absent/unknown id to Claude.
 *
 *  This is the ONLY place `undefined ⇒ claude` is expressed. Call it instead of
 *  writing `?? 'claude'`, so the day a fourth backend lands there is one line to
 *  change rather than a grep. */
export function providerOf(id: ProviderId | undefined | null): Provider {
  return (id && PROVIDERS[id]) || PROVIDERS[DEFAULT_PROVIDER]
}
