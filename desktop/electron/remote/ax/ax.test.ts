// ax-mcp tests — policy enforcement, tool dispatch, protocol shaping, and
// concurrency (N callers driving N apps with no cross-talk / no lock).
//
// The native AX engine is exercised on-device (it needs real apps + permission);
// here we drive the SERVER logic against a fake bridge, which is where all the
// enforcement + protocol correctness lives.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePolicy, isAppAllowed, DEFAULT_POLICY, type AxPolicy } from './policy'
import { removeBlock } from './register'
import { handleAxTool } from './server'
import type { AxBridge, AxMethod } from './ax-bridge'

// ── A fake bridge: records calls, returns scripted results ──
function fakeBridge(handlers: Partial<Record<AxMethod, (args: unknown[]) => any>> = {}): AxBridge & { calls: Array<{ m: string; args: unknown[] }> } {
  const calls: Array<{ m: string; args: unknown[] }> = []
  return {
    calls,
    async call(method: AxMethod, args: unknown[]) {
      calls.push({ m: method, args })
      const h = handlers[method]
      if (h) return h(args)
      // sensible defaults
      if (method === 'listApps') return [{ name: 'Notion', bundleId: 'notion.id', pid: 1, windowsHere: 1, windowsAnywhere: 1 }]
      if (method === 'find') return { app: 'Notion', nodes: [{ id: 5, role: 'AXButton', label: 'Close Sidebar', actions: ['AXPress'] }], total: 40 }
      if (method === 'press') return { ok: true, role: 'AXButton', label: 'Close Sidebar' }
      return {}
    },
    async trusted() { return true },
    dispose() {},
  }
}

const ON: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] }
const deps = (policy: AxPolicy, onActivity?: (e: any) => void) => ({ getPolicy: () => policy, onActivity })

// ─────────────────────────── policy ───────────────────────────

test('normalizePolicy: defaults are safe (disabled, allow-all, screenshots on)', () => {
  const p = normalizePolicy(undefined)
  assert.equal(p.enabled, false)
  assert.equal(p.allowAll, true)
  assert.equal(p.screenshotEnabled, true)
  assert.deepEqual(p.allowed, [])
  // DEFAULT_POLICY agrees
  assert.equal(DEFAULT_POLICY.enabled, false)
  assert.equal(DEFAULT_POLICY.allowAll, true)
})

// TEMPORARY KILL SWITCH (see policy.ts's own comment for the why — the
// unmute-computer MCP leaking into Codex via ChatGPT desktop's config
// import). Every consumer reads its answer from normalizePolicy, so this one
// assertion is the whole guarantee: no settings.json value, however it got
// there, can make Computer Use live again while the switch is on.
test('normalizePolicy: the kill switch wins even over an explicit, real enabled:true', () => {
  const p = normalizePolicy({ enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] })
  assert.equal(p.enabled, false)
})

test('normalizePolicy: coerces junk without throwing', () => {
  const p = normalizePolicy({ enabled: 'yes', allowAll: false, screenshotEnabled: false, allowed: ['a', 2, null, 'b'] })
  assert.equal(p.enabled, false) // only strict true counts
  assert.equal(p.allowAll, false)
  assert.equal(p.screenshotEnabled, false)
  assert.deepEqual(p.allowed, ['a', 'b'])
})

test('isAppAllowed: allowAll passes everything; restrict matches name OR bundle id, case-insensitive', () => {
  assert.equal(isAppAllowed(ON, 'Anything'), true)
  const restricted: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: false, allowed: ['notion.id', 'Notes'] }
  assert.equal(isAppAllowed(restricted, 'Notion', 'notion.id'), true) // by bundle id
  assert.equal(isAppAllowed(restricted, 'notes'), true)               // by name, case-insensitive
  assert.equal(isAppAllowed(restricted, 'WhatsApp', 'net.whatsapp.WhatsApp'), false)
})

// ─────────────────────── enforcement ───────────────────────

test('disabled policy refuses every tool', async () => {
  const b = fakeBridge()
  const r = await handleAxTool(deps({ ...ON, enabled: false }), b, 'find', { app: 'Notion' })
  assert.equal(r.isError, true)
  assert.match((r.content[0] as any).text, /turned OFF/i)
  assert.equal(b.calls.length, 0) // never touched the bridge
})

test('allowlist blocks a non-listed app (restrict mode), naming the fix', async () => {
  const b = fakeBridge({ listApps: () => [{ name: 'WhatsApp', bundleId: 'net.whatsapp.WhatsApp', pid: 9, windowsHere: 1, windowsAnywhere: 1 }] })
  const policy: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: false, allowed: ['notion.id'] }
  const r = await handleAxTool(deps(policy), b, 'find', { app: 'WhatsApp' })
  assert.equal(r.isError, true)
  assert.match((r.content[0] as any).text, /not in the Computer Use allowlist/i)
})

test('allowlist permits a listed app in restrict mode', async () => {
  const b = fakeBridge()
  const policy: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: false, allowed: ['notion.id'] }
  const r = await handleAxTool(deps(policy), b, 'find', { app: 'Notion' })
  assert.equal(r.isError ?? false, false)
  assert.match((r.content[0] as any).text, /Close Sidebar/)
})

