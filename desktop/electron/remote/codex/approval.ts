// Unmute Remote — Codex approval policy: ask for the most we're ALLOWED, never
// a hardcoded maximum.
//
// Claude Code already does the equivalent: executorFactory passes
// `--dangerously-skip-permissions` when the user's permissionMode is
// 'auto-approve'. Codex should behave the same so the two backends are
// consistent — but Codex's levels are a property of the DEVICE and ACCOUNT, not
// something we get to choose:
//
//   Ask for approval  — always ask to edit external files / use the internet
//   Approve for me    — only ask for actions judged potentially unsafe
//   Full access       — unrestricted
//
// On a company/managed plan "Full access" is simply absent. Asking for it there
// would fail (or be silently downgraded), so the rule is:
//
//     effective = min( user's unmute permissionMode , device ceiling )
//
// Two caps, both real: the ceiling stops us requesting the unavailable, and the
// user's own setting stops us escalating someone who deliberately wants to
// approve each action.
//
// IMPORTANT consequence: on a capped device the ceiling STILL blocks, so tasks
// will stop for approval as a matter of course. That is why the hooks channel
// (codex/hooks.ts) is required rather than a nicety — this module reduces how
// often we block, it cannot remove blocking.

/** Codex's own approval vocabulary (from the app-server schema). */
export type AskForApproval = 'untrusted' | 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The three levels the Codex UI offers, highest last. */
export type CodexApprovalLevel = 'ask' | 'approve-for-me' | 'full-access'

export const LEVEL_ORDER: CodexApprovalLevel[] = ['ask', 'approve-for-me', 'full-access']

export interface CodexPolicy {
  level: CodexApprovalLevel
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
  /** True when this level can still interrupt the user for approval. */
  canBlock: boolean
}

const POLICIES: Record<CodexApprovalLevel, Omit<CodexPolicy, 'level'>> = {
  // Always ask before touching external files or the network.
  'ask':            { approvalPolicy: 'untrusted',  sandbox: 'read-only',          canBlock: true },
  // Only asks for actions Codex judges unsafe — still blocks, just less often.
  'approve-for-me': { approvalPolicy: 'on-request', sandbox: 'workspace-write',    canBlock: true },
  // Never asks.
  'full-access':    { approvalPolicy: 'never',      sandbox: 'danger-full-access', canBlock: false },
}

/** Unmute's own permission setting, mirrored from the Claude adapter. */
export type UnmutePermissionMode = 'auto-approve' | 'ask'

/**
 * Choose the policy for a new Codex thread.
 *
 * @param available  Levels this device/account actually offers (discovered).
 * @param userMode   The user's unmute permissionMode.
 * @param sandboxed  True when unmute is running sandboxed (roots configured);
 *                   we then refuse full access exactly as the Claude adapter
 *                   refuses --dangerously-skip-permissions inside a sandbox.
 */
export function choosePolicy(
  available: CodexApprovalLevel[],
  userMode: UnmutePermissionMode,
  sandboxed = false,
): CodexPolicy {
  // Never invent a level the host didn't report. An empty list means discovery
  // failed — fall back to the most conservative, never the most permissive.
  const offered = LEVEL_ORDER.filter((l) => available.includes(l))
  if (!offered.length) return { level: 'ask', ...POLICIES.ask }

  // THE AUTOMATIC CEILING IS 'approve-for-me', NEVER 'full-access'.
  //
  // Codex guards Full Access behind a confirmation dialog — "Turn on Full
  // Access?", listing unrestricted files, terminal commands and network — and
  // that dialog exists so a HUMAN reads what is being granted. We can click it
  // (and do, if a user has already chosen that level), but choosing it FOR them
  // on a dictated task would defeat a safety gate the vendor put there on
  // purpose, unattended, on their whole machine.
  //
  // 'approve-for-me' is the honest middle: one click, no confirmation dialog
  // (measured), available on managed devices where full access is withheld
  // entirely, and it only stops for actions Codex judges genuinely unsafe. The
  // approval hook surfaces those in the notch, which is the point of having it.
  //
  // Full access remains reachable — the user sets it in Codex themselves, and
  // the never-downgrade rule in applyApprovalPolicy leaves it alone.
  const userCeiling: CodexApprovalLevel =
    userMode === 'auto-approve' && !sandboxed ? 'approve-for-me' : 'approve-for-me'

  // ...and the device ceiling is the second. Take the highest offered level
  // that is at or below BOTH.
  const capIdx = Math.min(LEVEL_ORDER.indexOf(userCeiling), LEVEL_ORDER.length - 1)
  let chosen: CodexApprovalLevel = 'ask'
  for (const l of offered) {
    if (LEVEL_ORDER.indexOf(l) <= capIdx) chosen = l
  }
  // 'ask' when the user explicitly wants to approve everything.
  if (userMode === 'ask' && offered.includes('ask')) chosen = 'ask'
  return { level: chosen, ...POLICIES[chosen] }
}

/** Maps a Codex permission-profile id to the level the UI calls it. */
const PROFILE_LEVEL: Record<string, CodexApprovalLevel> = {
  ':read-only': 'ask',
  ':workspace': 'approve-for-me',
  ':danger-full-access': 'full-access',
}

/**
 * Discover the levels this device offers from `permissionProfile/list`.
 *
 * Measured live 2026-07-25 on an unmanaged account:
 *   {"data":[{"id":":read-only","allowed":true},
 *            {"id":":workspace","allowed":true},
 *            {"id":":danger-full-access","allowed":true}]}
 *
 * `allowed` is the whole point — a managed/company plan is expected to report
 * `:danger-full-access` as not allowed (or omit it), and that is precisely the
 * ceiling we must respect instead of hardcoding the maximum.
 *
 * This is a READ-ONLY capability query, which is a legitimate use of the
 * app-server lane even though it is unusable for writes (a second app-server
 * client does not reflect the desktop app's UI state; see codex/driver.ts).
 */
export function levelsFromProfiles(profiles: unknown): CodexApprovalLevel[] {
  const data = (profiles as { data?: Array<{ id?: string; allowed?: boolean }> } | null)?.data
  if (!Array.isArray(data)) return []
  const out = new Set<CodexApprovalLevel>()
  for (const p of data) {
    if (!p?.id || p.allowed === false) continue
    const level = PROFILE_LEVEL[p.id]
    if (level) out.add(level)
  }
  return LEVEL_ORDER.filter((l) => out.has(l))
}

/** The label the Codex composer shows for each level (menu text, verbatim). */
export const LEVEL_LABEL: Record<CodexApprovalLevel, string> = {
  'ask': 'Ask for approval',
  'approve-for-me': 'Approve for me',
  'full-access': 'Full access',
}

/**
 * Discover the levels from the composer's permissions menu.
 *
 * This is the authority the app-server cannot be: the menu is literally what
 * this user, on this device, on this plan, is offered — a level missing here
 * cannot be selected no matter what any API reports. Menu items were measured
 * as "<Label> | <description>", so we match on the label prefix.
 */
export function levelsFromMenu(items: string[]): CodexApprovalLevel[] {
  const norm = items.map((t) => t.trim().toLowerCase())
  return LEVEL_ORDER.filter((l) => norm.some((t) => t.startsWith(LEVEL_LABEL[l].toLowerCase())))
}

/** Read the level back off the composer button's own text. */
export function levelFromLabel(label: string | null | undefined): CodexApprovalLevel | null {
  const t = (label ?? '').trim().toLowerCase()
  return LEVEL_ORDER.find((l) => t.startsWith(LEVEL_LABEL[l].toLowerCase())) ?? null
}
