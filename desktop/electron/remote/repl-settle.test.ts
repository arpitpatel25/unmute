import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settleRepl } from './repl-settle.ts'

test('Codex update prompt selects Skip instead of accepting Update now', async () => {
  let output = `
    ✨ Update available! 0.148.0 -> 0.149.0
    1. Update now (runs npm install -g @openai/codex)
    2. Skip
    3. Skip until next version
    Press enter to continue
  `
  const raw: string[] = []
  const enters: string[] = []
  let reads = 0

  await settleRepl({
    agent: 'codex',
    getOutput: () => {
      reads += 1
      return reads >= 4 ? `${output}\nbypass permissions` : output
    },
    isAlive: () => true,
    sendEnter: () => enters.push('\r'),
    sendRaw: (input) => raw.push(input),
    quietMs: 0,
    pollMs: 1,
    maxWaitMs: 100,
  })

  assert.deepEqual(raw, ['\x1b[B\r'], 'one Down + Enter chooses Skip from Codex’s default Update now selection')
  assert.deepEqual(enters, [], 'the default update choice must never be accepted')
})
