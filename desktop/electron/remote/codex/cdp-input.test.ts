import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCdp } from './cdp'
import { CodexDesktopDriver } from './driver'

test('typeText inserts an entire dictated message atomically', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const cdp = Object.create(CodexCdp.prototype) as CodexCdp
  ;(cdp as unknown as { send: (method: string, params: Record<string, unknown>) => Promise<void> }).send = async (method, params) => {
    calls.push({ method, params })
  }

  await cdp.typeText("Don't split this into keystrokes — keep 🙂 intact.")

  assert.deepEqual(calls, [{
    method: 'Input.insertText',
    params: { text: "Don't split this into keystrokes — keep 🙂 intact." },
  }])
})

test('follow-up refuses to submit when Codex does not contain the exact text', async () => {
  let enterCount = 0
  const driver = new CodexDesktopDriver({ sleep: async () => {} }) as any
  driver.cdp = {
    connected: true,
    focusComposer: async () => true,
    typeText: async () => {},
    composerText: async () => 'damaged composer text',
    pressEnter: async () => { enterCount++ },
  }
  driver.openThread = async () => true

  const result = await driver.send('thread-1', 'the exact dictated message')

  assert.deepEqual(result, { ok: false, reason: 'text-mismatch' })
  assert.equal(enterCount, 0)
})
