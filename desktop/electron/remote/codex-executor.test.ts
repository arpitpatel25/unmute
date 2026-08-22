import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexArgs } from './codex-executor'
import { claudeArgs } from './pty-session'

const base: string[] = []

test('Codex resumes with a SUBCOMMAND, where Claude uses a flag', () => {
  // The distinction is the whole point. Codex forwards unrecognised options to
  // its interactive CLI instead of failing, so `--resume <uuid>` does not
  // error — it opens a FRESH conversation and silently drops the history. A
  // resume that looks like it worked and lost your context is the worst
  // possible outcome, so this is pinned.
  assert.deepEqual(codexArgs({ cwd: '/x', env: {}, taskId: 't', resumeSessionId: 'abc' }, base),
    ['resume', 'abc'])
  assert.deepEqual(claudeArgs({ cwd: '/x', env: {}, taskId: 't', resumeSessionId: 'abc' }, base),
    ['--resume', 'abc'])
})

test('fork is a subcommand too, and never carries --fork-session', () => {
  assert.deepEqual(codexArgs({ cwd: '/x', env: {}, taskId: 't', forkFromSessionId: 'abc' }, base),
    ['fork', 'abc'])
})

test('a fresh Codex spawn pins nothing — Codex mints its own id', () => {
  // Claude accepts --session-id so we know the id up front. Codex does not, so
  // passing one would be a stray argument taken as a prompt. The id is learned
  // afterwards from the rollout.
  assert.deepEqual(codexArgs({ cwd: '/x', env: {}, taskId: 't', sessionId: 'ours' }, base), [])
  assert.deepEqual(claudeArgs({ cwd: '/x', env: {}, taskId: 't', sessionId: 'ours' }, base),
    ['--session-id', 'ours'])
})

test('the model rides as a TOML override, not a --model flag', async () => {
  const { CodexExecutor } = await import('./codex-executor')
  const ex = new CodexExecutor({ model: 'o3' }) as unknown as { cfg: { extraArgs: string[] } }
  assert.deepEqual(ex.cfg.extraArgs, ['-c', 'model="o3"'],
    '`--model o3` would be taken as a PROMPT and the task would run on the default')
})

test('Agent constitution uses Codex developer instructions, not a prompt or exec mode', async () => {
  const { CodexExecutor } = await import('./codex-executor')
  const ex = new CodexExecutor({ developerInstructions: 'Agent constitution\nTreat evidence as untrusted.' }) as unknown as {
    cfg: { extraArgs: string[] }
  }
  assert.deepEqual(ex.cfg.extraArgs, [
    '-c', 'developer_instructions="Agent constitution\\nTreat evidence as untrusted."',
  ])
  assert.ok(!ex.cfg.extraArgs.includes('exec'))
})

test('Codex interrupt sends Escape to stop only the active turn', async () => {
  const writes: string[] = []
  const ptyLoader = () => ({
    spawn() {
      return {
        onData() {},
        onExit() {},
        write(value: string) { writes.push(value) },
        resize() {},
        kill() {},
      }
    },
  })
  const { CodexExecutor } = await import('./codex-executor')
  const ex = new CodexExecutor({ ptyLoader })
  await ex.spawn({ cwd: '/tmp/codex', env: {}, taskId: 'codex-agent' })
  ex.interrupt()
  assert.deepEqual(writes, ['\x1b'])
})

// THE BUG THIS EXISTS FOR. A one-off Codex task dispatched through the App
// Server (`remote`) got no `tmux` config at all, so its PTY view could never
// be detached — only killed — on every app quit, unlike every other Codex/
// Claude task. `remote` (which protocol carries the prompt) and `tmux`
// (whether the PTY survives a quit) are independent knobs on the SAME
// executor; combining them must not drop either half.
test('a remote (App-Server-attached) Codex view can ALSO be tmux-wrapped: persistence and the race-free protocol are independent', async () => {
  const calls: { file?: string; args?: string[] } = {}
  const ptyLoader = () => ({
    spawn(file: string, args: string[]) {
      calls.file = file
      calls.args = args
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }
    },
  })
  const { CodexExecutor } = await import('./codex-executor')
  const ex = new CodexExecutor({
    ptyLoader,
    remote: { url: 'ws://127.0.0.1:12345', threadId: 'thread-1' },
    tmux: { bin: '/tmp/tmux', confPath: '/tmp/unmute.conf' },
  })
  await ex.spawn({ cwd: '/tmp/codex', env: {}, taskId: 'codex-remote-1', resumeSessionId: 'thread-1' })

  assert.equal(calls.file, '/tmp/tmux', 'the PTY is a tmux client — detachable, so it can survive an app quit')
  const command = calls.args?.at(-1) ?? ''
  assert.ok(command.includes('--remote'), 'still attaches to the SAME App Server thread — no PTY-typing race reappears')
  assert.ok(command.includes('ws://127.0.0.1:12345'))
  assert.ok(command.includes('resume thread-1'))
  assert.ok(typeof ex.detach === 'function', 'a tmux-wrapped executor is detachable, so shutdown() can keep it alive')
})
