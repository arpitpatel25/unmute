import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProviderId } from './types'

export type ProviderInstallResult =
  | { provider: ProviderId; state: 'installed' }
  | { provider: ProviderId; state: 'failed'; detail: string }

type RunResult = { code: number | null; stdout: string; stderr: string }

export interface ProviderInstallDeps {
  makeTempDir(): Promise<string>
  download(url: string, destination: string): Promise<void>
  run(command: string, args: string[]): Promise<RunResult>
  removeTempDir(path: string): Promise<void>
}

const INSTALLER_URLS: Record<ProviderId, string> = {
  claude: 'https://claude.ai/install.sh',
  codex: 'https://chatgpt.com/codex/install.sh',
}

function exec(command: string, args: string[]): Promise<RunResult> {
  return new Promise(resolve => {
    // Codex's installer ends by asking "Start Codex now?" — on /dev/tty when
    // there is one, otherwise on stdin, which execFile leaves open. Either way
    // nobody answers, so the install sat out the whole timeout and was then
    // reported as failed. CODEX_NON_INTERACTIVE skips every prompt.
    const env = { ...process.env, CODEX_NON_INTERACTIVE: '1' }
    execFile(command, args, { env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === 'number'
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export const defaultProviderInstallDeps: ProviderInstallDeps = {
  makeTempDir: () => mkdtemp(join(tmpdir(), 'unmute-provider-install-')),
  async download(url, destination) {
    const result = await exec('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--output', destination, url])
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not download the installer.')
  },
  run: exec,
  removeTempDir: path => rm(path, { recursive: true, force: true }),
}

export async function installProvider(
  provider: ProviderId,
  deps: ProviderInstallDeps = defaultProviderInstallDeps,
): Promise<ProviderInstallResult> {
  const directory = await deps.makeTempDir()
  const installer = join(directory, 'install.sh')
  try {
    await deps.download(INSTALLER_URLS[provider], installer)
    const result = await deps.run('/bin/sh', [installer])
    if (result.code !== 0) {
      return { provider, state: 'failed', detail: result.stderr.trim() || result.stdout.trim() || 'The installer did not finish successfully.' }
    }
    return { provider, state: 'installed' }
  } catch (error) {
    return { provider, state: 'failed', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    await deps.removeTempDir(directory).catch(() => undefined)
  }
}

export function launchProviderLogin(
  provider: ProviderId,
  binary: string,
  launch: (command: string, args: string[]) => void = (command, args) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env })
    child.on('error', error => console.warn(`[onboarding] Could not launch ${provider} sign-in:`, error))
    child.unref()
  },
): void {
  launch(binary, provider === 'claude' ? ['auth', 'login'] : ['login'])
}
