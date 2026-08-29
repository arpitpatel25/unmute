// WHICH ROUTER HANDLES AN UTTERANCE, AND WHICH TASKS IT MAY BE OFFERED.
//
// Both questions were answered inline in init.ts as `=== 'codex-desktop'`,
// written when the desktop app was the only Codex surface. The CLI is a second
// one and its tasks carry agent 'codex', so with the picker set to Codex CLI:
//
//   * routing went to the CLAUDE router — the condition simply did not match;
//   * and had it matched, the scoping filter would then have hidden every
//     Codex CLI task from it, because that compared against 'codex-desktop'
//     too. So fixing only the first half would have produced a Codex router
//     that could never continue a Codex task.
//
// Observed 28 Aug: settings held agent='codex' and both routes still logged
// engine "claude-headless". The Codex router had been unreachable for anyone
// not on Codex desktop specifically.
//
// Extracted here as pure functions because the original lived in the middle of
// a 200-line dispatch handler, where neither branch could be tested and the
// asymmetry between them was invisible.

import type { ProviderId } from './providers'

/** The vendor a surface belongs to. The router split is by VENDOR, never by
 *  surface: a Codex thread resumed through `claude --continue` is the
 *  cross-provider bleed this whole scoping exists to prevent. */
function vendorOf(p: ProviderId | undefined): 'claude' | 'codex' | null {
  switch (p) {
    case 'codex':
    case 'codex-desktop':
      return 'codex'
    case 'claude':
    case 'claude-code-desktop':
      return 'claude'
    default:
      return null
  }
}

/**
 * Should this utterance be routed by the Codex router?
 *
 * True when the user prefers EITHER Codex surface and that router exists, or
 * when there is no Claude router at all — losing the utterance is worse than
 * routing it with the other vendor's classifier.
 */
export function prefersCodexRouter(
  preferred: ProviderId | undefined,
  have: { claude: boolean; codex: boolean },
): boolean {
  if (!have.codex) return false
  return vendorOf(preferred) === 'codex' || !have.claude
}

/**
 * May the active router be offered this task?
 *
 * Same vendor only. An agent-less task belongs to NEITHER router: absence of
 * information is not evidence of Claude, and treating it as such is what once
 * handed a task with no named backend to the Claude router as if it were sure.
 */
export function routerScopeMatches(useCodex: boolean, taskAgent: ProviderId | undefined): boolean {
  const v = vendorOf(taskAgent)
  if (!v) return false
  return v === (useCodex ? 'codex' : 'claude')
}
