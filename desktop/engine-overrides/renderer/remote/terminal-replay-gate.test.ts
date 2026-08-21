import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalInputGate, replayTerminalHistory } from './terminal-replay-gate'

test('terminal device replies generated while replaying history never reach the live PTY', () => {
  const sent: string[] = []
  const gate = createTerminalInputGate((data) => sent.push(data))
  let writeDone: (() => void) | undefined
  const terminal = {
    write(_history: string, done?: () => void) {
      gate.forward('\x1b[?65;20;1c')
      writeDone = done
    },
  }

  replayTerminalHistory(terminal, '\x1b[c', gate, () => {})
  assert.deepEqual(sent, [], 'xterm-generated replay responses stay local')

  writeDone?.()
  gate.forward('\x1b[?65;20;1c')
  gate.forward('\x1b[0n')
  gate.forward('\x1b[12;34R')
  gate.forward('\u009b?65;20;1c')
  gate.forward('\x1b')
  gate.forward('hello')
  assert.deepEqual(sent, ['\x1b', 'hello'], 'device replies stay local while real input is forwarded')
})
