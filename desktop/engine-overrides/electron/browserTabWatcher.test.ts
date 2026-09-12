import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { getActiveTabUrl, SUPPORTED_TAB_URL_BROWSERS } from './browserTabWatcher'

// The two argv-shape tests that used to live here asserted the AppleScript
// source ('tell application "Safari" to get URL of current tab'). That script
// is gone — it was an Apple Event, which is what made this poll raise an
// Automation prompt per browser — so there is no argv to assert. What replaces
// them is the contract that actually matters to the caller: the browser NAME is
// passed through untouched, because the addon resolves apps by localized name.
describe('active-tab URL lookup (accessibility, no Apple Events)', () => {
  test('returns the trimmed URL on success', async () => {
    const url = await getActiveTabUrl('Safari', async () => 'https://meet.google.com/abc-defg-hij\n')
    assert.equal(url, 'https://meet.google.com/abc-defg-hij')
  })

  test('returns undefined when the read throws', async () => {
    const url = await getActiveTabUrl('Safari', async () => {
      throw new Error('bridge unavailable')
    })
    assert.equal(url, undefined)
  })

  test('returns undefined for an empty URL (browser not running, or no window)', async () => {
    const url = await getActiveTabUrl('Arc', async () => '')
    assert.equal(url, undefined)
  })

  test('passes the browser name through unchanged — the addon resolves by localized name', async () => {
    const seen: string[] = []
    for (const browser of SUPPORTED_TAB_URL_BROWSERS) {
      await getActiveTabUrl(browser, async (b) => {
        seen.push(b)
        return 'https://example.com'
      })
    }
    assert.deepEqual(seen, [...SUPPORTED_TAB_URL_BROWSERS])
  })

  // Regression guard for the whole point of this module: a half-typed address
  // must not be reported as the live page. The native side enforces this by
  // preferring AXWebArea's AXURL over the omnibox AXTextField's AXValue; here
  // we only pin the side this layer owns — whatever the reader returns is
  // passed through verbatim, with no re-parsing that could resurrect the bug.
  test('does not rewrite or normalise the URL it is given', async () => {
    const raw = 'https://example.com/a/b?x=1&y=2#frag'
    assert.equal(await getActiveTabUrl('Brave Browser', async () => raw), raw)
  })

  test('supported browser list matches spec §3', () => {
    assert.deepEqual(
      [...SUPPORTED_TAB_URL_BROWSERS].sort(),
      ['Arc', 'Brave Browser', 'Microsoft Edge', 'Safari'].sort()
    )
  })
})
