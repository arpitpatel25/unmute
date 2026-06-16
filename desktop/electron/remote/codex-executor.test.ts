import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexExecutor } from './codex-executor.ts'

function makeFakePty() {
  const calls: { file?: string; args?: string[]; opts?: Record<string, unknown> } = {}
  const loader = () => ({
    spawn(file: string, args: string[], opts: Record<string, unknown>) {
      calls.file = file; calls.args = args; calls.opts = opts
      return { onData() {}, onExit() {}, write() {}, kill() {} }
    },
  })
  return { loader, calls }
}

test('Codex adapter spawns the codex binary, never headless (PRD §11)', async () => {
  const fake = makeFakePty()
  const ex = new CodexExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: {}, taskId: 't1' })
  assert.equal(fake.calls.file, 'codex')
  assert.ok(!(fake.calls.args || []).includes('-p'))
})

test('Codex adapter strips OPENAI_API_KEY to stay off API billing (PRD §11.2)', async () => {
  const fake = makeFakePty()
  const ex = new CodexExecutor({ ptyLoader: fake.loader })
  await ex.spawn({ cwd: '/tmp/t', env: { OPENAI_API_KEY: 'sk-x', PATH: '/usr/bin' }, taskId: 't1' })
  const env = fake.calls.opts?.env as Record<string, string>
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.PATH, '/usr/bin') // unrelated env preserved
})
