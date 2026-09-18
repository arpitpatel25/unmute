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


/** Codex names its enums in Rust in its error text. */
const SANDBOX_NAMES: Record<string, string> = { ReadOnly: 'read-only', WorkspaceWrite: 'workspace-write', DangerFullAccess: 'danger-full-access' }
const APPROVAL_NAMES: Record<string, string> = { UnlessTrusted: 'untrusted', OnFailure: 'on-failure', OnRequest: 'on-request', Never: 'never' }

/**
 * LEARN THE LIMIT FROM THE REFUSAL. The up-front query can miss a policy — a
 * ChatGPT workspace policy fetched later, a Codex too old to answer, a policy
 * pushed after startup — but the refusal always names what is allowed.
 * Measured on codex-cli 0.153.2; one dial per refusal, so a machine that caps
 * both is learned in two rounds:
 *
 *   invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite]
 *   invalid value for `approval_policy`: `Never` is not in the allowed set [UnlessTrusted, OnRequest]
 *   `approval_policy = "never"` cannot be used because requirements do not allow `sandbox_mode = "danger-full-access"`
 *
 * Returns the requirements with what was learned folded in, or null when the
 * error is not a policy refusal.
 */
export function learnFromRejection(message: string, known: CodexRequirements | null): CodexRequirements | null {
  const set = (field: string, names: Record<string, string>): string[] | undefined => {
    const m = new RegExp('invalid value for `' + field + '`: `\\w+` is not in the allowed set \\[([^\\]]*)\\]').exec(message)
    return m ? m[1].split(',').map(s => names[s.trim()]).filter(Boolean) : undefined
  }
  const sandbox = set('sandbox_mode', SANDBOX_NAMES)
  const approval = set('approval_policy', APPROVAL_NAMES)
  const forbidden = /requirements do not allow `sandbox_mode = "([a-z-]+)"`/.exec(message)?.[1]
  if (!sandbox && !approval && !forbidden) return null
  const next: CodexRequirements = { ...known }
  if (sandbox?.length) next.allowedSandboxModes = sandbox
  if (approval?.length) next.allowedApprovalPolicies = approval
  if (forbidden) {
    const base = Array.isArray(next.allowedSandboxModes) ? next.allowedSandboxModes : SANDBOX_ORDER
    next.allowedSandboxModes = base.filter(m => m !== forbidden)
  }
  return next
}

/** A read answer overrides nothing learned from a refusal: learned limits are
 *  what Codex actually enforced, so they narrow whatever the query said. */
export function mergeRequirements(read: CodexRequirements | null, learned: CodexRequirements | null): CodexRequirements | null {
  if (!learned) return read
  if (!read) return learned
  const narrow = (a: unknown[] | null | undefined, b: unknown[] | null | undefined) =>
    Array.isArray(a) && Array.isArray(b) ? a.filter(v => b.includes(v)) : Array.isArray(b) ? b : a
  return { ...read,
    allowedSandboxModes: narrow(read.allowedSandboxModes, learned.allowedSandboxModes),
    allowedApprovalPolicies: narrow(read.allowedApprovalPolicies, learned.allowedApprovalPolicies) }
}

/** What Codex says it applied, from a thread/start|resume|fork response. */
export function appliedPosture(response: unknown, fallback: { approvalPolicy: string; sandbox: string }): { approvalPolicy: string; sandbox: string } {
  const r = response as { approvalPolicy?: unknown; sandbox?: { type?: unknown } | unknown } | null
  const type = typeof r?.sandbox === 'object' && r.sandbox ? (r.sandbox as { type?: unknown }).type : r?.sandbox
  const sandbox = ({ dangerFullAccess: 'danger-full-access', workspaceWrite: 'workspace-write', readOnly: 'read-only',
    'danger-full-access': 'danger-full-access', 'workspace-write': 'workspace-write', 'read-only': 'read-only' } as Record<string, string>)[String(type)]
  return {
    approvalPolicy: typeof r?.approvalPolicy === 'string' ? r.approvalPolicy : fallback.approvalPolicy,
    sandbox: sandbox ?? fallback.sandbox,
  }
}
