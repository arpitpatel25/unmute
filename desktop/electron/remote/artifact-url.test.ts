import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeArtifactURL, artifactPathAction } from './artifact-url'

test('chat links permit ordinary web/mail links but not executable or application protocols', () => {
  for (const value of ['https://example.com/a?q=1', 'http://localhost:3000', 'mailto:hello@example.com']) assert.equal(safeArtifactURL(value), value)
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/run.command', 'vscode://file/tmp/file', 'not a URL']) assert.throws(() => safeArtifactURL(value), /link/)
})

test('executable and automation artifacts are revealed rather than launched', () => {
  for (const value of ['/tmp/run.command', '/tmp/script.py', '/tmp/App.app', '/tmp/flow.workflow', '/tmp/page.html', '/tmp/unknown']) assert.equal(artifactPathAction(value), 'reveal')
  for (const value of ['/tmp/photo.PNG', '/tmp/readme.md', '/tmp/report.pdf', '/tmp/data.json']) assert.equal(artifactPathAction(value), 'open')
})
