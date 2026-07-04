import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionNameFor, shellQuote, buildCommand, tmuxNewSessionArgs,
  tmuxAttachArgs, tmuxKillSessionArgs, tmuxCapturePaneArgs, resolveTmuxBin, TMUX_SOCKET,
} from './tmux.ts'

test('sessionNameFor is deterministic per task', () => {
  assert.equal(sessionNameFor('abc-123'), 'unmute-abc-123')
})

test('shellQuote leaves safe tokens, quotes spaces', () => {
  assert.equal(shellQuote('claude'), 'claude')
  assert.equal(shellQuote('/Users/me/dir'), '/Users/me/dir')
  assert.equal(shellQuote('/Users/me/My Files'), `'/Users/me/My Files'`)
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
})

test('buildCommand quotes each token and joins', () => {
  assert.equal(
    buildCommand('claude', ['--model', 'opus', '--add-dir', '/a b']),
    `claude --model opus --add-dir '/a b'`,
  )
})

test('tmuxNewSessionArgs uses the private socket, -A, fixed size, command last', () => {
  const args = tmuxNewSessionArgs({ session: 'unmute-x', command: 'claude --chrome', confPath: '/c.conf', cols: 120, rows: 40 })
  assert.deepEqual(args, [
    '-L', TMUX_SOCKET, '-f', '/c.conf', 'new-session', '-A',
    '-s', 'unmute-x', '-x', '120', '-y', '40', 'claude --chrome',
  ])
})

test('attach + kill target the same session on the private socket', () => {
  assert.deepEqual(tmuxAttachArgs('unmute-x'), ['-L', TMUX_SOCKET, 'attach-session', '-t', 'unmute-x'])
  assert.deepEqual(tmuxKillSessionArgs('unmute-x'), ['-L', TMUX_SOCKET, 'kill-session', '-t', 'unmute-x'])
})

test('resolveTmuxBin returns first existing candidate, else null', () => {
  const exists = (p: string) => p === '/usr/local/bin/tmux'
  assert.equal(resolveTmuxBin(exists), '/usr/local/bin/tmux')
  assert.equal(resolveTmuxBin(() => false), null)
})

test('tmuxCapturePaneArgs dumps the current screen with colors + recent history', () => {
  const args = tmuxCapturePaneArgs('unmute-abc')
  assert.deepEqual(args, ['-L', 'unmute-remote', 'capture-pane', '-t', 'unmute-abc', '-ep', '-S', '-1000'])
})
