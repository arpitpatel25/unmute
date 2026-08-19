import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONNECT_SWEEP_DELAYS_MS,
  removeSteerBlock,
  removeUnmuteComputerServer,
  sweepUnmuteFromCodexAfterConnect,
} from './codex-prune'

const REAL = `[mcp_servers.chrome-devtools]
command = "npx"

[mcp_servers.unmute-computer]
url = "http://127.0.0.1:42118/ax"

[mcp_servers.unmute]
url = "http://127.0.0.1:42117/mcp"
bearer_token_env_var = "UNMUTE_MCP_TOKEN"

[mcp_servers.cua-computer-use]
command = "/Users/zodpatel/.local/bin/cua-driver"
`

test('removes our server and nothing else', () => {
  const { text, removed } = removeUnmuteComputerServer(REAL)

  assert.equal(removed, true)
  assert.equal(text.includes('[mcp_servers.unmute-computer]'), false)
  // The task bridge is a different feature and the user wants it.
  assert.ok(text.includes('[mcp_servers.unmute]'), 'the task bridge survives')
  assert.ok(text.includes('bearer_token_env_var'), 'and keeps its body')
  // CuaDriver.app is the user's own install, whatever it is named.
  assert.ok(text.includes('[mcp_servers.cua-computer-use]'), 'the user\'s own driver survives')
  assert.ok(text.includes('[mcp_servers.chrome-devtools]'))
})

test('a config without it is returned untouched', () => {
  const clean = '[mcp_servers.unmute]\nurl = "x"\n'
  assert.deepEqual(removeUnmuteComputerServer(clean), { text: clean, removed: false })
})

// A user who hand-wrote something under our name meant it. Deleting that would
// be the same surprise this function exists to undo.
test('a section under our name that is not ours is left alone', () => {
  const theirs = '[mcp_servers.unmute-computer]\ncommand = "/opt/their/own/thing"\n'
  assert.deepEqual(removeUnmuteComputerServer(theirs), { text: theirs, removed: false })
})

test('a longer name that merely starts with ours is not matched', () => {
  const other = '[mcp_servers.unmute-computer-extra]\nurl = "http://127.0.0.1:42118/ax"\n'
  assert.equal(removeUnmuteComputerServer(other).removed, false)
})

test('the section is only matched at the start of a line', () => {
  const commented = '# [mcp_servers.unmute-computer]\nurl = "http://127.0.0.1:42118/ax"\n'
  assert.equal(removeUnmuteComputerServer(commented).removed, false)
})

test('a trailing section with nothing after it is removed cleanly', () => {
  const last = '[mcp_servers.paper]\nurl = "x"\n\n[mcp_servers.unmute-computer]\nurl = "http://127.0.0.1:42118/ax"\n'
  const { text, removed } = removeUnmuteComputerServer(last)
  assert.equal(removed, true)
  assert.equal(text, '[mcp_servers.paper]\nurl = "x"\n\n')
})

test('the steer block goes and the user\'s own notes stay', () => {
  const md = `My own instructions.

<!-- UNMUTE-COMPUTER-USE:BEGIN -->
For GUI tasks, PREFER the unmute-computer MCP tools.
<!-- UNMUTE-COMPUTER-USE:END -->

More of my notes.`
  const { text, removed } = removeSteerBlock(md)

  assert.equal(removed, true)
  assert.equal(text.includes('unmute-computer'), false)
  assert.ok(text.includes('My own instructions.'))
  assert.ok(text.includes('More of my notes.'))
})

test('a file that is only the block becomes empty, not a stray newline', () => {
  const only = '<!-- UNMUTE-COMPUTER-USE:BEGIN -->\ntext\n<!-- UNMUTE-COMPUTER-USE:END -->\n'
  assert.deepEqual(removeSteerBlock(only), { text: '', removed: true })
})

test('markdown without the block is untouched', () => {
  const md = '# My notes\n'
  assert.deepEqual(removeSteerBlock(md), { text: md, removed: false })
})

// THE GAP A SINGLE PASS LEAVES. The import lands AFTER connect returns —
// measured at fourteen seconds on 19 August — so one prune on completion runs
// before there is anything to remove, and the entry then survives until the
// next launch.
test('the connect sweep keeps checking past the moment the import lands', () => {
  const scheduled: number[] = []
  sweepUnmuteFromCodexAfterConnect('/nonexistent-home', (_fn, ms) => { scheduled.push(ms); return { unref() {} } })

  assert.deepEqual(scheduled, [...CONNECT_SWEEP_DELAYS_MS])
  assert.ok(scheduled.some((ms) => ms > 14_000), 'a pass must fall after the observed 14s delay')
  assert.ok(scheduled.length >= 3, 'one retry is not a window')
})

test('the sweep never holds the process open', () => {
  let unreffed = 0
  sweepUnmuteFromCodexAfterConnect('/nonexistent-home', () => ({ unref() { unreffed += 1 } }))

  assert.equal(unreffed, CONNECT_SWEEP_DELAYS_MS.length, 'every timer is unreffed')
})
