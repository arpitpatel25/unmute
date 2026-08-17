import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ptyTapLine, decodeTapLine } from './pty-tap'

describe('ptyTapLine', () => {
  // The whole point of the tap: the general logger truncates any string over
  // 2000 chars, which is exactly why three separate theories about why a CLI
  // session dies could not be settled. A tap that truncates is not a tap.
  test('carries a payload far past the logger 2000-char ceiling intact', () => {
    const big = 'x'.repeat(9000)
    const round = decodeTapLine(ptyTapLine('out', Buffer.from(big), 1000))
    assert.equal(round.bytes.toString(), big)
    assert.equal(round.bytes.length, 9000)
  })

  test('records direction, so a reply is distinguishable from a keystroke', () => {
    assert.equal(decodeTapLine(ptyTapLine('in', Buffer.from('a'), 1)).dir, 'in')
    assert.equal(decodeTapLine(ptyTapLine('out', Buffer.from('a'), 1)).dir, 'out')
  })

  test('keeps the timestamp, so bytes can be aligned against the event log', () => {
    assert.equal(decodeTapLine(ptyTapLine('in', Buffer.from('a'), 1786946219493)).atMs, 1786946219493)
  })

  // Control bytes are the entire subject — Ctrl-D, Ctrl-C, escape sequences.
  // A tap that mangles them into replacement characters answers nothing.
  test('preserves raw control bytes exactly', () => {
    const raw = Buffer.from([0x1b, 0x5b, 0x41, 0x04, 0x03, 0x00, 0xff])
    assert.deepEqual(decodeTapLine(ptyTapLine('in', raw, 1)).bytes, raw)
  })

  test('emits one line with no embedded newline, so the file stays JSONL', () => {
    const line = ptyTapLine('out', Buffer.from('a\nb\r\nc'), 1)
    assert.equal(line.split('\n').length, 1)
  })
})
