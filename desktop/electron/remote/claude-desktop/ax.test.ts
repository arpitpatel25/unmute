import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTreeAlive, readRunning, readConsent, readState, ClaudeDesktopAx,
  readSidebarRows, statusForTitle, STUB_NODE_CEILING, type AxNode,
} from './ax'

// Node shapes match what the native addon actually returns (see native-ax
// src/ax.mm nodeToJs): id, depth, role, label, actions — and NO subrole, which
// is why nothing below can lean on one.
let nextId = 1
const node = (role: string, label = '', actions: string[] = []): AxNode =>
  ({ id: nextId++, depth: 3, role, label, actions })
const filler = (n: number) => Array.from({ length: n }, () => node('AXGroup'))

// ── is the tree even there ────────────────────────────────────────────────

test('a renderer landmark proves the tree is alive, whatever the node count', () => {
  assert.equal(isTreeAlive([node('AXWebArea')]), true)
  assert.equal(isTreeAlive([node('AXLandmarkMain')]), true)
})

test('the 185-node stub is NOT alive — this is the silent-failure mode', () => {
  // Measured on a real app launched backgrounded: 185 nodes, zero AXWebArea.
  // Reads succeed and return nothing, so this check is the only thing standing
  // between "no information" and "everything looks fine".
  assert.equal(isTreeAlive(filler(185)), false)
})

test('node count is a backstop for a build that renames its landmarks', () => {
  assert.equal(isTreeAlive(filler(STUB_NODE_CEILING + 1)), true)
})

test('a dead tree reports nothing, and reports it as UNKNOWN not as idle', () => {
  const s = readState(filler(10))
  assert.equal(s.treeAlive, false)
  assert.equal(s.running, null)      // null, never false
  assert.equal(s.consent, null)
})

// ── running ───────────────────────────────────────────────────────────────

test('Stop present ⇒ a turn is running', () => {
  assert.equal(readRunning([node('AXButton', 'Stop', ['AXPress'])]), true)
})

test('Send present ⇒ not running', () => {
  assert.equal(readRunning([node('AXButton', 'Send', ['AXPress'])]), false)
})

test('neither button ⇒ null, because a broken locator is not an idle app', () => {
  assert.equal(readRunning([node('AXButton', 'Settings', ['AXPress'])]), null)
})

test('Stop wins over a stale Send elsewhere in the tree', () => {
  assert.equal(readRunning([
    node('AXButton', 'Send', ['AXPress']),
    node('AXButton', 'Stop', ['AXPress']),
  ]), true)
})

// ── the permission prompt ─────────────────────────────────────────────────

test('a question followed by a small set of buttons is a prompt', () => {
  const nodes = [
    ...filler(300),
    node('AXStaticText', 'Allow Claude to write unmute-keytest.txt?'),
    node('AXGroup'),
    node('AXButton', 'Deny 1', ['AXPress']),
    node('AXButton', 'Always allow 2', ['AXPress']),
    node('AXButton', 'Allow once 3 ⌘ ⏎', ['AXPress']),
  ]
  const c = readConsent(nodes)!
  assert.equal(c.question, 'Allow Claude to write unmute-keytest.txt?')
  assert.deepEqual(c.options.map((o) => o.label), ['Deny 1', 'Always allow 2', 'Allow once 3 ⌘ ⏎'])
})

test('matched on SHAPE, not on English copy — a localized prompt still works', () => {
  // The whole point: a prompt we stop recognising looks exactly like a healthy
  // task while the user is actually stuck waiting.
  const nodes = [
    ...filler(300),
    node('AXStaticText', 'Autoriser Claude à écrire dans ce fichier ?'.replace(' ?', '?')),
    node('AXButton', 'Refuser', ['AXPress']),
    node('AXButton', 'Autoriser', ['AXPress']),
  ]
  const c = readConsent(nodes)!
  assert.equal(c.options.length, 2)
})

test('option ids come back, because labels carry shortcut digits and cannot be matched', () => {
  const nodes = [
    ...filler(300),
    node('AXStaticText', 'Allow Claude to run this command?'),
    node('AXButton', 'Deny 1', ['AXPress']),
    node('AXButton', 'Allow once 3 ⌘ ⏎', ['AXPress']),
  ]
  const c = readConsent(nodes)!
  assert.ok(c.options.every((o) => typeof o.id === 'number'))
})

test('one button is a notice, not a choice', () => {
  const c = readConsent([
    ...filler(300),
    node('AXStaticText', 'Something happened here?'),
    node('AXButton', 'OK', ['AXPress']),
  ])
  assert.equal(c, null)
})

test('a toolbar of many buttons is not a prompt', () => {
  const c = readConsent([
    ...filler(300),
    node('AXStaticText', 'Is this a question?'),
    ...Array.from({ length: 9 }, (_, i) => node('AXButton', `b${i}`, ['AXPress'])),
  ])
  assert.equal(c, null)
})

test('a question with no buttons near it is just text in the transcript', () => {
  const c = readConsent([
    ...filler(300),
    node('AXStaticText', 'Should I refactor this?'),
    ...filler(40),
    node('AXButton', 'Send', ['AXPress']),
  ])
  assert.equal(c, null)
})

