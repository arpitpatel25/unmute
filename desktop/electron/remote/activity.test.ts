import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityFromCodexItem, activityFromClaudeTool, describeActivity, clampLabel,
} from './activity.ts'

test('the same work reads the same way whichever backend did it', () => {
  // THE POINT OF THE SHARED VOCABULARY. A shell command is `commandExecution`
  // in Codex and a `Bash` tool in Claude; the card must not have to know which
  // vendor it is looking at, because backend-id-driven rendering is what has
  // broken this surface repeatedly.
  const codex = activityFromCodexItem('commandExecution', { command: 'npm test' })
  const claude = activityFromClaudeTool('Bash', { command: 'npm test' })
  assert.deepEqual(codex, claude)
  assert.equal(describeActivity(codex), 'running npm test')
})

test('a browser is browsing, not "a tool"', () => {
  // Worth its own kind: it is the one people ask about, and "using a tool" for
  // something visibly driving Chrome is the least informative true statement.
  assert.equal(activityFromCodexItem('mcpToolCall', { server: 'chrome-devtools', tool: 'navigate' })?.kind, 'browsing')
  assert.equal(activityFromClaudeTool('mcp__claude-in-chrome__navigate')?.kind, 'browsing')
  assert.equal(activityFromClaudeTool('WebFetch', { url: 'https://x.com' })?.kind, 'browsing')
  // …and a non-browser MCP is still a tool, with its server attributed.
  const t = activityFromClaudeTool('mcp__supabase__query')
  assert.deepEqual(t, { kind: 'tool', label: 'query', detail: 'supabase' })
})

test('an unknown tool degrades to `tool` with its name, it does not vanish', () => {
  // A tool that ships tomorrow must still say something. Returning null here
  // would show "Working" again, which is the thing this module replaces.
  assert.deepEqual(activityFromClaudeTool('SomeFutureTool'), { kind: 'tool', label: 'SomeFutureTool' })
  assert.equal(describeActivity(activityFromClaudeTool('SomeFutureTool')), 'using SomeFutureTool')
})

test('messages are NOT activity', () => {
  // A user message is not the agent doing something, and an agent message is the
  // RESULT rather than the work. Counting either as activity is how a finished
  // task went on claiming it was busy.
  assert.equal(activityFromCodexItem('userMessage'), null)
  assert.equal(activityFromCodexItem('agentMessage'), null)
  assert.equal(activityFromCodexItem('hookPrompt'), null)
})

test('every Codex item type either maps or is deliberately silent', () => {
  // The full ThreadItem union from the generated schema (codex-cli 0.147). This
  // fails when Codex adds an item type, which is the point — a new kind of work
  // showing up as nothing is exactly the silent drift that put four invented
  // model ids into a picker.
  const ALL = [
    'userMessage', 'hookPrompt', 'agentMessage', 'plan', 'reasoning', 'commandExecution',
    'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity',
    'webSearch', 'imageView', 'sleep', 'imageGeneration', 'enteredReviewMode',
    'exitedReviewMode', 'contextCompaction',
  ]
  const SILENT = new Set([
    'userMessage', 'hookPrompt', 'agentMessage', 'sleep', 'enteredReviewMode', 'exitedReviewMode',
  ])
  for (const t of ALL) {
    const a = activityFromCodexItem(t)
    if (SILENT.has(t)) assert.equal(a, null, `${t} should be silent`)
    else assert.ok(a && a.kind, `${t} should map to an activity kind`)
  }
})

test('labels are one line, clamped by the producer not the view', () => {
  const long = 'x'.repeat(200)
  const a = activityFromClaudeTool('Bash', { command: long })
  assert.ok((a?.label ?? '').length <= 60)
  assert.ok((a?.label ?? '').endsWith('…'))
  // Newlines would break a single-line card as surely as length does.
  assert.equal(clampLabel('git commit -m "one\ntwo"'), 'git commit -m "one two"')
  assert.equal(clampLabel('   '), undefined)
})

test('a file path shows the file, not the path', () => {
  const a = activityFromClaudeTool('Edit', { file_path: '/Users/x/deep/nested/auth.ts' })
  assert.deepEqual(a, { kind: 'editing', label: 'auth.ts' })
})

test('describe never returns an empty string for a real activity', () => {
  for (const kind of ['thinking', 'running', 'editing', 'searching', 'browsing', 'tool', 'delegating', 'compacting'] as const) {
    const d = describeActivity({ kind })
    assert.ok(d && d.length > 0, `${kind} has no sentence`)
  }
  assert.equal(describeActivity(undefined), undefined)
})
