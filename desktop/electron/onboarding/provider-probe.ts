import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

import type { ProviderId } from './types'

export type ProviderProbeResult =
  | { provider: ProviderId; state: 'ready' }
  | { provider: ProviderId; state: 'missing' | 'auth-required' | 'timed-out' | 'failed'; detail: string }

export interface ProbeChild {
  stdout?: { on(event: 'data', listener: (value: Buffer) => void): unknown }
  stderr?: { on(event: 'data', listener: (value: Buffer) => void): unknown }
  stdin?: { end(value?: string): unknown }
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface ProviderProbeDeps {
  resolveBinary(provider: ProviderId): Promise<string | null>
  makeWorkspace(provider: ProviderId): Promise<string>
  removeWorkspace(path: string): Promise<void>
  spawn(command: string, args: string[], options: { cwd: string }): ProbeChild
}

const PROBE_PROMPT = 'This is a readiness check. Do not use tools or modify files. Reply with exactly READY.'
export const PROVIDER_PROBE_TIMEOUT_MS = 20_000

function argvFor(provider: ProviderId): string[] {
  return provider === 'claude'
    ? ['-p', '--output-format', 'json']
    : ['exec', '--skip-git-repo-check', '--ephemeral', '--json']
}

function defaultWhich(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [binary], { env: process.env }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

const CODEX_BUNDLED_CLI = '/Applications/ChatGPT.app/Contents/Resources/codex'

export async function resolveKnownProviderBinary(provider: ProviderId, deps: {
  which(binary: string): Promise<string | null>
  home: string
  exists(path: string): Promise<boolean>
}): Promise<string | null> {
  const pathBinary = await deps.which(provider)
  if (pathBinary) return pathBinary
  const userLocalBinary = join(deps.home, '.local', 'bin', provider)
  if (await deps.exists(userLocalBinary)) return userLocalBinary
  if (provider === 'codex' && await deps.exists(CODEX_BUNDLED_CLI)) return CODEX_BUNDLED_CLI
  return null
}

export const defaultProviderProbeDeps: ProviderProbeDeps = {
  resolveBinary: provider => resolveKnownProviderBinary(provider, {
    which: defaultWhich,
    home: homedir(),
    exists: async path => { try { await stat(path); return true } catch { return false } },
  }),
  makeWorkspace: (provider) => mkdtemp(join(tmpdir(), `unmute-${provider}-readiness-`)),
  removeWorkspace: (path) => rm(path, { recursive: true, force: true }),
  spawn: (command, args, options) => nodeSpawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
}

function classifyFailure(provider: ProviderId, detail: string): ProviderProbeResult {
  if (/log[ -]?in|sign[ -]?in|authentication|unauthori[sz]ed|credential|api key/i.test(detail)) {
    return { provider, state: 'auth-required', detail: detail || 'Sign in to the CLI and retry.' }
  }
  return { provider, state: 'failed', detail: detail || 'The CLI exited before confirming readiness.' }
}

export async function probeProvider(
  provider: ProviderId,
  deps: ProviderProbeDeps = defaultProviderProbeDeps,
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
): Promise<ProviderProbeResult> {
  const workspace = await deps.makeWorkspace(provider)
  let child: ProbeChild | undefined
  try {
    const binary = await deps.resolveBinary(provider)
    if (!binary) return { provider, state: 'missing', detail: `${provider} CLI is not installed.` }

    const outcome = await new Promise<{ kind: 'close'; code: number | null; stdout: string; stderr: string } | { kind: 'error'; detail: string } | { kind: 'timeout' }>((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: Parameters<typeof resolve>[0]) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }

      child = deps.spawn(binary, argvFor(provider), { cwd: workspace })
      child.stdout?.on('data', value => { stdout += value.toString('utf8') })
      child.stderr?.on('data', value => { stderr += value.toString('utf8') })
      child.on('error', error => finish({ kind: 'error', detail: error.message }))
      child.on('close', code => finish({ kind: 'close', code, stdout, stderr }))
      child.stdin?.end(PROBE_PROMPT)

      timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    })

    if (outcome.kind === 'timeout') return { provider, state: 'timed-out', detail: `Readiness check exceeded ${timeoutMs}ms.` }
    if (outcome.kind === 'error') return classifyFailure(provider, outcome.detail)
    if (outcome.code === 0 && /\bREADY\b/.test(outcome.stdout)) return { provider, state: 'ready' }
    return classifyFailure(provider, `${outcome.stderr}\n${outcome.stdout}`.trim())
  } catch (error) {
    return classifyFailure(provider, error instanceof Error ? error.message : String(error))
  } finally {
    try { child?.kill('SIGTERM') } catch { /* already exited */ }
    await deps.removeWorkspace(workspace).catch(() => undefined)
  }
}

export async function probeProviders(
  probe: (provider: ProviderId) => Promise<ProviderProbeResult> = provider => probeProvider(provider),
): Promise<Record<ProviderId, ProviderProbeResult>> {
  const [claude, codex] = await Promise.all([probe('claude'), probe('codex')])
  return { claude, codex }
}