test('screenshots off refuses capture_window only, not other tools', async () => {
  const b = fakeBridge({ captureWindow: () => ({ ok: true, base64: 'AAAA', width: 100, height: 80 }) })
  const noShot = { ...ON, screenshotEnabled: false }
  const cap = await handleAxTool(deps(noShot), b, 'capture_window', { app: 'Notion' })
  assert.equal(cap.isError, true)
  assert.match((cap.content[0] as any).text, /Screenshots are turned off/i)
  const find = await handleAxTool(deps(noShot), b, 'find', { app: 'Notion' })
  assert.equal(find.isError ?? false, false)
})

// ─────────────────────── protocol shaping ───────────────────────

test('press result tells the model the app was not fronted + to re-run find', async () => {
  const b = fakeBridge()
  const r = await handleAxTool(deps(ON), b, 'press', { app: 'Notion', id: 5 })
  assert.match((r.content[0] as any).text, /NOT brought to front/i)
  assert.match((r.content[0] as any).text, /re-run find/i)
})

test('capture_window returns an MCP image content block', async () => {
  const b = fakeBridge({ captureWindow: () => ({ ok: true, base64: 'AAAA', width: 1400, height: 900 }) })
  const r = await handleAxTool(deps(ON), b, 'capture_window', { app: 'Notion' })
  assert.equal(r.isError, false)
  const img = r.content.find((c: any) => c.type === 'image') as any
  assert.ok(img, 'has an image block')
  assert.equal(img.mimeType, 'image/png')
  assert.equal(img.data, 'AAAA')
})

test('list_apps annotates other-Space and not-allowed apps', async () => {
  const b = fakeBridge({ listApps: () => [
    { name: 'Notion', bundleId: 'notion.id', pid: 1, windowsHere: 1, windowsAnywhere: 1 },
    { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', pid: 2, windowsHere: 0, windowsAnywhere: 3 },
  ] })
  const policy: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: false, allowed: ['notion.id'] }
  const r = await handleAxTool(deps(policy), b, 'list_apps', {})
  const text = (r.content[0] as any).text
  assert.match(text, /Notion/)
  assert.match(text, /Slack.*on another Space/s)
  assert.match(text, /Slack.*NOT ALLOWED/s)
})

test('propagates an addon error (e.g. app on another Space) as an MCP error', async () => {
  const b = fakeBridge({ find: () => ({ error: "no reachable window for 'Notion'. If the app is on another macOS Space..." }) })
  const r = await handleAxTool(deps(ON), b, 'find', { app: 'Notion' })
  assert.equal(r.isError, true)
  assert.match((r.content[0] as any).text, /another macOS Space/)
})

test('onActivity fires with app + tool + ok', async () => {
  const events: any[] = []
  const b = fakeBridge()
  await handleAxTool(deps(ON, (e) => events.push(e)), b, 'press', { app: 'Notion', id: 5 })
  assert.equal(events.length, 1)
  assert.equal(events[0].app, 'Notion')
  assert.equal(events[0].tool, 'press')
  assert.equal(events[0].ok, true)
})

// ─────────────────────── concurrency (the no-lock thesis) ───────────────────────

test('N callers drive N apps concurrently — no cross-talk, all resolve', async () => {
  // Each "app" has its own bridge with a small async delay; interleave 20 calls.
  const mk = (label: string, delay: number) => fakeBridge({
    find: (args) => new Promise((res) => setTimeout(() => res({ app: args[0], nodes: [{ id: 1, role: 'AXButton', label, actions: ['AXPress'] }], total: 1 }), delay)),
  })
  const notion = mk('Notion-btn', 8)
  const notes = mk('Notes-btn', 3)
  const jobs: Promise<any>[] = []
  for (let i = 0; i < 10; i++) {
    jobs.push(handleAxTool(deps(ON), notion, 'find', { app: 'Notion' }))
    jobs.push(handleAxTool(deps(ON), notes, 'find', { app: 'Notes' }))
  }
  const results = await Promise.all(jobs)
  assert.equal(results.length, 20)
  // Even-indexed = Notion, odd = Notes; each got its OWN result, no bleed.
  for (let i = 0; i < 20; i++) {
    const text = (results[i].content[0] as any).text
    assert.match(text, i % 2 === 0 ? /Notion-btn/ : /Notes-btn/)
  }
})

// ─────────────────────── CLAUDE.md steer block ───────────────────────

test('removeBlock strips the steer block cleanly and is idempotent', () => {
  const base = '# My CLAUDE.md\n\nSome rules.\n'
  const withBlock = base + '\n<!-- UNMUTE-COMPUTER-USE:BEGIN -->\nsteer text\n<!-- UNMUTE-COMPUTER-USE:END -->\n'
  const stripped = removeBlock(withBlock)
  assert.doesNotMatch(stripped, /UNMUTE-COMPUTER-USE/)
  assert.match(stripped, /Some rules\./)
  // idempotent
  assert.equal(removeBlock(stripped), stripped)
})

test('removeBlock tolerates a truncated block (begin but no end)', () => {
  const t = '# doc\n<!-- UNMUTE-COMPUTER-USE:BEGIN -->\nhalf'
  assert.equal(removeBlock(t).trimEnd(), '# doc')
})
