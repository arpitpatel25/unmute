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
  }

  assert.equal(await searchSidebarThread(port, async () => {}), false)
  assert.equal(attempts, 1)
})
