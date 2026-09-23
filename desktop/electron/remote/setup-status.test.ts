import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMcpList, buildSetupChecklist, setupComplete, blockerOf, detectedBackends, displayedAgent } from './setup-status.ts'

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

// COMPLETENESS, WITH BACKENDS IN THE PICTURE
//
// Backends are not a checklist: they are a live readout that can regress with no
// user action (Codex loses its debug port the moment the app is reopened
// normally). Demanding every backend meant a user who deliberately runs only one
// agent was permanently "incomplete" and permanently nagged — which is what
// shipped in v1.4.12.
test('ONE working backend is a complete setup — you need not install them all', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {},
    backends: [
      { id: 'claude', label: 'Claude Code CLI', installed: true, ready: true },
      { id: 'codex-desktop', label: 'Codex desktop', installed: false, ready: false, reason: 'not-installed' },
    ],
  })
  assert.equal(setupComplete(steps), true, 'not wanting a second agent is not an incomplete setup')
})

test('ZERO working backends is incomplete — that is the real alarm', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {},
    backends: [
      { id: 'claude', label: 'Claude Code CLI', installed: false, ready: false },
      { id: 'codex-desktop', label: 'Codex desktop', installed: false, ready: false, reason: 'not-installed' },
    ],
  })
  assert.equal(setupComplete(steps), false)
})

test('blockerOf names what is actually wrong, not a hardcoded step', () => {
  const noAgent = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {},
    backends: [{ id: 'claude', label: 'Claude Code CLI', installed: false, ready: false }],
  })
  assert.match(blockerOf(noAgent) ?? '', /agent/i, 'no agent is the blocker worth naming')

  const onlyExtension = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: true, tmuxAvailable: true, confirmations: {},
    backends: [{ id: 'claude', label: 'Claude Code CLI', installed: true, ready: true }],
  })
  assert.match(blockerOf(onlyExtension) ?? '', /chrome|extension/i)

  const fine = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {},
    backends: [{ id: 'claude', label: 'Claude Code CLI', installed: true, ready: true }],
  })
  assert.equal(blockerOf(fine), null, 'nothing wrong ⇒ nothing to nag about')
})

// A CONFIRMATION IS ONLY EVER ABOUT THE STEP AS IT WAS WORDED.
// Confirmations persist in settings forever and survive upgrades, so if a step's
// requirement changes, a stale `true` would silently hide the new one. Versioning
// the key means a bumped step reverts to todo instead.
test('a confirmation is scoped to the step VERSION, and v1 honours the old unversioned key', () => {
  const withOld = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: true, tmuxAvailable: true,
    confirmations: { 'chrome-extension': true }, // written before versioning existed
  })
  assert.equal(withOld.find((s) => s.key === 'chrome-extension')!.status, 'done',
    'existing users must not be re-nagged for something they already did')

  const withVersioned = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: true, tmuxAvailable: true,
    confirmations: { 'chrome-extension@1': true },
  })
  assert.equal(withVersioned.find((s) => s.key === 'chrome-extension')!.status, 'done')
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

test('an outdated CLI Unmute could not update is an OPTIONAL step with the user\'s command', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {},
    backends: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true }],
    cliUpdates: [
      { id: 'codex', label: 'Codex CLI', version: '0.150.0', latest: '0.156.1', command: 'npm install -g @openai/codex@latest', detail: 'EACCES: permission denied\nmore' },
      { id: 'claude', label: 'Claude Code', version: '2.1.0', latest: '2.1.281' },
    ],
  })
  const codex = steps.find((s) => s.key === 'cli-update-codex')!
  assert.equal(codex.title, 'Update Codex CLI (0.150.0 → 0.156.1)')
  assert.equal(codex.command, 'npm install -g @openai/codex@latest')
  assert.match(codex.detail, /EACCES: permission denied\)/)
  assert.equal(codex.optional, true)
  const claude = steps.find((s) => s.key === 'cli-update-claude')!
  assert.equal(claude.command, undefined)
  assert.match(claude.detail, /Update that app/)
  // Never blocks setup: an old CLI still runs tasks.
  assert.equal(setupComplete(steps), true)
  assert.equal(blockerOf(steps), null)
})

