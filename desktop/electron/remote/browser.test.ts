import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLaunchArgs, automationProfileDir, launchAutomationChrome } from './browser.ts'

test('automation profile dir is separate from the user Chrome profile', () => {
  const dir = automationProfileDir('/base')
  assert.equal(dir, '/base/chrome-profile')
})

test('launch args use a dedicated --user-data-dir (isolated instance)', () => {
  const { bin, args } = buildLaunchArgs({ profileDir: '/base/chrome-profile' })
  assert.match(bin, /Google Chrome/)
  assert.ok(args.includes('--user-data-dir=/base/chrome-profile'))
  assert.ok(args.includes('--no-first-run'))
})

test('debug port added only when requested (for a CDP/MCP attach)', () => {
  assert.ok(!buildLaunchArgs({}).args.some((a) => a.startsWith('--remote-debugging-port')))
  assert.ok(buildLaunchArgs({ debugPort: 9222 }).args.includes('--remote-debugging-port=9222'))
})

test('launchAutomationChrome uses the injected spawner with the built command', () => {
  let called: { bin?: string; args?: string[] } = {}
  const out = launchAutomationChrome({
    chromeBin: '/fake/chrome',
    profileDir: '/p',
    spawn: (bin, args) => { called = { bin, args } },
  })
  assert.equal(called.bin, '/fake/chrome')
  assert.ok(called.args!.includes('--user-data-dir=/p'))
  assert.equal(out.bin, '/fake/chrome')
})
