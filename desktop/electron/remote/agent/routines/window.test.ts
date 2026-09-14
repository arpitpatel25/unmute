import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWindow, formatWindow, computeWindow } from './window'
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const now = at(2026, 9, 15, 9)
const midnightYesterday = at(2026, 9, 14)

test('yesterday-or-last-run never shrinks below midnight yesterday', () => {
  assert.equal(computeWindow(parseWindow('yesterday-or-last-run'), now, at(2026, 9, 15, 8, 40))!.start, midnightYesterday)
})
test('yesterday-or-last-run reaches back after days off, capped at 7 days', () => {
  assert.equal(computeWindow({ type: 'yesterday-or-last-run' }, now, at(2026, 9, 11, 9))!.start, at(2026, 9, 11, 9))
  assert.equal(computeWindow({ type: 'yesterday-or-last-run' }, now, at(2026, 8, 1))!.start, now - 7 * 86_400_000)
  assert.equal(computeWindow({ type: 'yesterday-or-last-run' }, now, null)!.start, midnightYesterday)
})
test('since-last-run, today, last N, none', () => {
  assert.equal(computeWindow({ type: 'since-last-run' }, now, at(2026, 9, 15, 8, 40))!.start, at(2026, 9, 15, 8, 40))
  assert.equal(computeWindow({ type: 'today' }, now, null)!.start, at(2026, 9, 15))
  assert.equal(computeWindow(parseWindow('last 14 days'), now, null)!.start, now - 14 * 86_400_000)
  assert.equal(computeWindow(parseWindow('last 6 hours'), now, null)!.start, now - 6 * 3_600_000)
  assert.equal(computeWindow({ type: 'none' }, now, null), null)
  assert.throws(() => parseWindow('last 90 days'), /30 days/)
  assert.equal(formatWindow(parseWindow('last 14 days')), 'last 14 days')
})
test('label is human and end is now', () => {
  const w = computeWindow({ type: 'yesterday-or-last-run' }, now, null)!
  assert.equal(w.end, now)
  assert.match(w.label, /Mon 14 Sep 00:00 → Tue 15 Sep 09:00/)
})
