import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeArtifactURL, artifactPathAction, sessionTaskID } from './artifact-url'

test('chat links permit ordinary web/mail links but not executable or application protocols', () => {
  for (const value of ['https://example.com/a?q=1', 'http://localhost:3000', 'mailto:hello@example.com']) assert.equal(safeArtifactURL(value), value)
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/run.command', 'vscode://file/tmp/file', 'not a URL']) assert.throws(() => safeArtifactURL(value), /link/)
})

test('executable and automation artifacts are revealed rather than launched', () => {
  for (const value of ['/tmp/run.command', '/tmp/script.py', '/tmp/App.app', '/tmp/flow.workflow', '/tmp/unknown']) assert.equal(artifactPathAction(value), 'reveal')
  for (const value of ['/tmp/photo.PNG', '/tmp/readme.md', '/tmp/report.pdf', '/tmp/data.json', '/tmp/page.html', '/tmp/page.HTM']) assert.equal(artifactPathAction(value), 'open')
})

test('only exact Unmute task links address a session', () => {
  assert.equal(sessionTaskID('unmute://task/abc123'), 'abc123')
  assert.equal(sessionTaskID('unmute://task/abc123/'), 'abc123')
  for (const value of ['unmute://task/', 'unmute://task/a/b', 'unmute://task/a/../b', 'unmute://tasks/abc', 'unmute://task/abc?x=1', 'unmute://auth/callback', 'https://example.com']) {
    assert.equal(sessionTaskID(value), null, value)
  }
})
