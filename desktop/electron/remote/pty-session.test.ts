import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeCodeExecutor } from './pty-session.ts'

// ── Fake node-pty so we can assert spawn args/env without a real terminal ──
function makeFakePty() {
  const calls: { file?: string; args?: string[]; opts?: Record<string, unknown> } = {}
  let dataCb: ((d: string) => void) | null = null
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  const writes: string[] = []
  let killed = false
  const loader = () => ({
    spawn(file: string, args: string[], opts: Record<string, unknown>) {
      calls.file = file
      calls.args = args
      calls.opts = opts
      return {
        onData(cb: (d: string) => void) { dataCb = cb },
        onExit(cb: (e: { exitCode: number }) => void) { exitCb = cb },
        write(d: string) { writes.push(d) },
        kill() { killed = true },
      }
    },
  })
  return {
    loader,
    calls,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (exitCode: number) => exitCb?.({ exitCode }),
    writes,
    isKilled: () => killed,
  }
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

test('writeDraft keeps text and Ctrl-V image ingestion in one unsubmitted PTY turn', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })

  ex.writeDraftText('compare these')
  const accepted = ex.pasteImage()
  fake.emitData('\u001b[32m[Image #1]\u001b[0m')
  assert.equal(await accepted, true)
  ex.submitDraft()

  assert.deepEqual(fake.writes, ['compare these', '\x16', '\r'])
})

test('an unrelated PTY redraw is not image acceptance', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  const accepted = ex.pasteImage()
  fake.emitData('Working… 42%')
  assert.equal(await accepted, false)
})

test('clearDraft removes a partial attachment turn without submitting it', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  ex.writeDraftText('keep me')
  ex.clearDraft()
  assert.deepEqual(fake.writes, ['keep me', '\x15'])
})

test('model + chrome flags are passed (--model opus, --chrome)', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader, model: 'opus', chrome: true })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  const args = fake.calls.args || []
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'opus', 'has --model opus')
  assert.ok(args.includes('--chrome'), 'has --chrome')
  assert.ok(!args.includes('-p') && !args.includes('--print'), 'still never headless')
})

test('no model/chrome flags when not requested', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  const args = fake.calls.args || []
  assert.ok(!args.includes('--model'))
  assert.ok(!args.includes('--chrome'))
})

test('sandbox: addDirs become --add-dir args (PRD §10.6)', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader, addDirs: ['/Users/x/Downloads', '/Users/x/projects'] })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  const args = fake.calls.args || []
  assert.deepEqual(
    args,
    ['--add-dir', '/Users/x/Downloads', '--add-dir', '/Users/x/projects'],
  )
})

test('no sandbox (no addDirs) ⇒ no --add-dir args', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  assert.ok(!(fake.calls.args || []).includes('--add-dir'))
})

test('kill marks the session not-alive and calls pty.kill', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  assert.equal(ex.alive, true)
  ex.kill()
  assert.equal(fake.isKilled(), true)
})

test('interrupt sends Ctrl-C without killing the resumable provider resource', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  ex.interrupt()
  assert.deepEqual(fake.writes, ['\x03'])
  assert.equal(fake.isKilled(), false)
})

test('onExit reports the owned PTY exit event once', async () => {
  const fake = makeFakePty()
  const ex = new ClaudeCodeExecutor({ ptyLoader: fake.loader })
  const exits: number[] = []
  ex.onExit(({ exitCode }) => exits.push(exitCode))
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  fake.emitExit(7)
  assert.deepEqual(exits, [7])
})
