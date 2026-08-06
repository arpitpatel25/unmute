import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installHookSettings, installHookSettingsSync, hookSettingsPath } from './hooks.ts'

test('hook settings are written to OUR directory, never a session cwd', async () => {
  // The whole point of the 2026-08-06 change. The previous version wrote
  // .claude/settings.json into the session's working directory, which is why
  // project-bound sessions — the longest-lived ones — got no hooks at all.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-base-'))
  const p = await installHookSettings(base, 42117, 'tok')
  assert.equal(p, hookSettingsPath(base))
  assert.ok(p!.startsWith(base), 'settings must live under Unmute baseDir')
  assert.ok((await fs.stat(p!)).isFile())
})

test('the written settings wire the five report-OUT events', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-base-'))
  const p = await installHookSettings(base, 42117, 'tok-abc')
  const doc = JSON.parse(await fs.readFile(p!, 'utf8'))
  assert.deepEqual(
    Object.keys(doc.hooks).sort(),
    ['Notification', 'PostToolUse', 'SessionEnd', 'Stop', 'UserPromptSubmit'].sort(),
  )
  assert.match(JSON.stringify(doc), /127\.0\.0\.1:42117/)
  assert.match(JSON.stringify(doc), /Bearer tok-abc/)
})

test('installing twice is idempotent — the same path, freshly written', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-base-'))
  const a = await installHookSettings(base, 1, 'x')
  const b = await installHookSettings(base, 2, 'y')
  assert.equal(a, b)
  assert.match(await fs.readFile(b!, 'utf8'), /127\.0\.0\.1:2/)
})

test('an unwritable baseDir degrades to null, never throws', async () => {
  // A session with no hooks still runs and is still polled — installing them
  // must never be able to block a dispatch.
  const p = await installHookSettings('/definitely/not/writable/anywhere', 1, 'x')
  assert.equal(p, null)
})

test('the sync install writes the same file, before anything can dispatch', async () => {
  // The async version left a cold-start window: a task spawned before the
  // promise resolved launched with no --settings, so it had no hooks, so the
  // observer never heard from it. Startup uses this one.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-base-'))
  const p = installHookSettingsSync(base, 42117, 'tok')
  assert.equal(p, hookSettingsPath(base))
  const doc = JSON.parse(await fs.readFile(p!, 'utf8'))
  assert.equal(Object.keys(doc.hooks).length, 5)
  assert.equal(installHookSettingsSync('/definitely/not/writable', 1, 'x'), null)
})
