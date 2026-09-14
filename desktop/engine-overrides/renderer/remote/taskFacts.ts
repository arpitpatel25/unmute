// The facts a ticket owes the user, and the questions its buttons must ask.
//
// WHY THIS IS ITS OWN MODULE. Every surface that renders a ticket — today the
// Tasks page in the main window (`TaskPanel.tsx`) — must answer "which agent,
// which model, which directory" and "may this task be resumed" identically. The
// four ad-hoc `agent !== 'codex-desktop'` checks that the provider registry
// replaced are exactly what happens when two surfaces each keep their own copy.
//
// Pure: no React, no electron, no IPC. Unit-tested by taskFacts.test.ts.

import type { RemoteTask } from './useRemoteTasks'

/** Vendor marks (launch spec pack-c §4.1) — one small colour per vendor so a
 *  wall mixing backends is scannable without reading. Keyed by the registry's
 *  own `vendor`/`surface` pair, never by an id. */
export const VENDOR_MARK: Record<string, string> = {
  'Claude/cli': '#D97757',      // Claude Code CLI — terracotta (the Unmute accent)
  'Claude/desktop': '#d2a8ff',  // Claude desktop — violet
  'Codex/cli': '#3fb950',       // Codex CLI — green
  'Codex/desktop': '#3fb950',   // Codex desktop — green
}
export const UNKNOWN_VENDOR_MARK = '#5b616b'

/** How a task written BEFORE the provider registry existed is described. Label
 *  and mark live in ONE row, so a card can never carry a Codex name beside a
 *  Claude colour — written separately, the two fallbacks disagreed.
 *
 *  A DESCRIPTION table, never a capability decision: every button asks
 *  `provider.canResume` / `provider.hasTerminal`.
 *
 *  Unreachable today — main sets `provider` on every task it serializes
 *  (init.ts:821) — and kept only so an older payload still draws honestly. */
export const LEGACY_AGENT: Record<string, { label: string; mark: string }> = {
  claude: { label: 'Claude Code CLI', mark: VENDOR_MARK['Claude/cli'] },
  codex: { label: 'Codex CLI', mark: VENDOR_MARK['Codex/cli'] },
  'codex-desktop': { label: 'Codex desktop', mark: VENDOR_MARK['Codex/desktop'] },
  'claude-code-desktop': { label: 'Claude desktop', mark: VENDOR_MARK['Claude/desktop'] },
}

/* ─── Capability questions — asked of the REGISTRY, never of an id ───────────
 *
 * A task with no `provider` was serialized before the registry existed; every
 * such task was a Claude Code CLI PTY session, so the defaults below are stated
 * once, as literal capabilities, rather than re-derived from an agent id at
 * each call site — which is what silently gave each NEW backend a terminal and
 * a Resume button it does not have.
 */

/** Is there live scrollback to show? False ⇒ the ticket shows the conversation
 *  projection and a door into the app instead of a terminal. */
export const hasTerminal = (t: RemoteTask): boolean => t.provider?.hasTerminal ?? false
export const isDesktopTask = (t: RemoteTask): boolean => t.provider?.surface === 'desktop' || (!t.provider && (t.agent === 'codex-desktop' || t.agent === 'claude-code-desktop'))
/** Can this task be brought back? False ⇒ NO Resume button at all — not a
 *  greyed-out one. A dead control is worse than an absent one. */
export const canResume = (t: RemoteTask): boolean => t.provider?.canResume ?? true
/** Is this task's process ours to end? Only a PTY we spawned can be killed. */
export const canKill = (t: RemoteTask): boolean => t.provider?.transport !== 'driver'

/** The vendor colour mark. Falls back through the SAME table as the label, so
 *  the two can never disagree. */
export function vendorMark(t: RemoteTask): string {
  const p = t.provider
  if (!p) return LEGACY_AGENT[t.agent ?? 'claude']?.mark ?? UNKNOWN_VENDOR_MARK
  return VENDOR_MARK[`${p.vendor}/${p.surface}`] ?? UNKNOWN_VENDOR_MARK
}

/** WHICH backend this task runs on. EVERY ticket names its provider, not only
 *  the non-default ones: the wall mixes backends freely and they no longer
 *  behave alike, so "which is this?" is information the ticket owes the user. */
export function providerLabel(t: RemoteTask): string {
  const base = t.provider?.label ?? LEGACY_AGENT[t.agent ?? 'claude']?.label ?? 'Claude Code CLI'
  // A Codex thread lives in a project; it disambiguates two threads on one wall.
  return t.codexProject ? `${base} · ${t.codexProject}` : base
}

/** The door into a driver-backed task's own app: "open in Codex", "open in
 *  Claude". Named from the registry's VENDOR — what the user calls the app —
 *  so a new backend names itself the day it lands. */
export function openInLabel(t: RemoteTask): string {
  return `open in ${t.provider?.vendor ?? 'the agent'}`
}

/** The session's REAL working directory, compacted (home → ~).
 *
 *  EVERY ticket names its directory. This used to hide a one-off's isolated
 *  scratch dir as "machinery", but "where did this run?" is the question a
 *  stranger asks first, and a ticket that answers it for some tasks and not
 *  others is worse than one that always answers. A scratch dir is SHORTENED
 *  rather than suppressed; callers put the full path on the tooltip. */
export function dirLabel(t: RemoteTask): string {
  const cwd = t.cwd || ''
  if (!cwd) return ''
  const home = cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  // ~/.unmute/tasks/<uuid> → ~/.unmute/…/3f2a1b — the id is noise past 6 chars.
  const scratch = home.match(/^(~\/\.unmute)\/.*\/([^/]+)$/)
  return scratch ? `${scratch[1]}/…/${scratch[2].slice(0, 6)}` : home
}

/** Agent · model, as one phrase.
 *
 *  MODEL IS A HISTORICAL FACT (launch decision D6), sent by main at dispatch and
 *  replayed from disk after a restart. When it is absent — a task created before
 *  the field existed, or a backend that named no model — the agent stands ALONE.
 *  Never a default, never the current picker value, never a placeholder word: a
 *  task dispatched on Sonnet that starts claiming Opus because the picker moved
 *  would look exactly as correct as a true one. */
export function agentAndModel(t: RemoteTask): string {
  const agent = providerLabel(t)
  return t.model ? `${agent} · ${t.model}` : agent
}
