import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldAppServerBlocks, blockFromCodexItem } from './blocks-app-server'
import type { Block } from '../blocks'

// THE FIXTURE IS A REAL TURN, captured from a live `codex app-server` on
// 2026-08-16 — 63 messages, 12 methods. Testing the mapping against invented
// shapes is how the rollout reader came to be built on a record Codex had
// already renamed, so this suite reads the wire, not a guess about it.
const LIVE = readFileSync(join(__dirname, '__fixtures__', 'app-server-live-turn.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((m) => m._kind === 'notification')
  .map((m) => ({ method: m.method as string, params: m.params }))

const kinds = (bs: Block[]) => bs.map((b) => b.kind)
const only = <K extends Block['kind']>(bs: Block[], k: K) =>
  bs.filter((b): b is Extract<Block, { kind: K }> => b.kind === k)

// ── against the real capture ───────────────────────────────────────────────

test('the live turn folds into blocks without throwing', () => {
  const { blocks } = foldAppServerBlocks(LIVE)
  assert.ok(blocks.length > 0, 'expected blocks from a real turn')
})

test('the user prompt survives as a user message', () => {
  const { blocks } = foldAppServerBlocks(LIVE)
  const users = only(blocks, 'message').filter((m) => m.role === 'user')
  assert.equal(users.length, 1)
  assert.match(users[0].text, /capture-probe\.txt/)
})

test('the shell command becomes a command block with its real exit code', () => {
  const { blocks } = foldAppServerBlocks(LIVE)
  const cmds = only(blocks, 'command')
  assert.ok(cmds.length >= 1, 'expected at least one command')
  assert.equal(cmds[0].status, 'ok')
  assert.equal(cmds[0].exitCode, 0)
  assert.ok(typeof cmds[0].durationMs === 'number')
  assert.match(cmds[0].command, /echo hello/)
})

test('the created file becomes a fileChange with a real path and line count', () => {
  const { blocks } = foldAppServerBlocks(LIVE)
  const files = only(blocks, 'fileChange')
  assert.equal(files.length, 1)
  assert.match(files[0].path, /capture-probe\.txt$/)
  assert.equal(files[0].verb, 'Added')
  assert.equal(files[0].added, 1)      // the file is exactly "ok\n"
  assert.equal(files[0].removed, 0)
})

test('token usage is read from the thread, not guessed', () => {
  const { usage } = foldAppServerBlocks(LIVE)
  assert.ok(usage && usage.used > 0, 'expected usage from thread/tokenUsage/updated')
})

test('an item appearing started-then-completed is ONE block, not two', () => {
  // Every item arrives twice on this wire. Appending both would double every
  // command in the panel.
  const { blocks } = foldAppServerBlocks(LIVE)
  const ids = only(blocks, 'command').length
  const startedCommands = LIVE.filter((e) => e.method === 'item/started'
    && (e.params as any)?.item?.type === 'commandExecution').length
  assert.equal(ids, startedCommands)
})

// ── streaming ──────────────────────────────────────────────────────────────

test('agentMessage deltas accumulate into one growing message', () => {
  const { blocks } = foldAppServerBlocks([
    { method: 'item/started', params: { item: { type: 'agentMessage', id: 'm1', text: '' } } },
    { method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Hel' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'lo' } },
  ])
  const msgs = only(blocks, 'message').filter((m) => m.role === 'assistant')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].text, 'Hello')
})

test('a completed agentMessage wins over the deltas that built it', () => {
  const { blocks } = foldAppServerBlocks([
    { method: 'item/started', params: { item: { type: 'agentMessage', id: 'm1', text: '' } } },
    { method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'par' } },
    { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'the whole answer' } } },
  ])
  assert.equal(only(blocks, 'message')[0].text, 'the whole answer')
})

test('a running command reads as running until it completes', () => {
  const started = foldAppServerBlocks([
    { method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'sleep 5', status: 'inProgress' } } },
  ])
  assert.equal(only(started.blocks, 'command')[0].status, 'running')
})

test('a nonzero exit marks the command failed', () => {
  const { blocks } = foldAppServerBlocks([
    { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: 'false', status: 'completed', exitCode: 1 } } },
  ])
  assert.equal(only(blocks, 'command')[0].status, 'failed')
})

// ── the open rule at the reader boundary ───────────────────────────────────

test('an unknown notification method is ignored, not turned into a row', () => {
  // An unknown METHOD is noise we have no meaning for. That is different from
  // an unknown BLOCK KIND, which is a future the surface must still draw.
  const { blocks } = foldAppServerBlocks([
    { method: 'thread/somethingNewEntirely', params: { x: 1 } },
  ])
  assert.equal(blocks.length, 0)
})

test('an unknown ITEM type yields an unknown block rather than vanishing', () => {
  const b = blockFromCodexItem({ type: 'holographicPreview', id: 'h1' })
  assert.equal(b?.kind, 'unknown')
})

// ── casing: the wire and the rollout disagree ──────────────────────────────

test('camelCase (wire) and PascalCase (rollout) map to the same block', () => {
  const wire = blockFromCodexItem({ type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', exitCode: 0 })
  const disk = blockFromCodexItem({ type: 'CommandExecution', id: 'c1', command: 'ls', status: 'completed', exit_code: 0 })
  assert.equal(wire?.kind, 'command')
  assert.equal(disk?.kind, 'command')
  assert.equal((wire as any).exitCode, (disk as any).exitCode)
})

test('mcp tool calls carry server and tool, both casings', () => {
  const b = blockFromCodexItem({ type: 'McpToolCall', id: 'm', server: 'chrome-devtools', tool: 'list_pages', duration: { secs: 1, nanos: 843033625 } })
  assert.equal(b?.kind, 'mcpCall')
  assert.equal((b as any).server, 'chrome-devtools')
  assert.equal((b as any).durationMs, 1843)
})

// ── diffs ──────────────────────────────────────────────────────────────────

test('a unified diff is counted by its +/- lines, not its length', () => {
  const b = blockFromCodexItem({
    type: 'fileChange', id: 'f1', status: 'completed',
    changes: [{ path: '/tmp/a.ts', kind: { type: 'modify' },
      diff: '@@ -1,3 +1,4 @@\n context\n+added one\n+added two\n-removed one\n' }],
  })
  assert.equal((b as any).added, 2)
  assert.equal((b as any).removed, 1)
  assert.equal((b as any).verb, 'Edited')
})

test('a delete reads as Deleted', () => {
  const b = blockFromCodexItem({
    type: 'fileChange', id: 'f1', status: 'completed',
    changes: [{ path: '/tmp/gone.ts', kind: { type: 'delete' }, diff: 'a\nb\n' }],
  })
  assert.equal((b as any).verb, 'Deleted')
  assert.equal((b as any).removed, 2)
  assert.equal((b as any).added, 0)
})