test('the LIVE prompt wins over older questions quoted in the conversation', () => {
  const nodes = [
    ...filler(200),
    node('AXStaticText', 'An older question from earlier?'),
    node('AXButton', 'Deny 1', ['AXPress']),
    node('AXButton', 'Allow once 3', ['AXPress']),
    ...filler(50),
    node('AXStaticText', 'The prompt on screen right now?'),
    node('AXButton', 'Deny 1', ['AXPress']),
    node('AXButton', 'Allow once 3', ['AXPress']),
  ]
  assert.equal(readConsent(nodes)!.question, 'The prompt on screen right now?')
})

test('a non-pressable element is not offered as an option', () => {
  const c = readConsent([
    ...filler(300),
    node('AXStaticText', 'Allow this?'),
    node('AXButton', 'Deny', ['AXPress']),
    node('AXButton', 'disabled-looking', ['AXShowMenu']),
  ])
  assert.equal(c, null)   // only one real option left ⇒ not a choice
})

// ── the bridge wrapper ────────────────────────────────────────────────────

const fakeBridge = (impl: (m: string, a: unknown[]) => unknown) => ({
  call: async (m: string, a: unknown[]) => impl(m, a),
  trusted: async () => true,
  dispose: () => {},
})

test('reads the tree with a depth well past the addon default of 14', () => {
  // Paths run to 33 levels; a default-depth read would simply not contain the
  // buttons and would look like a healthy, prompt-free app.
  let seen: unknown[] = []
  const ax = new ClaudeDesktopAx({ bridge: fakeBridge((_m, a) => { seen = a; return { nodes: [] } }) as never })
  return ax.nodes().then(() => {
    assert.ok((seen[3] as number) > 14, `depth ${seen[3] as number} must exceed 14`)
    assert.equal(seen[4], true, 'must request the whole tree, not interesting-only')
  })
})

test('a bridge error yields no nodes rather than throwing into the poll', async () => {
  const ax = new ClaudeDesktopAx({ bridge: fakeBridge(() => ({ error: 'app not running' })) as never })
  assert.deepEqual(await ax.nodes(), [])
})

test('a thrown bridge is also survivable', async () => {
  const ax = new ClaudeDesktopAx({ bridge: fakeBridge(() => { throw new Error('addon missing') }) as never })
  assert.deepEqual(await ax.nodes(), [])
  assert.equal((await ax.state()).treeAlive, false)
})

// ── the sidebar: per-task status, from one read ───────────────────────────

test('a row label is "<status> <title>" — status is what remains', () => {
  // Copied from a real window: 'Idle Season preference questions'.
  const rows = readSidebarRows(
    [node('AXButton', 'Idle Season preference questions', ['AXPress'])],
    ['Season preference questions'])
  assert.deepEqual(rows.map((r) => [r.title, r.status]),
    [['Season preference questions', 'Idle']])
})

test('no status vocabulary is hardcoded — an unseen word passes straight through', () => {
  // Only 'Idle' has ever been observed. The interesting value is the one we
  // have not seen, because a blocked task is never idle.
  const rows = readSidebarRows(
    [node('AXButton', 'Needs permission Fix login', ['AXPress'])], ['Fix login'])
  assert.equal(rows[0].status, 'Needs permission')
})

test('a bare title row has empty status, not a bogus one', () => {
  const rows = readSidebarRows([node('AXButton', 'Fix login', ['AXPress'])], ['Fix login'])
  assert.equal(rows[0].status, '')
})

test('the longest matching title wins, so a prefix cannot steal the row', () => {
  const rows = readSidebarRows(
    [node('AXButton', 'Idle Review the frontend repository', ['AXPress'])],
    ['Review the frontend', 'Review the frontend repository'])
  assert.equal(rows[0].title, 'Review the frontend repository')
  assert.equal(rows[0].status, 'Idle')
})

test('duplicate titles that AGREE still give an answer', () => {
  // A real sidebar carried the same title three times.
  const rows = readSidebarRows([
    node('AXButton', 'Idle Review codebase', ['AXPress']),
    node('AXButton', 'Idle Review codebase', ['AXPress']),
  ], ['Review codebase'])
  assert.equal(statusForTitle(rows, 'Review codebase'), 'Idle')
})

test('duplicate titles that DISAGREE give null — never one task status for another', () => {
  const rows = readSidebarRows([
    node('AXButton', 'Idle Review codebase', ['AXPress']),
    node('AXButton', 'Working Review codebase', ['AXPress']),
  ], ['Review codebase'])
  assert.equal(statusForTitle(rows, 'Review codebase'), null)
})

test('an unknown title is null, not an empty status', () => {
  assert.equal(statusForTitle([], 'Nothing like this'), null)
})

test('a stub tree yields NO rows, so it cannot be read as "everything idle"', async () => {
  const ax = new ClaudeDesktopAx({
    bridge: fakeBridge(() => ({ nodes: filler(20) })) as never,
  })
  assert.deepEqual(await ax.sidebar(['Fix login']), [])
})
