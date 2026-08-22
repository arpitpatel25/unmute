import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectTerminalInputAfterReplay } from './terminal-replay-gate'

test('historical replay stays display-only, then live input is attached exactly once', () => {
  const sent: string[] = []
  const listeners = new Set<(data: string) => void>()
  const scheduled: Array<() => void> = []
  let writeDone: (() => void) | undefined
  const terminal = {
    write(_history: string, done?: () => void) {
      writeDone = done
    },
    onData(listener: (data: string) => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }

  let ready = false
  const session = connectTerminalInputAfterReplay(
    terminal,
    '\x1b[c',
    (data) => sent.push(data),
    () => { ready = true },
    (callback) => scheduled.push(callback),
  )

  assert.equal(listeners.size, 0, 'no input listener exists during replay')
  assert.equal(ready, false)

  writeDone?.()
  assert.equal(listeners.size, 0, 'write callback alone does not expose replay replies')
  scheduled.shift()?.()
  assert.equal(listeners.size, 1)
  assert.equal(ready, true)

  listeners.forEach((listener) => listener('hello'))
  listeners.forEach((listener) => listener('\x1b[?65;20;1c'))
  session.forward('\x1b\r')
  assert.deepEqual(sent, ['hello', '\x1b[?65;20;1c', '\x1b\r'], 'live input is forwarded verbatim once')

  session.dispose()
  assert.equal(listeners.size, 0)
})

test('empty history attaches once and disposal before activation cancels attachment', () => {
  const scheduled: Array<() => void> = []
  let attached = 0
  const terminal = {
    write() {},
    onData() {
      attached += 1
      return { dispose() {} }
    },
  }

  const session = connectTerminalInputAfterReplay(
    terminal,
    '',
    () => {},
    () => {},
    (callback) => scheduled.push(callback),
  )
  session.dispose()
  scheduled.shift()?.()
  assert.equal(attached, 0)
})
