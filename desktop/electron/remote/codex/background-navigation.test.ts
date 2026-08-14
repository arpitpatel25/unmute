import { clickThreadRowViaSearch } from './cdp'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CodexDesktopDriver,
  searchSidebarThread,
  threadNavigationFallback,
  type SidebarSearchPort,
} from './driver'

test('background thread navigation fails safely instead of using an activating deep link', () => {
  assert.equal(threadNavigationFallback(true), 'fail')
  assert.equal(threadNavigationFallback(false), 'deeplink')
})

test('the real background open path never invokes the deep-link boundary', async () => {
  let deepLinks = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    openDeepLink: async () => { deepLinks++ },
  })
  const cdp = {
    evaluate: async (expression: string) => expression.includes('advanceSidebarScroll') ? false : '',
    click: async () => {},
    // Codex search is the last background rung; a build with no Search control
    // must still fail safely rather than reach for the deep link.
    clickAriaLabel: async () => false,
    pressEscape: async () => {},
  } as any

  assert.equal(await driver.openThread('unreachable-thread', cdp, { background: true }), false)
  assert.equal(deepLinks, 0)
})

test('an explicit Open in Codex deep-links immediately instead of scanning the background sidebar', async () => {
  const deepLinks: string[] = []
  let reads = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    openDeepLink: async (url) => { deepLinks.push(url) },
  })
  const cdp = {
    evaluate: async () => {
      reads++
      // First read: the current conversation is not the requested one. Second
      // read confirms the deep link landed. A sidebar scan would add reads.
      return reads === 1 ? '' : 'local:explicit-thread'
    },
    click: async () => {},
  } as any

  assert.equal(await driver.openThread('explicit-thread', cdp), true)
  assert.deepEqual(deepLinks, ['codex://threads/explicit-thread'])
  assert.equal(reads, 2)
})

test('sidebar search expands, paginates, and scrolls until the target becomes reachable', async () => {
  const actions: string[] = []
  let expanded = false
  let paginated = false
  let page = 0
  const port: SidebarSearchPort = {
    resetScroll: async () => { actions.push('reset') },
    clickTarget: async () => {
      actions.push('target')
      return expanded && paginated && page === 2
    },
    expandOne: async () => {
      actions.push('expand')
      if (expanded) return false
      expanded = true
      return true
    },
    clickShowMore: async () => {
      actions.push('more')
      if (paginated) return false
      paginated = true
      return true
    },
    advanceScroll: async () => {
      actions.push('scroll')
      if (page >= 2) return false
      page++
      return true
    },
  }

  assert.equal(await searchSidebarThread(port, async () => {}), true)
  assert.equal(actions[0], 'reset')
  assert.ok(actions.includes('expand'))
  assert.ok(actions.includes('more'))
  assert.equal(actions.filter((action) => action === 'scroll').length, 2)
})

test('sidebar search is bounded and returns false when Codex cannot render the target', async () => {
  let attempts = 0
  const port: SidebarSearchPort = {
    resetScroll: async () => {},
    clickTarget: async () => { attempts++; return false },
    expandOne: async () => false,
    clickShowMore: async () => false,
    advanceScroll: async () => false,
    clickTargetViaSearch: async () => false,
  }

  assert.equal(await searchSidebarThread(port, async () => {}), false)
  assert.equal(attempts, 1)
})

// The scroll-and-expand ladder can only find a thread Codex has RENDERED. A
// thread outside its virtualised window is invisible to it, and the fallback
// for that is the codex:// deep link — which raises Codex, because the app
// activates itself when it handles its own URL scheme (`open -g` does not
// prevent it; measured).
//
// Codex has its own chat search, and it is reachable over CDP with no
// activation: its results carry the durable id in
// `data-app-action-sidebar-thread-id`, so the exact thread can be clicked
// rather than guessed at by title.
test('the ladder asks Codex search before giving up on background navigation', async () => {
  const calls: string[] = []
  const found = await searchSidebarThread({
    resetScroll: async () => { calls.push('resetScroll') },
    clickTarget: async () => { calls.push('clickTarget'); return false },
    expandOne: async () => { calls.push('expandOne'); return false },
    clickShowMore: async () => { calls.push('clickShowMore'); return false },
    advanceScroll: async () => { calls.push('advanceScroll'); return false },
    clickTargetViaSearch: async () => { calls.push('clickTargetViaSearch'); return true },
  }, async () => {})

  assert.equal(found, true, 'a thread only reachable through search must still be found')
  assert.ok(
    calls.indexOf('clickTargetViaSearch') > calls.indexOf('advanceScroll'),
    'search is the last resort before the deep link, not the first move',
  )
})

test('background navigation fails without a deep link when even search cannot find the thread', async () => {
  const found = await searchSidebarThread({
    resetScroll: async () => {},
    clickTarget: async () => false,
    expandOne: async () => false,
    clickShowMore: async () => false,
    advanceScroll: async () => false,
    clickTargetViaSearch: async () => false,
  }, async () => {})

  assert.equal(found, false)
})

// Codex's search is a COMMAND MENU, and its rows carry no thread id — so a
// result cannot be matched by attribute the way a sidebar row can. But the menu
// matches the query against the thread's ID as well as its title, measured
// live: typing "019ff6b4" returned exactly one row, "Research AI social
// marketing agents".
//
// That is what makes this safe to click: we search by the durable id we already
// store, never by a title. Unmute's name for a task and Codex's name for the
// thread are routinely different — "AI Marketing Research" vs "Research AI
// social marketing agents" — and the user can rename theirs at any time. The id
// cannot drift, and the mounted-thread check still verifies identity before a
// single character is typed.
test('search addresses a thread by its durable id, never by a title', async () => {
  const typed: string[] = []
  const clicks: string[] = []
  const cdp = {
    clickAriaLabel: async (label: string) => { clicks.push(label); return true },
    evaluate: async (expression: string) => {
      if (expression.includes('input')) return true      // focus the search field
      return JSON.stringify({ x: 10, y: 20 })            // a result to click
    },
    typeText: async (t: string) => { typed.push(t) },
    click: async () => { clicks.push('result') },
    pressEscape: async () => { clicks.push('escape') },
  } as any

  assert.equal(
    await clickThreadRowViaSearch(cdp, 'local:019ff6b4-b76a-7641-8b00-95ce86de8403', async () => {}),
    true,
  )
  assert.deepEqual(typed, ['019ff6b4-b76a-7641-8b00-95ce86de8403'], 'the query is the bare thread id')
  assert.ok(clicks.includes('escape'), 'the dialog is always dismissed')
})
