import { test } from 'node:test'
import assert from 'node:assert'
import { telemetryFileName, telemetryLine, filesToPrune } from './dictationTelemetry'

test('telemetryFileName formats by UTC day', () => {
  // 2026-07-15T10:00:00Z
  assert.equal(telemetryFileName(Date.UTC(2026, 6, 15, 10)), 'dictation-2026-07-15.jsonl')
})

test('telemetryLine is single-line JSON with ts and event', () => {
  const line = telemetryLine('chunk-resolved', { idx: 2, engine: 'cloud' }, 1234567890)
  const parsed = JSON.parse(line)
  assert.equal(parsed.event, 'chunk-resolved')
  assert.equal(parsed.ts, 1234567890)
  assert.equal(parsed.idx, 2)
  assert.ok(!line.includes('\n'))
})

test('telemetryLine never throws on unserializable data', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const line = telemetryLine('x', cyclic, 1)
  assert.ok(typeof line === 'string' && line.length > 0)
})

test('filesToPrune keeps the newest 7 days of dictation files', () => {
  const now = Date.UTC(2026, 6, 15)
  const names = [
    'dictation-2026-07-15.jsonl',
    'dictation-2026-07-10.jsonl',
    'dictation-2026-07-01.jsonl',
    'unrelated.txt',
  ]
  assert.deepEqual(filesToPrune(names, now), ['dictation-2026-07-01.jsonl'])
})
