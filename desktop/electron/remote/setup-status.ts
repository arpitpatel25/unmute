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
  const confirmed = (k: string) => inputs.confirmations?.[k] === true

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
  return steps.filter((s) => !s.optional).every((s) => s.status === 'done')
}
