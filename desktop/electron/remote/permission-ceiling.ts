/**
 * THE MOST THE MACHINE ALLOWS — one rule for both providers.
 *
 * Unmute asks Codex and Claude for full access when the user wants it. A
 * company-managed machine can forbid that, per provider, and the two fail in
 * opposite ways (measured 2026-09-18):
 *
 *   Codex REFUSES. A turn asking for `danger-full-access` under a policy that
 *   allows only [ReadOnly, WorkspaceWrite] is rejected with -32600, so the
 *   task never runs (codex/requirements.ts, codex/hub.ts).
 *
 *   Claude DOWNGRADES SILENTLY. `--permission-mode bypassPermissions` under
 *   `disableBypassPermissionsMode` starts in `auto`, or all the way down in
 *   `default` when auto is disabled too — lower than the `acceptEdits` it
 *   would have allowed (claude/task-session.ts steps it back up).
 *
 * Either way the rule is: effective = min(what the user chose, what this
 * machine allows). Full access stays the default wherever it is allowed.
 *
 * This module holds the vocabulary both sides share and a cheap, cached read
 * of the managed policy files, for the UI to know BEFORE a session starts.
 * The agents themselves remain the authority: what they report applying wins
 * over anything read here.
 */
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/** What a provider actually applied, when a machine policy made it lower than
 *  what Unmute asked for. */
export interface PermissionLimit {
  provider: 'codex' | 'claude'
  /** Human label of the level Unmute asked for. */
  asked: string
  /** Human label of the level the provider applied. */
  effective: string
  /** One line for the session's permission row. */
  reason: string
}

/* ── Claude ─────────────────────────────────────────────────────────────── */

/** Claude's permission modes, least to most autonomous. `plan` and `dontAsk`
 *  are deliberate user choices, never fallbacks, so they sit outside it. */
export const CLAUDE_LADDER = ['manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const
export type ClaudeLadderMode = typeof CLAUDE_LADDER[number]

/** Claude reports its ask-for-everything mode as `default`; Unmute calls it
 *  `manual`. Anything off the ladder comes back undefined. */
export function claudeLadderMode(mode: unknown): ClaudeLadderMode | undefined {
  const m = mode === 'default' ? 'manual' : mode
  return (CLAUDE_LADDER as readonly unknown[]).includes(m) ? m as ClaudeLadderMode : undefined
}

export function claudeModeLabel(mode: string): string {
  return ({ bypassPermissions: 'Full access', auto: 'Auto', acceptEdits: 'Accept edits', manual: 'Ask for approval', default: 'Ask for approval', plan: 'Plan mode', dontAsk: "Don't ask" } as Record<string, string>)[mode] ?? mode
}

export function claudeLimit(asked: string, effective: string): PermissionLimit {
  const label = claudeModeLabel(effective)
  return { provider: 'claude', asked: claudeModeLabel(asked), effective: label, reason: `Claude is limited by your organization's policy · running as ${label}` }
}

/* ── Codex ──────────────────────────────────────────────────────────────── */

export function codexPostureLabel(p: { approvalPolicy: string; sandbox: string }): string {
  const reach = ({ 'danger-full-access': 'Full access', 'workspace-write': 'Workspace access', 'read-only': 'Read only' } as Record<string, string>)[p.sandbox] ?? p.sandbox
  return p.approvalPolicy === 'never' ? reach : `${reach}, asks for approval`
}

export function codexLimit(asked: { approvalPolicy: string; sandbox: string }, effective: { approvalPolicy: string; sandbox: string }): PermissionLimit {
  const label = codexPostureLabel(effective)
  return { provider: 'codex', asked: codexPostureLabel(asked), effective: label, reason: `Codex is limited by your organization's policy · running with ${label}` }
}

/* ── Managed policy files ───────────────────────────────────────────────── */

export interface ManagedPolicy {
  /** Codex's requirements forbid `danger-full-access`. */
  codexFullAccessForbidden: boolean
  /** Claude's managed settings disable bypassPermissions. */
  claudeBypassForbidden: boolean
  /** Claude's managed settings disable auto mode. */
  claudeAutoForbidden: boolean
}

const NONE: ManagedPolicy = { codexFullAccessForbidden: false, claudeBypassForbidden: false, claudeAutoForbidden: false }
let cached: ManagedPolicy = NONE

/** Last read policy. Never blocks; call refreshManagedPolicy to update it. */
export function managedPolicy(): ManagedPolicy { return cached }

/** Where each product reads its managed policy on macOS. Injectable for tests. */
export interface PolicySources {
  readText: (path: string) => Promise<string | null>
  listDir: (path: string) => Promise<string[]>
  /** A managed-preferences plist as JSON, or null. */
  readPlist: (path: string) => Promise<Record<string, unknown> | null>
  /** `defaults read <domain> <key>` from the user's preference domain. */
  readDefault: (domain: string, key: string) => Promise<string | null>
  user: string
}

const run = (cmd: string, args: string[]) => new Promise<string | null>(resolve =>
  execFile(cmd, args, { timeout: 3000 }, (error, stdout) => resolve(error ? null : String(stdout))))

const defaultSources = (): PolicySources => ({
  readText: path => readFile(path, 'utf8').catch(() => null),
  listDir: path => readdir(path).catch(() => []),
  readPlist: async path => { const out = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]); try { return out ? JSON.parse(out) : null } catch { return null } },
  readDefault: async (domain, key) => (await run('/usr/bin/defaults', ['read', domain, key]))?.trim() || null,
  user: (() => { try { return userInfo().username } catch { return '' } })(),
})

