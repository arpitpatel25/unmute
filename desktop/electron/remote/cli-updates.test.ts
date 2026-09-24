import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CliUpdater,
  MIN_CLI_VERSIONS,
  claudeAutoUpdateDisabled,
  compareVersions,
  detectChannel,
  parseVersion,
  updateCli,
  type CliId,
  type CliUpdateDeps,
} from './cli-updates'

const HOME = '/Users/me'

test('parseVersion reads both CLIs\' --version lines', () => {
  assert.equal(parseVersion('2.1.280 (Claude Code)\n'), '2.1.280')
  assert.equal(parseVersion('codex-cli 0.156.1'), '0.156.1')
  assert.equal(parseVersion('no version here'), null)
})

test('compareVersions is numeric, not lexical', () => {
  assert.equal(compareVersions('2.1.280', '2.1.281'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

test('detectChannel reads the install channel off the real binary path', () => {
  const env = { home: HOME }
  assert.deepEqual(detectChannel('claude', `${HOME}/.local/share/claude/versions/2.1.280`, env), { kind: 'self-update' })
  assert.deepEqual(detectChannel('claude', `${HOME}/.claude/local/node_modules/.bin/claude`, env), { kind: 'self-update' })
  assert.deepEqual(
    detectChannel('codex', '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js', env),
    { kind: 'npm', prefix: '/opt/homebrew' },
  )
  assert.deepEqual(
    detectChannel('claude', `${HOME}/.nvm/versions/node/v22.1.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, env),
    { kind: 'npm', prefix: `${HOME}/.nvm/versions/node/v22.1.0` },
  )
  assert.deepEqual(
    detectChannel('claude', '/opt/homebrew/Caskroom/claude-code/2.1.280/claude', env),
    { kind: 'brew', brew: '/opt/homebrew/bin/brew', name: 'claude-code', cask: true },
  )
  assert.deepEqual(
    detectChannel('codex', '/usr/local/Cellar/codex/0.150.0/bin/codex', env),
    { kind: 'brew', brew: '/usr/local/bin/brew', name: 'codex', cask: false },
  )
  assert.deepEqual(detectChannel('codex', `${HOME}/.codex/packages/standalone/current/bin/codex`, env), { kind: 'installer' })
  assert.deepEqual(detectChannel('codex', '/Applications/ChatGPT.app/Contents/Resources/codex', env), { kind: 'app-bundled' })
  assert.deepEqual(detectChannel('codex', '/some/odd/place/codex', env), { kind: 'unknown' })
  // Another package's node_modules is not an npm install OF this CLI.
  assert.deepEqual(detectChannel('codex', '/opt/homebrew/lib/node_modules/some-wrapper/codex', env), { kind: 'unknown' })
})

test('claudeAutoUpdateDisabled honours DISABLE_AUTOUPDATER from env or Claude settings', () => {
  assert.equal(claudeAutoUpdateDisabled({ DISABLE_AUTOUPDATER: '1' }, null), true)
  assert.equal(claudeAutoUpdateDisabled({}, '{"env":{"DISABLE_AUTOUPDATER":"1"}}'), true)
  assert.equal(claudeAutoUpdateDisabled({}, '{"env":{}}'), false)
  assert.equal(claudeAutoUpdateDisabled({}, 'not json'), false)
  assert.equal(claudeAutoUpdateDisabled({}, null), false)
})

/** A fake machine: one binary per CLI whose version bumps when updated. */
function fakeDeps(opts: {
  cli?: CliId
  binary?: string | null
  real?: string
  version?: string
  latest?: string | null
  updateCode?: number
  updateBumps?: boolean
  disabled?: boolean
  existing?: string[]
}) {
  const calls: string[] = []
  let version = opts.version ?? '9.0.0'
  const latest = opts.latest === undefined ? '9.0.1' : opts.latest
  const deps: CliUpdateDeps = {
    resolveBinary: async () => (opts.binary === undefined ? '/bin/cli' : opts.binary),
    realpath: () => opts.real ?? '/bin/cli',
    exists: (p) => (opts.existing ?? []).includes(p),
    async run(command, args) {
      calls.push(`${command} ${args.join(' ')}`)
      if (args[0] === '--version') return { code: 0, stdout: `${version} (CLI)\n`, stderr: '' }
      const code = opts.updateCode ?? 0
      if (code === 0 && opts.updateBumps !== false && latest) version = latest
      return { code, stdout: '', stderr: code ? 'EACCES: permission denied' : '' }
    },
    latestVersion: async (pkg) => { calls.push(`latest ${pkg}`); return latest },
    async runInstaller(cli) {
      calls.push(`installer ${cli}`)
      if (latest) version = latest
      return { ok: true }
    },
    disabled: () => opts.disabled === true,
    home: HOME,
  }
  return { deps, calls }
}

test('an outdated native Claude runs `claude update` and reports the new version', async () => {
  const { deps, calls } = fakeDeps({ binary: `${HOME}/.local/bin/claude`, real: `${HOME}/.local/share/claude/versions/2.1.280`, version: '2.1.280', latest: '2.1.281' })
  assert.deepEqual(await updateCli('claude', deps), { cli: 'claude', state: 'updated', from: '2.1.280', to: '2.1.281' })
  assert.deepEqual(calls, [
    `${HOME}/.local/bin/claude --version`,
    'latest @anthropic-ai/claude-code',
    `${HOME}/.local/bin/claude update`,
    `${HOME}/.local/bin/claude --version`,
  ])
})

test('an npm-installed Codex is updated with the npm that owns its prefix', async () => {
  const { deps, calls } = fakeDeps({
    binary: '/opt/homebrew/bin/codex',
    real: '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
    existing: ['/opt/homebrew/bin/npm'],
  })
  assert.equal((await updateCli('codex', deps)).state, 'updated')
  assert.ok(calls.includes('/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @openai/codex@latest'), calls.join('\n'))
})

test('a standalone Codex install is upgraded by re-running the official installer', async () => {
  const { deps, calls } = fakeDeps({ real: `${HOME}/.codex/packages/standalone/current/bin/codex` })
  assert.equal((await updateCli('codex', deps)).state, 'updated')
  assert.ok(calls.includes('installer codex'))
})

test('a current CLI is left alone', async () => {
  const { deps, calls } = fakeDeps({ version: '9.0.1', latest: '9.0.1' })
  assert.deepEqual(await updateCli('codex', deps), { cli: 'codex', state: 'current', version: '9.0.1' })
  assert.equal(calls.length, 2)
})

test('the copy inside ChatGPT.app is reported, never touched', async () => {
  const { deps, calls } = fakeDeps({ real: '/Applications/ChatGPT.app/Contents/Resources/codex' })
  const result = await updateCli('codex', deps)
  assert.deepEqual(result, { cli: 'codex', state: 'outdated', version: '9.0.0', latest: '9.0.1', channel: 'app-bundled' })
  assert.equal(calls.filter((c) => !c.includes('--version') && !c.startsWith('latest')).length, 0)
})

test('an update that fails keeps the error and the command the user can run', async () => {
  const { deps } = fakeDeps({ real: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', updateCode: 243 })
  const result = await updateCli('codex', deps)
  assert.equal(result.state, 'failed')
  assert.ok(result.state === 'failed' && /EACCES/.test(result.detail))
  assert.ok(result.state === 'failed' && result.command === 'npm install -g @openai/codex@latest')
})

test('a brew upgrade that changes nothing (Homebrew lagging npm) stays outdated, not failed', async () => {
  const { deps } = fakeDeps({ real: '/opt/homebrew/Caskroom/codex/1.0.0/codex', updateBumps: false })
  const result = await updateCli('codex', deps)
  assert.equal(result.state, 'outdated')
})

test('nothing runs when the CLI is missing, disabled, or the latest version is unknown', async () => {
  assert.deepEqual(await updateCli('claude', fakeDeps({ binary: null }).deps), { cli: 'claude', state: 'not-installed' })
  assert.deepEqual(await updateCli('claude', fakeDeps({ disabled: true }).deps), { cli: 'claude', state: 'disabled' })
  const offline = fakeDeps({ latest: null })
  assert.equal((await updateCli('claude', offline.deps)).state, 'unknown')
  assert.ok(!offline.calls.some((c) => c.endsWith(' update')))
})

test('CliUpdater waits while a task is running, then checks both CLIs and reschedules', async () => {
  const timers: Array<{ fn: () => void; ms: number }> = []
  let busy = true
  const results: string[] = []
  const updater = new CliUpdater({
    deps: fakeDeps({ version: '9.0.1', latest: '9.0.1' }).deps,
    busy: () => busy,
    onResult: (r) => results.push(`${r.cli}:${r.state}`),
    firstDelayMs: 1, busyRetryMs: 2, intervalMs: 3,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return {} },
  })
  await updater.start()
  assert.deepEqual(timers.map((t) => t.ms), [1])
  timers.shift()!.fn()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(timers.map((t) => t.ms), [2])
  assert.deepEqual(results, [])

  busy = false
  timers.shift()!.fn()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(results, ['claude:current', 'codex:current'])
  assert.deepEqual(timers.map((t) => t.ms), [3])
})

test('a CLI below the minimum is updated even when the registry cannot be reached', async () => {
  const { deps, calls } = fakeDeps({ binary: `${HOME}/.local/bin/claude`, real: `${HOME}/.local/share/claude/versions/2.0.67`, version: '2.0.67', latest: null })
  const result = await updateCli('claude', deps)
  assert.equal(result.state, 'outdated')
  assert.ok(result.state === 'outdated' && result.belowMinimum === true)
  assert.ok(calls.includes(`${HOME}/.local/bin/claude update`), calls.join('\n'))
})

test('a below-minimum copy Unmute may not touch is flagged as below the minimum', async () => {
  const { deps } = fakeDeps({ real: '/Applications/ChatGPT.app/Contents/Resources/codex', version: '0.120.0', latest: '0.156.1' })
  const result = await updateCli('codex', deps)
  assert.deepEqual(result, { cli: 'codex', state: 'outdated', version: '0.120.0', latest: '0.156.1', channel: 'app-bundled', belowMinimum: true })
})

test('the minimums are the measured ones', () => {
  assert.deepEqual(MIN_CLI_VERSIONS, { claude: '2.1.38', codex: '0.136.0' })
})

/** A Mac where each CLI is either installed at a version or absent, and the
 *  installer puts the missing one in place. */
function machine(installed: Partial<Record<CliId, string>>, opts: { installerOk?: boolean } = {}) {
  const versions = { ...installed }
  const calls: string[] = []
  const deps: CliUpdateDeps = {
    resolveBinary: async (cli) => (versions[cli] ? `/bin/${cli}` : null),
    realpath: (p) => p,
    exists: () => false,
    async run(command, args) {
      calls.push(`${command} ${args.join(' ')}`)
      const cli = command.split('/').pop() as CliId
      return { code: 0, stdout: `${versions[cli]}\n`, stderr: '' }
    },
    latestVersion: async () => '9.9.9',
    async runInstaller(cli) {
      calls.push(`installer ${cli}`)
      if (opts.installerOk === false) return { ok: false, detail: 'curl: (6) Could not resolve host' }
      versions[cli] = '9.9.9'
      return { ok: true }
    },
    disabled: () => false,
    home: HOME,
  }
  return { deps, calls }
}

test('a missing CLI is installed only when asked to', async () => {
  const { deps, calls } = machine({})
  assert.deepEqual(await updateCli('codex', deps), { cli: 'codex', state: 'not-installed' })
  assert.deepEqual(await updateCli('codex', deps, { installIfMissing: true }), { cli: 'codex', state: 'installed', version: '9.9.9' })
  assert.deepEqual(calls.filter((c) => c.startsWith('installer')), ['installer codex'])
})

test('a failed install is reported with the installer\'s reason', async () => {
  const { deps } = machine({}, { installerOk: false })
  assert.deepEqual(await updateCli('claude', deps, { installIfMissing: true }), { cli: 'claude', state: 'install-failed', detail: 'curl: (6) Could not resolve host' })
})

test('a disabled CLI is never installed', async () => {
  const { deps, calls } = machine({})
  assert.deepEqual(await updateCli('claude', { ...deps, disabled: () => true }, { installIfMissing: true }), { cli: 'claude', state: 'disabled' })
  assert.equal(calls.length, 0)
})

function updaterOn(deps: CliUpdateDeps) {
  const timers: number[] = []
  const results: string[] = []
  const updater = new CliUpdater({
    deps, busy: () => false, onResult: (r) => results.push(`${r.cli}:${r.state}`),
    firstDelayMs: 1, intervalMs: 3,
    setTimer: (_fn, ms) => { timers.push(ms); return {} },
  })
  return { updater, timers, results }
}

test('with no agent on the Mac, start installs both at once instead of waiting', async () => {
  const { updater, timers, results } = updaterOn(machine({}).deps)
  await updater.start()
  assert.deepEqual(results, ['claude:installed', 'codex:installed'])
  assert.deepEqual(timers, [3])
})

test('a Mac with one agent never has the other installed', async () => {
  const { deps, calls } = machine({ codex: '9.9.9' })
  const { updater, results } = updaterOn(deps)
  await updater.runOnce()
  assert.deepEqual(results, ['claude:not-installed', 'codex:current'])
  assert.ok(!calls.some((c) => c.startsWith('installer')))
})

test('start skips the delay when every installed CLI is below the minimum', async () => {
  const old = updaterOn(machine({ claude: '2.0.67' }).deps)
  await old.updater.start()
  assert.equal(old.results.length, 2)
  assert.deepEqual(old.timers, [3])

  const fine = updaterOn(machine({ claude: '2.0.67', codex: '0.156.1' }).deps)
  await fine.updater.start()
  assert.deepEqual(fine.results, [])
  assert.deepEqual(fine.timers, [1])
})
