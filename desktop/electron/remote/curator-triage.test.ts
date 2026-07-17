import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTriageMetrics, passesTriage, DEFAULT_TRIAGE } from './curator-triage.ts'

const line = (o: object) => JSON.stringify(o)
const tool = (name: string, ts: string) => line({ timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] } })
const result = (isErr: boolean, ts: string) => line({ timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', is_error: isErr, content: 'x' }] } })
const userMsg = (ts: string) => line({ timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'do it differently' }] } })

test('metrics: counts tools, errors, recoveries, user turns, wall clock', () => {
  const m = computeTriageMetrics([
    userMsg('2026-07-17T10:00:00Z'),
    tool('Bash', '2026-07-17T10:01:00Z'),
    result(true, '2026-07-17T10:01:10Z'),   // error…
    tool('Bash', '2026-07-17T10:02:00Z'),
    result(false, '2026-07-17T10:02:10Z'),  // …then recovery
    tool('Read', '2026-07-17T10:20:00Z'),
    'not json — skipped',
  ])
  assert.equal(m.toolCalls, 3)
  assert.equal(m.distinctTools, 2)
  assert.equal(m.errors, 1)
  assert.equal(m.recoveries, 1)             // error followed by a later non-error result
  assert.equal(m.userTurns, 1)              // tool_result carriers are not user turns
  assert.equal(m.wallClockMs, 20 * 60_000)  // first→last timestamp
})

test('gate: expensive-and-long passes; short-and-clean fails; error-heavy passes alone', () => {
  const base = { wallClockMs: 0, toolCalls: 0, distinctTools: 0, errors: 0, recoveries: 0, userTurns: 0, lines: 0 }
  assert.equal(passesTriage({ ...base, wallClockMs: 11 * 60_000, toolCalls: 20 }), true)
  assert.equal(passesTriage({ ...base, wallClockMs: 2 * 60_000, toolCalls: 4 }), false)
  assert.equal(passesTriage({ ...base, errors: DEFAULT_TRIAGE.minErrors }), true)
  assert.equal(passesTriage({ ...base, userTurns: DEFAULT_TRIAGE.minUserTurns }), true)
})
