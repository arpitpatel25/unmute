// REPLAY A SCREEN, NOT A REEL OF FRAMES.
//
// The live terminal seeded itself by replaying the raw PTY byte log. That log
// is a TUI's paint stream: absolute cursor moves (\x1b[15;3H), scroll-region
// sets (\x1b[1;32r), scroll-ups (\x1b[4S). Those coordinates only mean anything
// against the grid they were computed for.
//
// A tmux window's geometry changes — opening the live terminal resizes it to
// the xterm's fit — while the attaching client is spawned at a hardcoded
// 120x40. After an app relaunch the buffer therefore holds frames drawn at two
// or three different geometries, and replaying them in sequence lands text
// from one grid on top of another. Observed 29 Aug: exactly the two sessions
// whose windows had been resized to 122x32 rendered corrupt; the six still at
// 120x40 were clean. Session length had nothing to do with it.
//
// `capture-pane -p -e` returns the RENDERED screen — plain lines plus SGR
// colour, no cursor addressing anywhere. There is no grid to be wrong about,
// so it is safe to write into an xterm of any size.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmuxCapturePaneArgs, snapshotIsUsable } from './tmux-snapshot.ts'
import { TMUX_SOCKET, sessionNameFor } from './tmux.ts'

test('captures the rendered screen WITH colour, including scrollback', () => {
  const a = tmuxCapturePaneArgs('unmute-abc', 500)
  assert.deepEqual(a, ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-S', '-500', '-t', 'unmute-abc'])
})

test('-e is not optional — without it the seed loses every colour', () => {
  assert.ok(tmuxCapturePaneArgs('s', 10).includes('-e'))
})

test('scrollback depth is clamped to something a terminal can hold', () => {
  // 0 or negative would capture only the visible screen and silently lose
  // history; unbounded would replay megabytes into xterm on every mount.
  assert.ok(tmuxCapturePaneArgs('s', 0).includes('-0'))
  assert.ok(tmuxCapturePaneArgs('s', -5).includes('-0'))
  assert.ok(tmuxCapturePaneArgs('s', 99_999).includes('-10000'))
})

test('the session name matches the one the attach uses', () => {
  const id = '9b704977-bfab-4789-b467-a1f6d56c6fed'
  assert.ok(tmuxCapturePaneArgs(sessionNameFor(id), 100).includes(sessionNameFor(id)))
})

test('an empty or whitespace-only capture is NOT usable', () => {
  // tmux answers a dead or unknown session with nothing. Seeding an empty
  // string would blank a terminal that had content, so the caller must fall
  // back to the raw buffer rather than trust it.
  assert.equal(snapshotIsUsable(''), false)
  assert.equal(snapshotIsUsable('   \n\n  '), false)
  assert.equal(snapshotIsUsable(null), false)
  assert.equal(snapshotIsUsable(undefined), false)
})

test('a real capture is usable', () => {
  assert.equal(snapshotIsUsable('\x1b[38;5;244m─── overview ───\x1b[39m\n❯ '), true)
})

test('a capture carries no absolute cursor addressing — the whole point', () => {
  const real = '\x1b[38;5;244m──── Unmute Cloud repository overview (2) ────\x1b[39m\n❯ \n'
  assert.ok(!/\x1b\[\d+;\d+H/.test(real))
  assert.ok(!/\x1b\[\d*[ST]/.test(real))
  assert.equal(snapshotIsUsable(real), true)
})
