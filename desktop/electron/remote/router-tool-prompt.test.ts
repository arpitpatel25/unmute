// THE INVARIANT THAT COST THREE SPIKE RUNS.
//
// An MCP tool's schema is DEFERRED: the model must call ToolSearch to load it
// before it can call the tool. The routing prompt has always ended its opening
// instruction with "Do nothing else — no tools, no browser, no research",
// which is right for the two JSON transports and fatal for the tool one: it
// forbids the load, so the model never calls the tool and the route silently
// never happens. No error, no reply, just a 60s timeout and a failsafe task.
//
// These pin the tool-mode prompt so that phrasing can never come back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoutingPrompt } from './router.ts'
import { QUALIFIED_TOOL } from './headless-router-engine.ts'

const NONE: never[] = []
const GROUPS = [{ label: 'unmute marketing' }]
const build = (opts: { defer?: boolean; tool?: string } = {}, path: string | null = null) =>
  buildRoutingPrompt('plan reddit marketing', NONE, path, NONE, NONE, NONE, NONE, NONE, undefined, GROUPS, opts)

test('tool mode permits loading the tool, and never says "no tools"', () => {
  const p = build({ tool: QUALIFIED_TOOL })
  assert.match(p, /ToolSearch/)
  assert.match(p, new RegExp(QUALIFIED_TOOL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.ok(!/no tools/i.test(p), 'this phrasing forbids loading the deferred tool')
})

test('the other two transports keep their stricter instruction', () => {
  // They emit JSON directly and genuinely should touch nothing.
  assert.match(build({}, '/d/decision.json'), /no tools/)
  assert.match(build({}), /no tools/)
})

test('tool mode drops the hand-written schema line, since the tool carries it', () => {
  const p = build({ tool: QUALIFIED_TOOL })
  assert.ok(!/Write exactly: \{"action"/.test(p))
  assert.match(build({}), /Write exactly: \{"action"/)
})

test('tool mode KEEPS the judgment the schema cannot express', () => {
  // A tool description is a sentence; these are the rules that decide whether
  // the answer is any good. They must survive the transport change.
  const p = build({ tool: QUALIFIED_TOOL })
  assert.match(p, /LEAD WITH THE SUBJECT/)
  assert.match(p, /A group is a STREAM at the altitude/)
  assert.match(p, /TOO NARROW/)
  assert.match(p, /Decide: does this command START a new task/)
})

test('every transport still gets the same routing rules', () => {
  for (const p of [build({ tool: QUALIFIED_TOOL }), build({}, '/d/decision.json'), build({})]) {
    assert.match(p, /Spoken command: "plan reddit marketing"/)
    assert.match(p, /FIRST classify the command's SPECIES/)
    assert.match(p, /LIVE GROUPS/)
  }
})
