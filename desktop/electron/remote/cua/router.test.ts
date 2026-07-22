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

// I3 — run_applescript has no `app` arg, so it must be allowlist-checked
// by parsing `tell application "<X>"` targets out of the script itself.
test('run_applescript is rejected when it targets a non-allowed app', async () => {
  const r = await handleRouterTool('run_applescript', { script: 'tell application "Mail" to send x' },
    ctx({ getPolicy: () => ({ ...ON, allowAll: false, allowed: ['Notes'] }) }))
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Mail/)
  assert.match(r.content[0].text, /not allowed/i)
})
test('run_applescript is allowed when its only target is allowlisted', async () => {
  const r = await handleRouterTool('run_applescript', { script: 'tell application "Notes" to make new note' },
    ctx({ getPolicy: () => ({ ...ON, allowAll: false, allowed: ['Notes'] }) }))
  assert.notEqual(r.isError, true)
  assert.match(r.content[0].text, /ok/)
})
test('run_applescript is rejected when it contains do shell script and allowAll is false', async () => {
  const r = await handleRouterTool('run_applescript', { script: 'do shell script "rm -rf /"' },
    ctx({ getPolicy: () => ({ ...ON, allowAll: false, allowed: ['Notes'] }) }))
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /shell/i)
})
test('run_applescript targeting a non-allowed app is NOT rejected when allowAll is true', async () => {
  const r = await handleRouterTool('run_applescript', { script: 'tell application "Mail" to send x' }, ctx())
  assert.notEqual(r.isError, true)
  assert.match(r.content[0].text, /ok/)
})

// Minor — missing-arg guard: web_eval/web_type used to forward undefined
// js/text straight to the CDP lane, producing a confusing downstream error.
test('web_eval without js returns a clean missing-argument error', async () => {
  const r = await handleRouterTool('web_eval', { app: 'Notion' }, ctx())
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /missing required argument: js/)
})
test('web_type without text returns a clean missing-argument error', async () => {
  const r = await handleRouterTool('web_type', { app: 'Notion' }, ctx())
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /missing required argument: text/)
})