const disabled = (v: unknown) => v === 'disable' || v === true

function claudeFlags(settings: Record<string, any> | null, into: ManagedPolicy): void {
  if (!settings || typeof settings !== 'object') return
  if (disabled(settings.permissions?.disableBypassPermissionsMode)) into.claudeBypassForbidden = true
  if (disabled(settings.permissions?.disableAutoMode) || disabled(settings.disableAutoMode)) into.claudeAutoForbidden = true
}

/** `allowed_sandbox_modes = ["read-only", "workspace-write"]` → forbids full access. */
function codexForbidsFull(toml: string | null): boolean {
  const m = toml?.match(/^\s*allowed_sandbox_modes\s*=\s*\[([^\]]*)\]/m)
  return !!m && !/["']danger-full-access["']/.test(m[1])
}

export async function readManagedPolicy(src: PolicySources = defaultSources()): Promise<ManagedPolicy> {
  const out: ManagedPolicy = { ...NONE }
  const parse = (text: string | null) => { try { return text ? JSON.parse(text) : null } catch { return null } }

  const claudeDir = '/Library/Application Support/ClaudeCode'
  claudeFlags(parse(await src.readText(join(claudeDir, 'managed-settings.json'))), out)
  for (const name of (await src.listDir(join(claudeDir, 'managed-settings.d'))).filter(n => n.endsWith('.json')).sort()) {
    claudeFlags(parse(await src.readText(join(claudeDir, 'managed-settings.d', name))), out)
  }
  for (const plist of ['/Library/Managed Preferences/com.anthropic.claudecode.plist', `/Library/Managed Preferences/${src.user}/com.anthropic.claudecode.plist`]) {
    claudeFlags(await src.readPlist(plist) as Record<string, any> | null, out)
  }

  const decode = (b64: unknown) => typeof b64 === 'string' ? Buffer.from(b64, 'base64').toString('utf8') : null
  const codexSources = [
    await src.readText('/etc/codex/requirements.toml'),
    decode((await src.readPlist('/Library/Managed Preferences/com.openai.codex.plist'))?.requirements_toml_base64),
    decode((await src.readPlist(`/Library/Managed Preferences/${src.user}/com.openai.codex.plist`))?.requirements_toml_base64),
    decode(await src.readDefault('com.openai.codex', 'requirements_toml_base64')),
  ]
  out.codexFullAccessForbidden = codexSources.some(codexForbidsFull)
  return out
}

let refreshing: Promise<ManagedPolicy> | undefined
export function refreshManagedPolicy(src?: PolicySources): Promise<ManagedPolicy> {
  return refreshing ??= readManagedPolicy(src).then(p => { cached = p; return p }).catch(() => cached).finally(() => { refreshing = undefined })
}

/**
 * Flags for a Claude run nobody is watching (router, librarian, legacy
 * terminal doer). `--dangerously-skip-permissions` where bypass is allowed;
 * otherwise the highest mode the policy leaves, so the run still works
 * without prompts wherever the machine permits it.
 */
export function claudeUnattendedArgs(policy: ManagedPolicy = cached): string[] {
  if (!policy.claudeBypassForbidden) return ['--dangerously-skip-permissions']
  return ['--permission-mode', policy.claudeAutoForbidden ? 'acceptEdits' : 'auto']
}
