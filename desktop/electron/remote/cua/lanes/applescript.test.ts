import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAppleScript } from './applescript'

test('returns trimmed stdout (injected exec)', async () => {
  const out = await runAppleScript('return 1+1', async (args) => {
    assert.deepEqual(args, ['-e', 'return 1+1']); return { stdout: '2\n', stderr: '', code: 0 }
  })
  assert.equal(out, '2')
})

test('throws on osascript error', async () => {
  await assert.rejects(() => runAppleScript('bad', async () => ({ stdout: '', stderr: 'boom', code: 1 })), /applescript error: boom/)
})

test('real osascript arithmetic (integration)', async () => {
  const out = await runAppleScript('return 6 * 7')
  assert.equal(out, '42')
})
