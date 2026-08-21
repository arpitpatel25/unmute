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
  gate.forward('hello')
  assert.deepEqual(sent, ['hello'], 'real input is forwarded after replay completes')
})