// NOTHING ABOUT AN AGENT THAT IS NOT ON THIS MAC.
// A Mac with only Codex must not be told how to install Claude Code, nor shown
// the Claude-for-Chrome and `claude mcp add` steps that only Claude Code runs.
test('an undetected backend gets no row once another one is detected', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: true, tmuxAvailable: true, confirmations: {},
    backends: [
      { id: 'claude', label: 'Claude Code CLI', installed: false, ready: false, reason: 'not-installed' },
      { id: 'codex', label: 'Codex CLI', installed: true, ready: true },
      { id: 'codex-desktop', label: 'Codex desktop', installed: false, ready: false, reason: 'not-installed' },
    ],
  })
  assert.deepEqual(steps.filter((s) => s.group === 'backend').map((s) => s.key), ['backend-codex'])
  assert.ok(!steps.some((s) => s.key === 'chrome-extension'), 'the browser lane is Claude Code only')
  assert.ok(!steps.some((s) => s.key.startsWith('mcp-')), '`claude mcp add` is Claude Code only')
  assert.ok(!JSON.stringify(steps).includes('Claude'), 'no Claude text anywhere on a Codex-only Mac')
})

test('no Codex rows on a Claude-only Mac', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: true, tmuxAvailable: true, confirmations: {},
    backends: [
      { id: 'claude', label: 'Claude Code CLI', installed: true, ready: true },
      { id: 'codex', label: 'Codex CLI', installed: false, ready: false, reason: 'not-installed' },
      { id: 'codex-desktop', label: 'Codex desktop', installed: false, ready: false, reason: 'not-installed' },
    ],
  })
  assert.ok(!JSON.stringify(steps).includes('Codex'))
  assert.ok(steps.some((s) => s.key === 'chrome-extension'))
})

test('with NO agent detected, every install row stays — it is the only way forward', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: true, tmuxAvailable: true, confirmations: {},
    backends: [
      { id: 'claude', label: 'Claude Code CLI', installed: false, ready: false },
      { id: 'codex-desktop', label: 'Codex desktop', installed: false, ready: false, reason: 'not-installed' },
    ],
  })
  assert.deepEqual(steps.filter((s) => s.group === 'backend').map((s) => s.key), ['backend-claude', 'backend-codex-desktop'])
  assert.match(blockerOf(steps) ?? '', /Claude Code CLI or Codex desktop/)
})

test('the no-agent blocker names only the agents that are on this Mac', () => {
  const steps = buildSetupChecklist({
    mcpListOutput: '', browserEnabled: false, tmuxAvailable: true, confirmations: {},
    backends: [
      { id: 'claude', label: 'Claude Code CLI', installed: false, ready: false },
      { id: 'codex-desktop', label: 'Codex desktop', installed: true, ready: false, reason: 'not-armed' },
    ],
  })
  assert.equal(blockerOf(steps), 'No agent is set up yet — Remote needs Codex desktop to run anything.')
})

test('pickers list only detected backends, and never name an undetected default', () => {
  const probes = [
    { id: 'claude', label: 'Claude Code CLI', installed: false, ready: false },
    { id: 'codex', label: 'Codex CLI', installed: true, ready: true },
  ]
  assert.deepEqual(detectedBackends(probes).map((b) => b.id), ['codex'])
  assert.equal(displayedAgent('claude', detectedBackends(probes)), 'codex', 'the stored default is not on this Mac')
  assert.equal(displayedAgent('codex', detectedBackends(probes)), 'codex')
  assert.equal(displayedAgent('claude', []), 'claude', 'nothing detected ⇒ nothing better to name')
})
