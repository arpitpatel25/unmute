// Creating a Codex task WITH a screenshot went through `attachFiles`, which
// drives a DOM `input[type=file]` and, failing that, clicks an "Attach files or
// connect apps" control. Measured against the shipped Codex build: the page
// mounts NO <input> of any kind, that aria-label does not exist (it is now "Add
// files and more"), and clicking through to the real entry raises a native
// dialog that never emits Page.fileChooserOpened. Both branches therefore
// return false and every create-with-image failed `send-failed`.
//
// The pasteboard route is the one that demonstrably works, so creation uses the
// same transport as a follow-up reply.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexDesktopDriver } from './driver'

function createDriver() {
  const seen = { attachFiles: 0, clipboardPastes: 0, pastedPaths: [] as string[] }
  let submitted = false
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    pasteImages: async (
      _text: string,
      paths: readonly string[],
      _observe?: unknown,
      paste?: () => Promise<boolean>,
    ) => {
      seen.pastedPaths.push(...paths)
      assert.ok(paste, 'creation must paste through the renderer, not a native Command-V')
      return await paste()
    },
  } as any) as any
  driver.availability = async () => ({ ok: true, port: 9302 })
  driver.applyApprovalPolicy = async () => {}
  driver.applyReasoning = async () => undefined
  driver.cdp = {
    connected: true,
    // listThreads reads the sidebar; an empty list keeps creation on its
    // ordinary path without inventing threads.
    evaluate: async () => '[]',
    clickAriaLabel: async () => true,
    focusComposer: async () => true,
    attachFiles: async () => { seen.attachFiles++; return false },
    composerAttachmentCount: async () => 1,
    pasteClipboard: async () => { seen.clipboardPastes++ },
    typeText: async () => {},
    composerText: async () => (submitted ? '' : 'build the thing'),
    pressEnter: async () => { submitted = true },
  }
  driver.connect = async () => driver.cdp
  return { driver, seen }
}

test('creating a Codex task with a screenshot pastes it instead of using the dead file input', async () => {
  const { driver, seen } = createDriver()

  await driver.createTask('build the thing', { attachments: ['/tmp/shot.png'] })

  assert.equal(seen.attachFiles, 0, 'the file-input/chooser path does not exist in the shipped Codex build')
  assert.deepEqual(seen.pastedPaths, ['/tmp/shot.png'])
  assert.equal(seen.clipboardPastes, 1)
})

test('creating a Codex task without attachments never touches the pasteboard', async () => {
  const { driver, seen } = createDriver()

  await driver.createTask('build the thing', {})

  assert.deepEqual(seen.pastedPaths, [])
  assert.equal(seen.clipboardPastes, 0)
})
