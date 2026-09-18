/**
 * CODEX REQUIREMENTS — the ceiling an administrator put on this machine.
 *
 * A managed Codex (MDM `com.openai.codex:requirements_toml_base64`,
 * /etc/codex/requirements.toml, or a ChatGPT workspace policy) can forbid
 * sandbox modes and approval policies. Codex does not downgrade an explicit
 * request that breaks those rules — it REFUSES it. Measured on codex-cli
 * 0.153.2 with `allowed_sandbox_modes = ["read-only", "workspace-write"]`:
 *
 *   thread/start {approvalPolicy:'never', sandbox:'danger-full-access'}
 *     → -32600 "`approval_policy = "never"` cannot be used because
 *       requirements do not allow `sandbox_mode = "danger-full-access"`"
 *   turn/start {sandboxPolicy:{type:'dangerFullAccess'}}
 *     → -32600 "`DangerFullAccess` is not in the allowed set
 *       [ReadOnly, WorkspaceWrite] (set by MDM ...)"
 *
 * Unmute asked for full access unconditionally when the user had consented,
 * so on a company laptop every Unmute-created Codex session died at its first
 * request. The fix is to ask for the most the machine ALLOWS: read the
 * requirements once (`configRequirements/read`, null when unmanaged) and
 * lower each dial to the highest permitted value at or below what was asked.
 */

/** Least to most permissive. */
const SANDBOX_ORDER = ['read-only', 'workspace-write', 'danger-full-access']
/** Most to least asking. `on-failure` is deprecated but still in the enum. */
const APPROVAL_ORDER = ['untrusted', 'on-failure', 'on-request', 'never']

export interface CodexRequirements {
  allowedApprovalPolicies?: unknown[] | null
  allowedSandboxModes?: unknown[] | null
}

/** Normalize a `configRequirements/read` result. Null when nothing is enforced
 *  or the Codex is too old to answer. */
export function requirementsFrom(result: unknown): CodexRequirements | null {
  const r = (result as { requirements?: unknown } | null)?.requirements
  return r && typeof r === 'object' ? r as CodexRequirements : null
}

/** The highest allowed value at or below `wanted`; if everything allowed is
 *  above it, the least permissive allowed value. Unrestricted → `wanted`. */
function clampTo(wanted: string, allowed: unknown[] | null | undefined, order: string[]): string {
  if (!Array.isArray(allowed)) return wanted
  const permitted = order.filter(v => allowed.includes(v))
  if (!permitted.length || permitted.includes(wanted)) return wanted
  const at = order.indexOf(wanted)
  const below = permitted.filter(v => order.indexOf(v) <= at)
  return below.length ? below[below.length - 1] : permitted[0]
}

/** Lower a posture to what the requirements permit. */
export function clampPosture<T extends { approvalPolicy: string; sandbox: string }>(o: T, req: CodexRequirements | null): T {
  if (!req) return o
  const sandbox = clampTo(o.sandbox, req.allowedSandboxModes, SANDBOX_ORDER)
  const approvalPolicy = clampTo(o.approvalPolicy, req.allowedApprovalPolicies, APPROVAL_ORDER)
  return sandbox === o.sandbox && approvalPolicy === o.approvalPolicy ? o : { ...o, sandbox, approvalPolicy }
}

