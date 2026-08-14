// Image delivery used a NATIVE Command-V, which only works while Codex is the
// frontmost app — so every dictation carrying a screenshot activated Codex and
// then put the user's app back, a visible flash on every reply. CDP can invoke
// the renderer's own paste command against the same macOS pasteboard with no
// activation at all: verified live, text + two screenshots + submit, with
// another app frontmost throughout and Codex accepting both images.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCdp } from './cdp'
import { CodexDesktopDriver, CODEX_BUNDLE_ID } from './driver'

test('pasteClipboard invokes the renderer paste command rather than a bare keystroke', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const cdp = Object.create(CodexCdp.prototype) as any
  cdp.send = async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }) }

  await cdp.pasteClipboard()

  assert.equal(calls.length, 2, 'a paste is one key down/up pair')
  assert.equal(calls[0].method, 'Input.dispatchKeyEvent')
  assert.deepEqual(
    calls[0].params.commands,
    ['paste'],
    'without the paste command the renderer treats this as an inert Cmd+V',
  )
  assert.equal(calls[1].params.type, 'keyUp')
})

test('a screenshot reply is delivered without ever activating Codex', async () => {
  const activated: string[] = []
  let clipboardPastes = 0
  let attachmentCount = 0
  let snapshotReads = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    frontmost: async () => 'com.user.previousapp',
    activate: async (bundleId) => { activated.push(bundleId); return true },
    // The engine still owns the macOS pasteboard; only the keystroke moves to
    // CDP, so the driver must hand its own paste action to the effect.
    pasteImages: async (_text, _paths, _observe, paste?: () => Promise<boolean>) => {
      assert.ok(paste, 'the driver must supply a paste action instead of a native Command-V')
      const ok = await paste()
      attachmentCount = 1
      return ok
    },
  } as any) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 3 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    composerAttachmentCount: async () => attachmentCount,
    pasteClipboard: async () => { clipboardPastes++ },
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => {},
  }
  driver.openThread = async () => true

  assert.deepEqual(
    await driver.sendWithAttachments('thread-1', 'send this', ['/tmp/one.png']),
    { ok: true },
  )
  assert.equal(clipboardPastes, 1, 'the image is pasted through the renderer')
  assert.ok(
    !activated.includes(CODEX_BUNDLE_ID),
    `Codex must never be brought forward to receive an image, activated: ${JSON.stringify(activated)}`,
  )
})
