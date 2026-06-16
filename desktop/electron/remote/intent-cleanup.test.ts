import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanIntent } from './intent-cleanup.ts'

test('returns cleaned intent when the LLM succeeds (PRD §13.7)', async () => {
  const complete = async () => 'Send report.pdf to Rishi on Slack'
  const r = await cleanIntent('uh send that file to rishi, no the report one, on slack', complete)
  assert.equal(r.intent, 'Send report.pdf to Rishi on Slack')
  assert.equal(r.cleaned, true)
})

test('passthrough raw transcript when the LLM throws (must not block dispatch)', async () => {
  const complete = async () => { throw new Error('network down') }
  const r = await cleanIntent('extract the zip i just downloaded', complete)
  assert.equal(r.intent, 'extract the zip i just downloaded')
  assert.equal(r.cleaned, false)
})

test('passthrough raw transcript when the LLM returns empty', async () => {
  const complete = async () => '   '
  const r = await cleanIntent('open the contract pdf', complete)
  assert.equal(r.intent, 'open the contract pdf')
  assert.equal(r.cleaned, false)
})

test('empty transcript yields empty intent, not an error', async () => {
  const complete = async () => 'should not be called'
  const r = await cleanIntent('   ', complete)
  assert.equal(r.intent, '')
  assert.equal(r.cleaned, false)
})
