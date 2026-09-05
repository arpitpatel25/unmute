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
export type ProviderId = 'claude' | 'codex' | 'codex-desktop' | 'claude-code-desktop'

export interface Provider {
  id: ProviderId
  /** Who makes it. The same vendor may ship several surfaces. */
  vendor: string
  /** How the user meets it: a CLI we run, or an app we drive. */
  surface: 'cli' | 'desktop'
  /** Human name for the task card. */
  label: string
  /** Who owns the process. 'structured' = Unmute owns the protocol connection.
   *  'driver' = it lives in another app; there is no executor to build. */
  transport: 'structured' | 'driver'
  /** Task sessions are graphical chats, never terminal scrollback. */
  hasTerminal: boolean
  /** Can a finished/interrupted task be brought back? Gates the Resume button. */
  canResume: boolean
  /** The settings key holding the user's chosen model for this backend, or null
   *  when the backend owns that choice itself (a desktop app we drive — you
   *  pick the model in the app, and Unmute reads it back).
   *
   *  A TABLE BECAUSE IT WAS THREE INLINE BRANCHES. Codex CLI's key was written
   *  as `settings.get('codexCliModel' as never)` in four places, each with its
   *  own fallback; the pill, the settings screen and the executor each decided
   *  separately which key a backend uses, and the settings screen decided
   *  wrong — it wrote Claude's key from a menu labelled Codex. */
  modelSetting: 'model' | 'codexCliModel' | null
  /** Where the list of models comes from.
   *
   *  'catalog'    — Unmute's own catalogue (config-extendable). Only honest for
   *                 a vocabulary Unmute owns: the Claude Code aliases.
   *  'own-binary' — ask the backend's executable. Codex CLI answers `model/list`
   *                 over its app-server in ~1ms.
   *  'own-app'    — the desktop app owns the choice; we read it back from there.
   *
   *  WRITTEN DOWN BECAUSE GUESSING IT COST A RELEASE. Codex CLI's models were
   *  put in the catalogue as four invented ids; they were wrong, and nothing
   *  could have caught it, because a catalogue cannot be checked against a
   *  product that ships its own list. This field is what makes "does this
   *  backend's picker have anything in it" a question the tests can ask
   *  correctly — an empty catalogue is a bug for 'catalog' and expected for the
   *  other two, which fail to an honest empty state instead. */
  modelSource: 'catalog' | 'own-binary' | 'own-app'
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
    transport: 'structured',
    hasTerminal: false,
    canResume: true,
    modelSetting: 'model',
    modelSource: 'catalog',
  },
  codex: {
    id: 'codex',
    vendor: 'Codex',
    surface: 'cli',
    label: 'Codex CLI',
    transport: 'structured',
    hasTerminal: false,
    // TRUE because that is what ships today: the checks this replaces were
    // negations of 'codex-desktop', so the Resume button already showed for the
    // Codex CLI. CodexExecutor notes its resume is not really wired — but fixing
    // that is a behaviour change, and this table exists to preserve behaviour
    // exactly while moving where it is decided.
    canResume: true,
    // ITS OWN KEY, never Claude's. The id is passed as `-c model="…"`, a TOML
    // override Codex accepts for any string — so a Claude alias stored here
    // does not fail at the picker, it fails at the API, after the task ran.
    modelSetting: 'codexCliModel',
    // ASKED, NOT LISTED — see codex/cli-models.ts. Codex's line-up turned over
    // completely between 0.142 and 0.147.
    modelSource: 'own-binary',
  },
  'codex-desktop': {
    id: 'codex-desktop',
    vendor: 'Codex',
    surface: 'desktop',
    label: 'Codex desktop',
    transport: 'driver',
    hasTerminal: false,
    canResume: false,
    // The app owns the choice — Unmute reads Model/Effort/Speed back out of it.
    modelSetting: null,
    modelSource: 'own-app',
  },
  // The id is 'claude-code-desktop', NOT 'claude-desktop', because that string
  // was already written down in two places before this provider existed — the
  // Swift legacyDesktopBackends set and this file's own comment above. Choosing
  // it means the legacy IPC fallback classifies this backend correctly on an
  // engine too old to send `terminal`, instead of handing a driver-backed task
  // a terminal's frame. A prettier name would have made that path wrong.
  'claude-code-desktop': {
    id: 'claude-code-desktop',
    vendor: 'Claude',
    surface: 'desktop',
    label: 'Claude desktop',
    transport: 'driver',
    hasTerminal: false,
    // FALSE for the same reason as codex-desktop: resume is not implemented for
    // a driver backend. Claude Desktop *can* continue a task — you open it and
    // send another message — but until that path exists, offering the button
    // would produce a dead control.
    canResume: false,
    // Read from the composer in the app itself, same as codex-desktop.
    modelSetting: null,
    modelSource: 'own-app',
  },
}

/**
 * Can a task actually be dispatched to this backend?
 *
 * Exists because the rule kept being re-spelled as a literal allowlist at each
 * call site — `a !== 'claude' && a !== 'codex-desktop'` — which silently
 * DROPPED any newer backend rather than failing loudly. A tap that does nothing
 * and logs nothing is the worst version of that: the option is visible, the
 * click lands, and the app simply ignores it.
 *
 * 'codex' USED TO BE EXCLUDED HERE, paired with a startup migration that reset
 * a stored 'codex' back to 'claude'. Correct while the CLI adapter was a stub.
 * It is wired now — dispatch, rollout-driven state, resume, models, import — so
 * the exclusion did exactly what the paragraph above condemns: the option
 * rendered, the tap landed, and it was dropped one line later with only a WARN
 * nobody reads.
 *
 * Everything in the registry is dispatchable. Whether a backend is REACHABLE
 * right now is a separate question, answered by its own probe.
 */
export function isDispatchable(id: unknown): id is ProviderId {
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id)
}

/** Look up a provider, defaulting an absent/unknown id to Claude.
 *
 *  This is the ONLY place `undefined ⇒ claude` is expressed. Call it instead of
 *  writing `?? 'claude'`, so the day a fourth backend lands there is one line to
 *  change rather than a grep. */
export function providerOf(id: ProviderId | undefined | null): Provider {
  return (id && PROVIDERS[id]) || PROVIDERS[DEFAULT_PROVIDER]
}
