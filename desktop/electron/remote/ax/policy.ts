// ax-mcp — access policy (the enforcement layer).
//
// The user's direction: this tool exists to let Claude Code drive the WHOLE
// computer, not a hand-picked few apps. So the default is ALLOW-ALL. The
// allowlist is an OPTIONAL restriction the user can tighten in Unmute settings,
// never a gate they must populate first.
//
// Two independent switches:
//   enabled           — master. Off ⇒ every tool call is refused. This is the
//                        real kill switch (also the app can flip it live).
//   screenshotEnabled — capture_window only. Off ⇒ that one tool refuses,
//                        everything else still works. Mirrors the fact that
//                        capture needs a separate (Screen Recording) grant.
//
// Restriction modes:
//   allowAll = true   — every running app is touchable (the default).
//   allowAll = false  — only apps whose bundle id OR name is in `allowed`.
//                        Keyed on bundle id where possible (a stable identity),
//                        with name as a fallback for apps we can't resolve.

export interface AxPolicy {
  enabled: boolean
  screenshotEnabled: boolean
  allowAll: boolean
  /** Lowercased bundle ids and/or names permitted when allowAll is false. */
  allowed: string[]
}

export const DEFAULT_POLICY: AxPolicy = {
  enabled: false, // opt-in: nothing happens until the user turns Computer Use on
  screenshotEnabled: true,
  allowAll: true, // once enabled, the whole computer is in scope by default
  allowed: [],
}

/** Is this app permitted under the policy? `name` and `bundleId` come from
 *  the addon's listApps()/resolve. Case-insensitive. */
export function isAppAllowed(policy: AxPolicy, name: string, bundleId?: string): boolean {
  if (policy.allowAll) return true
  const set = new Set(policy.allowed.map((s) => s.toLowerCase()))
  if (set.has(name.toLowerCase())) return true
  if (bundleId && set.has(bundleId.toLowerCase())) return true
  return false
}

// TEMPORARY KILL SWITCH — Computer Use is entirely off, for everyone, with
// no way for a user or a stray settings.json to turn it back on. Not a
// deletion: every registration/enforcement/IPC path below is untouched and
// still correct, they just all read through here, and here always says no.
//
// WHY: `unmute-computer` (the Claude Code MCP this gates) was leaking into
// Codex — the ChatGPT desktop app's "import your Claude setup" feature
// copies the whole Claude Code config, MCP servers included, into Codex on
// every launch, independent of anything Unmute does (see ax/codex-prune.ts's
// header for the full story). Turning registration off at the source is the
// only fix that does not depend on winning a race against another app.
//
// TO BRING IT BACK: delete this block. Nothing else needs to change — every
// consumer (applyAxRegistration, the ax-mcp server, the CUA router, both
// `remote:*-computer-use` IPC handlers) already reads its answer from here,
// not from raw settings, so restoring the real value here restores the
// feature everywhere at once.
const KILL_SWITCH = true

/** Normalize whatever is read from settings into a complete, valid policy —
 *  missing/invalid fields fall back to defaults (never throws). */
export function normalizePolicy(raw: unknown): AxPolicy {
  const r = (raw ?? {}) as Partial<AxPolicy>
  return {
    enabled: KILL_SWITCH ? false : r.enabled === true,
    screenshotEnabled: r.screenshotEnabled !== false, // default true
    allowAll: r.allowAll !== false, // default true
    allowed: Array.isArray(r.allowed) ? r.allowed.filter((s): s is string => typeof s === 'string') : [],
  }
}
