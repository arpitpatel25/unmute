// Unmute Remote — MCP gap detection + handoff (PRD §12.3, §17.4).
//
// Principle (PRD §12.1): Unmute is NEVER in the credential path. It does not
// install or authenticate MCPs. BUT (PRD §12.3) being a wrapper ≠ being
// unhelpful: when a task fails because an integration isn't configured in the
// user's Claude Code, Unmute must DETECT the gap and hand the user the exact
// instruction to fix it themselves — then offer retry.
//
// This module is pure (no side effects): given a failed task's error text, it
// decides whether it looks like a missing-integration gap and, if so, returns
// the human handoff. The actual setup is always the user's job in their own
// Claude Code (PRD §12.2).

export interface McpGap {
  integration: string
  /** The exact command the user runs in THEIR Claude Code (we never run it). */
  fixCommand: string
  /** The message to show in the task row + a retry affordance. */
  message: string
}

// The first-class set Unmute provides guidance for (PRD §17.4 — launch small,
// expand). Each: keywords that signal "this integration was needed but absent",
// plus the canonical `claude mcp add` command for the user to run themselves.
interface KnownIntegration {
  key: string
  label: string
  keywords: RegExp
  fixCommand: string
}
const KNOWN: KnownIntegration[] = [
  { key: 'slack', label: 'Slack', keywords: /\bslack\b/i, fixCommand: 'claude mcp add slack' },
  { key: 'github', label: 'GitHub', keywords: /\bgithub\b/i, fixCommand: 'claude mcp add github' },
  { key: 'gdrive', label: 'Google Drive', keywords: /\bgoogle\s*drive\b|\bgdrive\b|\bdrive\b/i, fixCommand: 'claude mcp add google-drive' },
  { key: 'jira', label: 'Jira', keywords: /\bjira\b/i, fixCommand: 'claude mcp add jira' },
  { key: 'notion', label: 'Notion', keywords: /\bnotion\b/i, fixCommand: 'claude mcp add notion' },
]

// Phrases that indicate "an integration is MISSING / not connected" rather than
// just any mention of it. Keeps us from false-flagging a successful Slack send.
const GAP_SIGNAL = /\b(not\s+(connected|configured|installed|available|set\s*up)|no\s+(mcp|integration|connection)|missing\s+(mcp|integration)|isn'?t\s+(connected|configured)|couldn'?t\s+find\s+(the\s+)?(slack|github|jira|notion|drive))\b/i

/**
 * Inspect a failed task's error text for a missing-integration gap.
 * Returns the handoff, or null if it doesn't look like an MCP gap.
 */
export function detectMcpGap(errorText: string | undefined | null): McpGap | null {
  if (!errorText) return null
  const text = errorText.trim()
  if (!GAP_SIGNAL.test(text)) return null
  for (const integ of KNOWN) {
    if (integ.keywords.test(text)) {
      return {
        integration: integ.label,
        fixCommand: integ.fixCommand,
        // PRD §12.3 exact-instruction handoff + retry.
        message: `Your Claude Code doesn't have ${integ.label} connected. Run \`${integ.fixCommand}\` and authorize it, then retry.`,
      }
    }
  }
  return null
}
