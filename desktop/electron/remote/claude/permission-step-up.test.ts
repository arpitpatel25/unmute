import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ClaudeTaskSession, type ClaudeTaskEvent, type ClaudePermissionMode } from './task-session'

/** A Claude that starts in `reported` and refuses `forbidden` modes with the
 *  CLI's own wording (measured on 2.1.273). */
function claude(requested: ClaudePermissionMode, reported: string, forbidden: string[]) {
  const events: ClaudeTaskEvent[] = []
  const asked: string[] = []
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  const reply = (frame: unknown) => queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n')))
  child.stdin = new Writable({ write(chunk, _e, callback) {
    const f = JSON.parse(String(chunk)); callback()
    if (f.request?.subtype === 'initialize') reply({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, response: { current_permission_mode: reported } } })
    if (f.request?.subtype === 'set_permission_mode') {
      asked.push(f.request.mode)
      reply({ type: 'control_response', response: forbidden.includes(f.request.mode)
        ? { subtype: 'error', request_id: f.request_id, error: `Cannot set permission mode to ${f.request.mode}: auto mode disabled by settings` }
        : { subtype: 'success', request_id: f.request_id, response: { mode: f.request.mode } } })
    }
  } })
  child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true }
  const driver = new ClaudeTaskSession({ binary: 'claude', cwd: '/tmp', permissionMode: requested, onEvent: e => events.push(e), spawn: () => child })
  return { driver, events, asked }
}

test('bypass and auto disabled: Claude lands on default, Unmute steps it up to acceptEdits', async () => {
  const c = claude('bypassPermissions', 'default', ['auto'])
  await c.driver.start()
  assert.deepEqual(c.asked, ['auto', 'acceptEdits'], 'never tries bypass mid-session; tries auto, then acceptEdits')
  assert.equal(c.driver.permissionMode, 'acceptEdits')
  assert.deepEqual(c.events.find(e => e.type === 'permission-mode'), { type: 'permission-mode', requested: 'bypassPermissions', effective: 'acceptEdits' })
  c.driver.close()
})

test('only bypass disabled: Claude already chose auto, nothing to step', async () => {
  const c = claude('bypassPermissions', 'auto', [])
  await c.driver.start()
  assert.deepEqual(c.asked, [])
  assert.equal(c.driver.permissionMode, 'auto')
  c.driver.close()
})

test('no policy: the asked mode is confirmed and nothing changes', async () => {
  const c = claude('bypassPermissions', 'bypassPermissions', [])
  await c.driver.start()
  assert.deepEqual(c.asked, [])
  assert.deepEqual(c.events.find(e => e.type === 'permission-mode'), { type: 'permission-mode', requested: 'bypassPermissions', effective: 'bypassPermissions' })
  c.driver.close()
})

test('a deliberate plan mode is never touched', async () => {
  const c = claude('plan', 'plan', [])
  await c.driver.start()
  assert.deepEqual(c.asked, [])
  assert.equal(c.events.some(e => e.type === 'permission-mode'), false)
  c.driver.close()
})
