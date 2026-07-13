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

/** Normalize whatever is read from settings into a complete, valid policy —
 *  missing/invalid fields fall back to defaults (never throws). */
export function normalizePolicy(raw: unknown): AxPolicy {
  const r = (raw ?? {}) as Partial<AxPolicy>
  return {
    enabled: r.enabled === true,
    screenshotEnabled: r.screenshotEnabled !== false, // default true
    allowAll: r.allowAll !== false, // default true
    allowed: Array.isArray(r.allowed) ? r.allowed.filter((s): s is string => typeof s === 'string') : [],
  }
}
