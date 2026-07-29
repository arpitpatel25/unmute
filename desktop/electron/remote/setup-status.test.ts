import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMcpList, buildSetupChecklist, setupComplete } from './setup-status.ts'

// BACKENDS COME FIRST.
//
// The checklist covered Chrome, tmux and MCPs — everything EXCEPT the agents
// that actually run the work. A user with no `claude` on PATH got silent
// degradation (no router warm-up, failsafe routing, MCP steps reading "todo"
// because `claude mcp list` could not run), and Codex desktop had no setup
// surface anywhere: the only way to arm it was tapping a greyed-out entry in the
// pill's picker, while the main app's settings said "Codex (coming soon)".
const noBackends = { mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {} }

test('a missing Claude CLI is a TODO step, not a silent degradation', () => {
  const steps = buildSetupChecklist({
    ...noBackends,
    backends: [{ id: 'claude', label: 'Claude Code CLI', installed: false, ready: false }],
  })
  const s = steps.find((x) => x.key === 'backend-claude')
  assert.ok(s, 'the backend must appear in the checklist')
  assert.equal(s!.status, 'todo')
  assert.equal(s!.auto, true, 'we can detect this ourselves — never ask the user to self-confirm it')
  assert.equal(s!.optional, undefined, 'a backend is not an optional enhancement')
  assert.match(s!.command ?? '', /claude/, 'tell them how to install it')
})

test('backend steps come BEFORE the optional extras', () => {
  const steps = buildSetupChecklist({
    ...noBackends,
    backends: [{ id: 'claude', label: 'Claude Code CLI', installed: true, ready: true }],
  })
  assert.equal(steps[0].key, 'backend-claude', 'nothing else matters if no agent can run')
})

test('Codex desktop distinguishes NOT INSTALLED from INSTALLED-BUT-NOT-ARMED', () => {
  const missing = buildSetupChecklist({
    ...noBackends,
    backends: [{ id: 'codex-desktop', label: 'Codex desktop', installed: false, ready: false, reason: 'not-installed' }],
  }).find((x) => x.key === 'backend-codex-desktop')!
  assert.equal(missing.status, 'todo')
  assert.equal(missing.action, undefined, 'nothing to connect to — do not offer a Connect button')
  assert.match(missing.detail, /install/i)

  const unarmed = buildSetupChecklist({
    ...noBackends,
    backends: [{ id: 'codex-desktop', label: 'Codex desktop', installed: true, ready: false, reason: 'not-armed' }],
  }).find((x) => x.key === 'backend-codex-desktop')!
  assert.equal(unarmed.status, 'todo')
  assert.equal(unarmed.action, 'codex-connect', 'this one is fixable in a click')
  assert.match(unarmed.detail, /restart|relaunch/i, 'warn that connecting restarts their app')
})

test('a ready backend is done and offers no action', () => {
  const s = buildSetupChecklist({
    ...noBackends,
    backends: [{ id: 'codex-desktop', label: 'Codex desktop', installed: true, ready: true }],
  }).find((x) => x.key === 'backend-codex-desktop')!
  assert.equal(s.status, 'done')
  assert.equal(s.action, undefined)
})

test('backends are optional INPUT — an older caller still gets the old checklist', () => {
  const steps = buildSetupChecklist({ ...noBackends, browserEnabled: true })
  assert.ok(steps.length > 0)
  assert.ok(!steps.some((s) => s.key.startsWith('backend-')), 'no backends passed ⇒ no backend rows')
})

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
    tmuxAvailable: true,
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
  const todo = buildSetupChecklist({ mcpListOutput: '', tmuxAvailable: true, browserEnabled: true, confirmations: {} })
  const ext = todo.find((s) => s.key === 'chrome-extension')!
  assert.equal(ext.status, 'todo')
  assert.equal(ext.auto, false)
  // no dedicated-profile / sign-in / Space steps anymore (real Chrome)
  assert.ok(!todo.some((s) => ['chrome-profile', 'chrome-signin', 'chrome-space'].includes(s.key)))

  const done = buildSetupChecklist({ mcpListOutput: '', tmuxAvailable: true, browserEnabled: true, confirmations: { 'chrome-extension': true } })
  assert.equal(done.find((s) => s.key === 'chrome-extension')!.status, 'done')
})

test('setupComplete is true only when every step is done', () => {
  assert.equal(setupComplete([{ key: 'a', title: '', detail: '', status: 'done', auto: true }]), true)
  assert.equal(setupComplete([
    { key: 'a', title: '', detail: '', status: 'done', auto: true },
    { key: 'b', title: '', detail: '', status: 'todo', auto: false },
  ]), false)
})

test('tmux is an optional step — todo when missing, never blocks completeness', () => {
  // all recommended MCPs connected, browser lane off ⇒ only the optional tmux is todo
  const allMcp = ['gmail', 'google-sheets', 'google-docs', 'google-drive'].map((n) => `${n}: x - ✓ Connected`).join('\n')
  const steps = buildSetupChecklist({ mcpListOutput: allMcp, tmuxAvailable: false, browserEnabled: false, confirmations: {} })
  const tmux = steps.find((s) => s.key === 'tmux')!
  assert.equal(tmux.status, 'todo')
  assert.equal(tmux.optional, true)
  assert.equal(tmux.command, 'brew install tmux')
  // every non-optional step done + tmux todo(optional) ⇒ essentials complete
  assert.equal(setupComplete(steps), true)
})
