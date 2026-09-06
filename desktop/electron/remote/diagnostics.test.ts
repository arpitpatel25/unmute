import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureRemoteLogging, setConsoleMirror } from './log'
import { diagnostic, diagnosticError } from './diagnostics'

test('multiline error messages cannot leak into diagnostic call sites', () => {
  const result = diagnosticError(new Error('safe\npassword=private-value\n    at forged-private-value'))
  assert.ok(!JSON.stringify(result).includes('private-value'))
  assert.ok((result.callSites as string[]).some(line => line.includes('diagnostics.test.ts')))
})

test('worker audit is on disk before returning, without raw error text', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-log-'))
  try {
    setConsoleMirror(false)
    const file = configureRemoteLogging({ dir: root, runId: 'test', synchronous: true })
    diagnostic('agent-tool-completed', { callId: 'call-1', ...diagnosticError(new Error('password=private-value')) })
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('agent-tool-completed'))
    assert.ok(text.includes('call-1'))
    assert.ok(!text.includes('private-value'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
