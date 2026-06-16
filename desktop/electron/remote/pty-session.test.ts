import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeCodeExecutor } from './pty-session.ts'

// ── Fake node-pty so we can assert spawn args/env without a real terminal ──
function makeFakePty() {
  const calls: { file?: string; args?: string[]; opts?: Record<string, unknown> } = {}
  let dataCb: ((d: string) => void) | null = null
  const writes: string[] = []
  let killed = false
  const loader = () => ({
    spawn(file: string, args: string[], opts: Record<string, unknown>) {
      calls.file = file
      calls.args = args
      calls.opts = opts
      return {
        onData(cb: (d: string) => void) { dataCb = cb },
        onExit(_cb: (e: { exitCode: number }) => void) { /* not used here */ },
        write(d: string) { writes.push(d) },
        kill() { killed = true },
      }
    },
  })
  return { loader, calls, emitData: (d: string) => dataCb?.(d), writes, isKilled: () => killed }
}

test('BILLING: spawn args never include -p / SDK flags (PRD §3.2)', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  assert.equal(fake.calls.file, 'claude')
  assert.ok(!(fake.calls.args || []).includes('-p'), 'must not use headless -p')
  assert.ok(!(fake.calls.args || []).includes('--print'), 'must not use --print')
})

test('BILLING: ANTHROPIC_API_KEY (and aliases) stripped from env (PRD §3.2)', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({
    cwd: '/tmp/t',
    env: { ANTHROPIC_API_KEY: 'sk-xxx', ANTHROPIC_AUTH_TOKEN: 'tok', PATH: '/usr/bin' },
    taskId: 't1',
  })
  const env = fake.calls.opts?.env as Record<string, string>
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(env.PATH, '/usr/bin') // unrelated env preserved
})

test('isReady resolves after a quiet window following output', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  fake.emitData('Claude Code TUI booting…') // first paint
  const t0 = Date.now()
  await ex.isReady()
  assert.ok(Date.now() - t0 >= 600, 'should wait for the quiet window')
})

test('writeStdin sends the text followed by a carriage return', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  ex.writeStdin('do the thing')
  assert.deepEqual(fake.writes, ['do the thing', '\r'])
})

test('kill marks the session not-alive and calls pty.kill', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  assert.equal(ex.alive, true)
  ex.kill()
  assert.equal(fake.isKilled(), true)
})
