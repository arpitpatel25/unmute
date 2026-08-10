import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexPosture, describePosture } from './posture.ts'

test('auto-approve with nothing fenced is the full-access posture', () => {
  const p = codexPosture({ permissionMode: 'auto-approve' })
  assert.deepEqual(p, {
    approvalPolicy: 'never', sandbox: 'danger-full-access', addDirs: [], fullAccess: true,
  })
})

test('THE FENCE IS REAL FOR CODEX — a control that Claude cannot honour this precisely', () => {
  // sandboxRoots is a user-facing switch on the Remote screen. Hardcoding Codex
  // to full access would leave it rendering while doing nothing — the user sets
  // a boundary, Claude respects it, Codex walks through, and nothing says so.
  const p = codexPosture({ permissionMode: 'auto-approve', sandboxRoots: ['/Users/x/work'] })
  assert.equal(p.sandbox, 'workspace-write')
  assert.deepEqual(p.addDirs, ['/Users/x/work'])
  assert.equal(p.fullAccess, false)
  // …and auto-approve still means "don't interrupt me" INSIDE the fence. Codex
  // separates asking from reach; Claude cannot express this combination at all.
  assert.equal(p.approvalPolicy, 'never')
})

test('prompt mode asks, fenced or not', () => {
  assert.equal(codexPosture({ permissionMode: 'prompt' }).approvalPolicy, 'on-request')
  assert.equal(codexPosture({ permissionMode: 'prompt', sandboxRoots: ['/a'] }).approvalPolicy, 'on-request')
  // Prompt mode never grants the machine, even unfenced.
  assert.equal(codexPosture({ permissionMode: 'prompt' }).sandbox, 'workspace-write')
})

test('without consent, full access is never granted', () => {
  // The posture must never be stronger than the user has agreed to, and the
  // fallback is what a person gets typing `codex` themselves.
  const p = codexPosture({ permissionMode: 'auto-approve', fullAccessAllowed: false })
  assert.equal(p.sandbox, 'workspace-write')
  assert.equal(p.fullAccess, false)
  assert.equal(p.approvalPolicy, 'never', 'consent gates REACH, not whether we interrupt you')
})

test('empty and whitespace roots are not a fence', () => {
  // A settings array that happens to contain '' must not silently downgrade a
  // task to fenced — that would be the mirror of the bug above, a fence the
  // user never set.
  const p = codexPosture({ permissionMode: 'auto-approve', sandboxRoots: ['', '   '] })
  assert.equal(p.fullAccess, true)
})

test('the description says what is granted, not which enum was chosen', () => {
  assert.match(describePosture(codexPosture({ permissionMode: 'auto-approve' })),
    /whole Mac.*without asking/)
  assert.match(describePosture(codexPosture({ permissionMode: 'auto-approve', sandboxRoots: ['/a'] })),
    /1 allowed directory/)
  assert.match(describePosture(codexPosture({ permissionMode: 'prompt' })),
    /task folder, asking/)
})
