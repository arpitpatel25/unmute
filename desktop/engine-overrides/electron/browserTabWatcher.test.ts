import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { getActiveTabUrl, SUPPORTED_APPLESCRIPT_BROWSERS } from './browserTabWatcher'

describe('AppleScript active-tab URL lookup', () => {
  test('returns the trimmed stdout as the URL on success', async () => {
    const url = await getActiveTabUrl('Safari', async () => 'https://meet.google.com/abc-defg-hij\n')
    assert.equal(url, 'https://meet.google.com/abc-defg-hij')
  })

  test('returns undefined when the browser is not running (osascript throws)', async () => {
    const url = await getActiveTabUrl('Safari', async () => {
      throw new Error('Application isn\'t running')
    })
    assert.equal(url, undefined)
  })

  test('returns undefined for empty stdout', async () => {
    const url = await getActiveTabUrl('Arc', async () => '')
    assert.equal(url, undefined)
  })

  test('builds the correct AppleScript for Safari (front document, no active-tab index needed)', async () => {
    let capturedArgs: string[] = []
    await getActiveTabUrl('Safari', async (_cmd, args) => {
      capturedArgs = args
      return 'https://example.com'
    })
    assert.ok(capturedArgs.some((a) => a.includes('tell application "Safari"')))
    assert.ok(capturedArgs.some((a) => a.includes('URL of current tab of front window')))
  })

  test('builds the correct AppleScript for Chromium-family browsers (active tab of front window)', async () => {
    let capturedArgs: string[] = []
    await getActiveTabUrl('Microsoft Edge', async (_cmd, args) => {
      capturedArgs = args
      return 'https://example.com'
    })
    assert.ok(capturedArgs.some((a) => a.includes('tell application "Microsoft Edge"')))
    assert.ok(capturedArgs.some((a) => a.includes('URL of active tab of front window')))
  })

  test('supported browser list matches spec §3', () => {
    assert.deepEqual(
      [...SUPPORTED_APPLESCRIPT_BROWSERS].sort(),
      ['Arc', 'Brave Browser', 'Microsoft Edge', 'Safari'].sort()
    )
  })
})
