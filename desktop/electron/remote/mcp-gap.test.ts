import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectMcpGap } from './mcp-gap.ts'

test('detects a missing Slack integration and hands the exact fix (PRD §12.3)', () => {
  const g = detectMcpGap('Slack is not connected in this Claude Code')
  assert.equal(g?.integration, 'Slack')
  assert.equal(g?.fixCommand, 'claude mcp add slack')
  assert.match(g!.message, /claude mcp add slack/)
  assert.match(g!.message, /retry/i)
})

test('detects GitHub / Jira / Notion / Drive gaps', () => {
  assert.equal(detectMcpGap('the github mcp is not configured')?.integration, 'GitHub')
  assert.equal(detectMcpGap('jira integration not set up')?.integration, 'Jira')
  assert.equal(detectMcpGap('notion is not installed')?.integration, 'Notion')
  assert.equal(detectMcpGap("couldn't find the drive connection")?.integration, 'Google Drive')
})

test('does NOT false-flag a successful mention of an integration', () => {
  assert.equal(detectMcpGap('Sent the file to Rishi on Slack'), null)
  assert.equal(detectMcpGap('Opened the GitHub PR'), null)
})

test('returns null for non-integration failures and empty input', () => {
  assert.equal(detectMcpGap('zip file is password protected'), null)
  assert.equal(detectMcpGap(''), null)
  assert.equal(detectMcpGap(null), null)
})
