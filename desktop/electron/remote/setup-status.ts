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

  for (const rec of RECOMMENDED_MCPS) {
    const hit = servers.find((s) => rec.match.test(s.name) && s.connected)
    steps.push({
      key: `mcp-${rec.label.toLowerCase().replace(/\s+/g, '-')}`,
      title: `Connect ${rec.label}`,
      detail: `Lets tasks ${rec.enables}. Run the command in your own Claude Code and authorize it — Unmute never sees your credentials.`,
      command: rec.command,
      status: hit ? 'done' : 'todo',
      auto: true,
    })
  }

  return steps
}

/** Headline: are the ESSENTIAL steps done? (drives the "setup needed" nudge.)
 *  Optional enhancements (e.g. tmux) don't count against completeness. */
export function setupComplete(steps: SetupStep[]): boolean {
  return steps.filter((s) => !s.optional).every((s) => s.status === 'done')
}
