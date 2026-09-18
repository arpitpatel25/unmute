/**
 * IS THIS A FAILURE ANOTHER MODEL WOULD FIX?
 *
 * Only some are. A model that is not on this account, is out of its usage
 * allowance, rate-limited or overloaded — a different model may well answer.
 * Not signed in, no network, a conversation too long — switching models only
 * wastes a request and hides the real problem, so those stay failures.
 *
 * Codex says it structurally: every turn error carries `codexErrorInfo`. The
 * one gap, measured on codex-cli 0.153.2, is an unsupported model — that
 * arrives as `other` with the API's 400 in the message:
 *   "The 'gpt-x' model is not supported when using Codex with a ChatGPT account."
 * so that single case is matched on text, narrowly.
 *
 * Claude mostly handles its own fallback (`--fallback-model`, announced by a
 * `model_fallback` system event); what reaches us is what it could not route
 * around, identified from the result text as narrowly as possible.
 *
 * Returns a short human reason ("usage limit reached") or undefined.
 */

type CodexErrorInfo = string | Record<string, unknown> | null | undefined

const CODEX_REASONS: Record<string, string> = {
  usageLimitExceeded: 'usage limit reached',
  rateLimitExceeded: 'rate limited',
  serverOverloaded: 'overloaded',
  responseTooManyFailedAttempts: 'not responding',
}

const MODEL_REFUSED = /\bmodel\b[^.]*\b(not supported|not found|not available|unavailable|does not exist|is not enabled|no access)\b|\b(not_found_error|model_not_found|unsupported[_ ]model)\b/i

export function codexModelUnavailable(error: { codexErrorInfo?: CodexErrorInfo; message?: string } | null | undefined): string | undefined {
  if (!error) return undefined
  const info = error.codexErrorInfo
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined
  if (code && CODEX_REASONS[code]) return CODEX_REASONS[code]
  if (MODEL_REFUSED.test(error.message ?? '')) return 'not available on this account'
  return undefined
}

const CLAUDE_PATTERNS: Array<[RegExp, string]> = [
  [MODEL_REFUSED, 'not available on this account'],
  [/\boverloaded(_error)?\b|\b529\b/i, 'overloaded'],
  [/\busage limit\b|\bout of (extra )?usage\b|\blimit reached\b/i, 'usage limit reached'],
  [/\brate[_ ]limit(ed|_error)?\b|\b429\b/i, 'rate limited'],
]

export function claudeModelUnavailable(message: string | undefined): string | undefined {
  if (!message) return undefined
  for (const [pattern, reason] of CLAUDE_PATTERNS) if (pattern.test(message)) return reason
  return undefined
}

/** Claude's own `model_fallback` trigger, in words. */
export function claudeFallbackReason(trigger: unknown): string {
  return ({ model_not_found: 'not available', overloaded: 'overloaded', rate_limited: 'rate limited', usage_limit: 'usage limit reached' } as Record<string, string>)[String(trigger)] ?? 'unavailable'
}
