import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMcpList, buildSetupChecklist, setupComplete } from './setup-status.ts'

test('parseMcpList reads names + connectivity from healthy/failed lines', () => {
  const out = parseMcpList([
    'Checking MCP server health...',
    '',
    'gmail: npx -y @modelcontextprotocol/gmail - ✓ Connected',
    'google-sheets: node sheets.js - ✗ Failed to connect',
    'notion: npx notion',
  ].join('\n'))
  const by = Object.fromEntries(out.map((s) => [s.name, s.connected]))
  assert.equal(by['gmail'], true)
  assert.equal(by['google-sheets'], false)
  assert.equal(by['notion'], true) // declared, no marker ⇒ treated as configured
  assert.ok(!('Checking' in by)) // header skipped
})

test('parseMcpList tolerates empty / no-servers output', () => {
  assert.deepEqual(parseMcpList(''), [])
  assert.deepEqual(parseMcpList('No MCP servers configured.'), [])
})

test('buildSetupChecklist auto-marks a connected MCP done and a missing one todo', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: 'gmail: x - ✓ Connected',
    browserEnabled: false, // browser step omitted
    confirmations: {},
  })
  assert.ok(!steps.some((s) => s.key.startsWith('chrome')))
  const gmail = steps.find((s) => s.key === 'mcp-gmail')!
  assert.equal(gmail.status, 'done')
  const sheets = steps.find((s) => s.key === 'mcp-google-sheets')!
  assert.equal(sheets.status, 'todo')
  assert.equal(sheets.command, 'claude mcp add google-sheets')
})

test('buildSetupChecklist includes the single Chrome-extension step + honors confirmation', () => {
  const todo = buildSetupChecklist({ mcpListOutput: '', browserEnabled: true, confirmations: {} })
  const ext = todo.find((s) => s.key === 'chrome-extension')!
  assert.equal(ext.status, 'todo')
  assert.equal(ext.auto, false)
  // no dedicated-profile / sign-in / Space steps anymore (real Chrome)
  assert.ok(!todo.some((s) => ['chrome-profile', 'chrome-signin', 'chrome-space'].includes(s.key)))

  const done = buildSetupChecklist({ mcpListOutput: '', browserEnabled: true, confirmations: { 'chrome-extension': true } })
  assert.equal(done.find((s) => s.key === 'chrome-extension')!.status, 'done')
})

test('setupComplete is true only when every step is done', () => {
  assert.equal(setupComplete([{ key: 'a', title: '', detail: '', status: 'done', auto: true }]), true)
  assert.equal(setupComplete([
    { key: 'a', title: '', detail: '', status: 'done', auto: true },
    { key: 'b', title: '', detail: '', status: 'todo', auto: false },
  ]), false)
})
