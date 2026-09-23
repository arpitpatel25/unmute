// Unmute Remote — guided one-time setup status (PRD §12, onboarding).
//
// DECIDED posture: absorb the complexity into a one-time guided onboarding so
// per-task usage stays pure voice. Unmute is NEVER in the credential path
// (§12.1) — it does not install extensions, sign in, or add MCP servers. What
// it DOES is make the one-time setup legible: show the exact steps, auto-detect
// the ones it can (which MCP servers are connected, whether the dedicated Chrome
// profile exists), and hand the user the exact command for the rest.
//
// This module is PURE (parsing + checklist assembly). The shelling-out to
// `claude mcp list` and the filesystem/Chrome checks live in init.ts (Electron
// glue, untested) and feed their results in here.

/** A connected/declared MCP server as seen in `claude mcp list`. */
export interface McpServer {
  name: string
  connected: boolean
}

/**
 * Parse `claude mcp list` output into server name + connectivity. Tolerant of
 * format drift: takes the leading `name:` (or bare token) per line, and reads
 * connectivity from a ✓/✗/Connected/Failed marker if present (else assumes
 * declared-but-unknown ⇒ treated as connected, since it IS configured).
 */
export function parseMcpList(stdout: string): McpServer[] {
  const out: McpServer[] = []
  const seen = new Set<string>()
  for (const rawLine of (stdout || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // Skip header/status chatter that has no "name:" shape and no bare token.
    const m = line.match(/^([A-Za-z0-9_.@/-]+)\s*:/)
    const bare = line.match(/^([A-Za-z0-9_.@/-]+)$/)
    const name = m ? m[1] : bare ? bare[1] : null
    if (!name) continue
    if (/^(checking|no\s+mcp|health)/i.test(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    const failed = /✗|failed|error|not\s+connected|disconnected/i.test(line)
    const ok = /✓|connected/i.test(line)
    out.push({ name, connected: ok || !failed })
  }
  return out
}

/** A recommended integration for the reliable lanes (DECIDED scope: email +
 *  Google Sheets/Docs/Drive — the high-value, high-reliability set). */
export interface RecommendedMcp {
  /** Match against parsed server names (substring, case-insensitive). */
  match: RegExp
  label: string
  /** What it unlocks, shown in onboarding. */
  enables: string
  /** Exact command the USER runs in their own Claude Code (we never run it). */
  command: string
}

export const RECOMMENDED_MCPS: RecommendedMcp[] = [
  { match: /gmail|google.?mail/i, label: 'Gmail', enables: 'read, search, and send email by voice', command: 'claude mcp add gmail' },
  { match: /sheet/i, label: 'Google Sheets', enables: 'read and edit spreadsheets', command: 'claude mcp add google-sheets' },
  { match: /doc/i, label: 'Google Docs', enables: 'read and edit documents', command: 'claude mcp add google-docs' },
  { match: /drive/i, label: 'Google Drive', enables: 'find and manage files', command: 'claude mcp add google-drive' },
]

export type StepStatus = 'done' | 'todo'

export interface SetupStep {
  key: string
  title: string
  detail: string
  /** Copy-paste command for the user (when the step is something they run). */
  command?: string
  status: StepStatus
  /** true = Unmute auto-detected this; false = user self-confirms (we can't see it). */
  auto: boolean
  /** Optional enhancement — doesn't block "setup complete". */
  optional?: boolean
  /** A one-click fix the UI can offer, when the problem is one Unmute can solve
   *  itself. Only set when acting would actually help — an app that isn't
   *  installed cannot be connected to, so that case gets a command instead. */
  action?: 'codex-connect'
  /** Steps that are satisfied as a SET rather than individually. Backends are the
   *  only such group: you need one working agent, not every agent. */
  group?: 'backend'
}

/** What we know about one backend, probed by the main process. */
export interface BackendProbe {
  id: string
  /** Human name, from the provider registry (providers.ts). */
  label: string
  /** Present on this machine at all? */
  installed: boolean
  /** Able to take a task RIGHT NOW (installed, and reachable if it needs to be). */
  ready: boolean
  /** Why not, when we know: 'not-installed' | 'not-armed' | 'not-running'. */
  reason?: string
}

export interface SetupInputs {
  /** Raw stdout from `claude mcp list` (empty string if it couldn't run). */
  mcpListOutput: string
  /** Whether the browser lane is enabled in settings. */
  browserEnabled: boolean
  /** Whether tmux is installed (enables pop-out-to-terminal). */
  tmuxAvailable: boolean
  /** User-confirmed manual steps (persisted), keyed by step key. */
  confirmations: Record<string, boolean>
  /** The agents that can run work, probed. Optional so existing callers and
   *  tests keep their old checklist unchanged. */
  backends?: BackendProbe[]
  /** CLIs that are behind and that Unmute could not update itself (see
   *  cli-updates.ts). Optional, like backends. */
  cliUpdates?: CliUpdateNotice[]
}

/** An agent CLI older than the published release, which Unmute tried and
 *  failed to update, or is not allowed to (a desktop app's bundled copy). */
export interface CliUpdateNotice {
  /** Provider id: 'claude' | 'codex'. */
  id: string
  label: string
  version: string
  latest: string
  /** What the user can run themselves, when there is such a thing. */
  command?: string
  /** Why the automatic update did not happen, when it was attempted. */
  detail?: string
}

/** How a backend that isn't ready gets fixed. Keyed by provider id, because the
 *  remedy is provider-specific in a way the registry's capability flags are not:
 *  one is "install a CLI", the other is "let us relaunch your app with a debug
 *  port". Anything not listed falls back to a generic install line. */
const BACKEND_REMEDIES: Record<string, { install: string; command?: string; unready?: { detail: string; action?: SetupStep['action'] } }> = {
  claude: {
    install: 'Install the Claude Code CLI and sign in, then re-check. If it is already installed but not found, it is probably not on the PATH a launched app sees — reopen Unmute from your terminal once, or install it under /usr/local/bin.',
    command: 'npm install -g @anthropic-ai/claude-code',
  },
  'codex-desktop': {
    install: 'Install the Codex desktop app (ChatGPT.app) in /Applications and sign in to it. Unmute drives the real app, so it must be installed at that exact path.',
    unready: {
      // The relaunch is the one unavoidable interruption in this lane, so say so
      // BEFORE they click rather than quitting their app as a surprise.
      detail: 'Codex is installed but Unmute cannot talk to it yet. Connecting restarts the Codex app in the background so Unmute can drive it — you will not lose your threads.',
      action: 'codex-connect',
    },
  },
}

// DECIDED: browser tasks drive the user's REAL, already-signed-in Chrome (no
// dedicated profile, no separate sign-in, no Space juggling). The only one-time
// thing is having the Claude for Chrome extension installed in that Chrome — and
// most users already do. So onboarding is a single, self-confirmed reminder.
/**
 * Version of each self-confirmed step's REQUIREMENT.
 *
 * A confirmation is stored forever and survives upgrades, so if what we ask for
 * ever changes, a stale `true` would hide the new requirement and the user would
 * never learn they are missing it. The confirmation is therefore keyed
 * `<step>@<version>`; bumping the number reverts that step to todo.
 *
 * v1 also honours the ORIGINAL unversioned key, so nobody is re-nagged for
 * something they already confirmed before this existed.
 */
const STEP_VERSION: Record<string, number> = { 'chrome-extension': 1 }

/** Storage key for a step's confirmation. Exported so the IPC writes the same
 *  key the checklist reads — two spellings would silently never agree. */
export function confirmationKey(stepKey: string): string {
  return `${stepKey}@${STEP_VERSION[stepKey] ?? 1}`
}

function isConfirmed(confirmations: Record<string, boolean> | undefined, stepKey: string): boolean {
  if (confirmations?.[confirmationKey(stepKey)] === true) return true
  // Legacy: pre-versioning confirmations were stored bare, and only ever meant v1.
  return (STEP_VERSION[stepKey] ?? 1) === 1 && confirmations?.[stepKey] === true
}

export const MANUAL_BROWSER_STEPS: Array<Pick<SetupStep, 'key' | 'title' | 'detail'>> = [
  {
    key: 'chrome-extension',
    title: 'Install the Claude for Chrome extension',
    detail: 'Add the Claude for Chrome extension to your normal Chrome and enable it. Browser tasks drive your real, already-signed-in Chrome — no separate profile or login needed. If you already have it, just check this off.',
  },
]

/**
 * Assemble the ordered onboarding checklist from detected + confirmed state.
 * Order: Chrome extension → each recommended MCP. Browser step is omitted when
 * the browser lane is disabled.
 */
export function buildSetupChecklist(inputs: SetupInputs): SetupStep[] {
  const steps: SetupStep[] = []
  const servers = parseMcpList(inputs.mcpListOutput)
  const confirmed = (k: string) => isConfirmed(inputs.confirmations, k)

  // BACKENDS FIRST — nothing else in this list matters if no agent can run the
  // work. These are never `optional`: a user with no working backend has no
  // product, and they are never self-confirmed, because we can see the truth.
  for (const b of inputs.backends ?? []) {
    const remedy = BACKEND_REMEDIES[b.id]
    const unready = !b.installed ? undefined : remedy?.unready
    steps.push({
      key: `backend-${b.id}`,
      title: b.ready ? `${b.label} — ready` : `Set up ${b.label}`,
      detail: b.ready
        ? `${b.label} can take tasks.`
        : unready?.detail ?? remedy?.install ?? `${b.label} is not available on this machine.`,
      ...(b.ready || b.installed ? {} : remedy?.command ? { command: remedy.command } : {}),
      ...(b.ready ? {} : unready?.action ? { action: unready.action } : {}),
      status: b.ready ? 'done' : 'todo',
      auto: true,
      group: 'backend',
    })
  }

  // OUTDATED CLIs. Optional: an old CLI still runs tasks, it just cannot offer
  // models released after it. Only listed when Unmute could not update it
  // itself — a CLI it keeps current never needs the user.
  for (const u of inputs.cliUpdates ?? []) {
    steps.push({
      key: `cli-update-${u.id}`,
      title: `Update ${u.label} (${u.version} → ${u.latest})`,
      detail: u.command
        ? `Unmute could not update ${u.label} automatically${u.detail ? ` (${u.detail.split('\n')[0]})` : ''}. Newer models only appear once it is updated — run the command in your terminal.`
        : `${u.label} is updated by the app it ships with. Update that app to get the newest models.`,
      ...(u.command ? { command: u.command } : {}),
      status: 'todo',
      auto: true,
      optional: true,
    })
  }

  if (inputs.browserEnabled) {
    for (const s of MANUAL_BROWSER_STEPS) {
      steps.push({ ...s, status: confirmed(s.key) ? 'done' : 'todo', auto: false })
    }
  }

  // Optional enhancement: tmux enables popping a task out to your real terminal
  // (iTerm/Terminal) as the SAME session. Auto-detected; Unmute can install it.
  steps.push({
    key: 'tmux',
    title: 'Pop-out-to-terminal (optional)',
    detail: 'Install tmux to open a running task in your real terminal as the same live session. Unmute can install it for you (via Homebrew).',
    command: 'brew install tmux',
    status: inputs.tmuxAvailable ? 'done' : 'todo',
    auto: true,
    optional: true,
  })

  // Recommended integrations are OPTIONAL — Remote works with just the Chrome
  // extension. These add capability (email, Sheets, etc.) and the user grants
  // them as-needed, so they must NOT gate "setup complete" (DECIDED).
  for (const rec of RECOMMENDED_MCPS) {
    const hit = servers.find((s) => rec.match.test(s.name) && s.connected)
    steps.push({
      key: `mcp-${rec.label.toLowerCase().replace(/\s+/g, '-')}`,
      title: `Connect ${rec.label}`,
      detail: `Lets tasks ${rec.enables}. Run the command in your own Claude Code and authorize it — Unmute never sees your credentials.`,
      command: rec.command,
      status: hit ? 'done' : 'todo',
      auto: true,
      optional: true,
    })
  }

  return steps
}

/** Headline: are the ESSENTIAL steps done? (drives the "setup needed" nudge.)
 *  Optional enhancements (e.g. tmux) don't count against completeness. */
export function setupComplete(steps: SetupStep[]): boolean {
  const required = steps.filter((s) => !s.optional)
  // BACKENDS ARE SATISFIED AS A SET. Requiring every one meant a user who runs
  // only Claude Code — a perfectly complete setup — was permanently incomplete
  // and permanently nagged to install an agent they had chosen not to use.
  // Backends also regress on their own (Codex loses its debug port whenever the
  // app is reopened normally), so "all of them" would flap for everyone.
  const backends = required.filter((s) => s.group === 'backend')
  const rest = required.filter((s) => s.group !== 'backend')
  const backendsOk = backends.length === 0 || backends.some((s) => s.status === 'done')
  return backendsOk && rest.every((s) => s.status === 'done')
}

/**
 * The ONE thing most worth telling the user, or null when nothing is wrong.
 *
 * The nudge used to hardcode the Chrome extension, so a user with no working
 * agent at all — the only condition under which Remote genuinely cannot run —
 * was told to install a browser extension. Ordered by how badly it blocks.
 */
export function blockerOf(steps: SetupStep[]): string | null {
  const required = steps.filter((s) => !s.optional)
  const backends = required.filter((s) => s.group === 'backend')
  if (backends.length > 0 && !backends.some((s) => s.status === 'done')) {
    return 'No agent is set up yet — Remote needs Claude Code or Codex desktop to run anything.'
  }
  const other = required.find((s) => s.group !== 'backend' && s.status === 'todo')
  return other ? `${other.title} — ${other.detail}` : null
}
