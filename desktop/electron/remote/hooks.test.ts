import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, utimesSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { installHooks, hookActivityMs, ACTIVITY_MARKER } from './hooks.ts'

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-hooks-'))
}

// Run the installed hook script for one event; return its stdout.
function fire(dir: string, event: 'prompt' | 'tool' | 'stop'): string {
  return execFileSync('sh', [path.join(dir, '.unmute-hook.sh'), event], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
  })
}

test('installHooks writes an executable script + settings.json wiring the 3 events', async () => {
  const dir = await tmpDir()
  await installHooks(dir)

  const scriptStat = statSync(path.join(dir, '.unmute-hook.sh'))
  assert.ok(scriptStat.mode & 0o100, 'script is owner-executable')

  const settings = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'))
  assert.ok(settings.hooks.UserPromptSubmit, 'UserPromptSubmit wired')
  assert.ok(settings.hooks.PostToolUse, 'PostToolUse wired')
  assert.ok(settings.hooks.Stop, 'Stop wired')
  // commands invoke our script with the matching event arg
  assert.match(settings.hooks.Stop[0].hooks[0].command, /\.unmute-hook\.sh' stop$/)
  assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /\.unmute-hook\.sh' tool$/)
})

test('heartbeat: prompt/tool/stop all advance the activity marker', async () => {
  const dir = await tmpDir()
  await installHooks(dir)
  assert.equal(await hookActivityMs(dir), null, 'no marker before any hook fires')

  fire(dir, 'prompt')
  const a = await hookActivityMs(dir)
  assert.ok(typeof a === 'number', 'marker exists after a hook fires')

  // tool fires again later → mtime advances (set marker into the past first so
  // the bump is observable without relying on sub-second timing)
  utimesSync(path.join(dir, ACTIVITY_MARKER), new Date(Date.now() - 5000), new Date(Date.now() - 5000))
  const before = await hookActivityMs(dir)
  fire(dir, 'tool')
  const after = await hookActivityMs(dir)
  assert.ok(after! > before!, 'tool advanced the heartbeat')
})

test('enforce: a turn that did NOT write status is blocked, bounded to 2 nudges', async () => {
  const dir = await tmpDir()
  await installHooks(dir)
  fire(dir, 'prompt') // turn start, no status written

  const s1 = fire(dir, 'stop')
  const s2 = fire(dir, 'stop')
  const s3 = fire(dir, 'stop')

  assert.match(s1, /"decision":"block"/, 'first stop blocks')
  assert.match(s1, /status\.json/, 'reason names the status file')
  assert.match(s2, /"decision":"block"/, 'second stop blocks')
  assert.equal(s3.trim(), '', 'third stop is fail-open (no block) — cannot loop')
})

test('allow: a turn that DID write status this turn is not blocked', async () => {
  const dir = await tmpDir()
  await installHooks(dir)
  fire(dir, 'prompt')
  // status written AFTER turn start (deterministic: stamp it newer than turn-start)
  const ts = statSync(path.join(dir, '.unmute-turn-start')).mtimeMs
  await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({ state: 'done' }))
  const newer = new Date(ts + 2000)
  utimesSync(path.join(dir, 'status.json'), newer, newer)

  assert.equal(fire(dir, 'stop').trim(), '', 'fresh status => allowed to finish')
})

test('reset: a new prompt re-arms the enforcer (stale status blocks again)', async () => {
  const dir = await tmpDir()
  await installHooks(dir)
  // turn 1: status written, allowed
  fire(dir, 'prompt')
  const ts1 = statSync(path.join(dir, '.unmute-turn-start')).mtimeMs
  await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({ state: 'done' }))
  const newer = new Date(ts1 + 2000)
  utimesSync(path.join(dir, 'status.json'), newer, newer)
  assert.equal(fire(dir, 'stop').trim(), '', 'turn 1 allowed')

  // turn 2: new prompt makes turn-start newer than the (now stale) status
  const t2 = new Date(ts1 + 5000)
  fire(dir, 'prompt')
  utimesSync(path.join(dir, '.unmute-turn-start'), t2, t2)
  assert.match(fire(dir, 'stop'), /"decision":"block"/, 'stale status re-blocks on the new turn')
})
