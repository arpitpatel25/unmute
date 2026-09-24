import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExplicitBugReportRequest } from './bug-report.ts'

test('recognizes direct requests to report a bug to Unmute', () => {
  for (const request of [
    'Please report this bug to Unmute.',
    'Send a bug report to the Unmute team about the broken mic.',
    'Tell the Unmute team about this bug.',
    'File this issue with Unmute, please.',
    'Can you report this bug to Unmute?',
  ]) assert.equal(isExplicitBugReportRequest(request), true, request)
})

test('does not turn discussion or an unrelated report into bug submission', () => {
  for (const request of [
    'I found a bug in Unmute.',
    'How do I report a bug to Unmute?',
    'Write a bug report for me.',
    'Report this bug to the project maintainer.',
    'Do not report this bug to Unmute.',
  ]) assert.equal(isExplicitBugReportRequest(request), false, request)
})
