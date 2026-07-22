import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routerTools, isRouterTool, handleRouterTool, type RouterCtx } from './router'
import type { AxPolicy } from '../ax/policy'

const ON: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] }
function ctx(over: Partial<RouterCtx> = {}): RouterCtx {
  return {
    cdp: { eval: async () => 42, typeKeys: async () => {}, screenshot: async () => Buffer.from('x'), scrollBottom: async () => ({}), clickText: async () => ({}) } as any,
    arming: { arm: async (app: string) => ({ app, port: 9222, alreadyArmed: false }), portFor: () => 9222, disposeAll: async () => {} } as any,
    runAppleScript: async () => 'ok',
    getPolicy: () => ON, ...over,
  }
}

test('routerTools exposes the five lane tools', () => {
  const names = routerTools().map(t => t.name)
  for (const n of ['web_arm','web_eval','web_type','web_screenshot','run_applescript']) assert.ok(names.includes(n), n)
})
test('isRouterTool matches our tools, not cua tools', () => {
  assert.ok(isRouterTool('web_eval')); assert.ok(!isRouterTool('get_window_state'))
})
test('web_eval dispatches to the CDP lane', async () => {
  const r = await handleRouterTool('web_eval', { app: 'Notion', js: '1' }, ctx())
  assert.match(r.content[0].text, /42/); assert.notEqual(r.isError, true)
})
test('run_applescript dispatches to the Apple Events lane', async () => {
  const r = await handleRouterTool('run_applescript', { script: 'x' }, ctx())
  assert.match(r.content[0].text, /ok/)
})
test('allowlist blocks a non-allowed app when allowAll is false', async () => {
  const r = await handleRouterTool('web_eval', { app: 'Secret', js: '1' },
    ctx({ getPolicy: () => ({ ...ON, allowAll: false, allowed: ['Notion'] }) }))
  assert.equal(r.isError, true); assert.match(r.content[0].text, /not allowed/i)
})
