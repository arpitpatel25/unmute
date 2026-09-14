import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSchedule, formatSchedule, describeSchedule, nextFireAt, describeNext } from './schedule'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('parses every clock form and round-trips', () => {
  for (const [text, days] of [['daily 09:00', [0,1,2,3,4,5,6]], ['weekdays 09:00', [1,2,3,4,5]], ['weekends 10:30', [0,6]], ['mon,wed,fri 16:00', [1,3,5]], ['fridays 16:00', [5]]] as const) {
    const s = parseSchedule(text)
    assert.deepEqual(s.type === 'clock' && s.days, days)
    assert.deepEqual(parseSchedule(formatSchedule(s)), s)
  }
})
test('parses intervals with a 15 minute floor and events', () => {
  assert.deepEqual(parseSchedule('every 4 hours'), { type: 'interval', everyMs: 4 * 3_600_000 })
  assert.deepEqual(parseSchedule('every 30 minutes'), { type: 'interval', everyMs: 30 * 60_000 })
  assert.throws(() => parseSchedule('every 5 minutes'), /at least 15 minutes/)
  assert.deepEqual(parseSchedule('on meeting-notes-ready'), { type: 'event', event: 'meeting-notes-ready' })
  assert.throws(() => parseSchedule('whenever'), /schedule/)
  assert.throws(() => parseSchedule('daily 25:00'), /time/)
})
test('next weekday fire skips the weekend and is strictly after', () => {
  const s = parseSchedule('weekdays 09:00')
  assert.equal(nextFireAt(s, at(2026, 9, 11, 10)), at(2026, 9, 14, 9))  // Fri 10:00 → Mon 09:00
  assert.equal(nextFireAt(s, at(2026, 9, 14, 9)), at(2026, 9, 15, 9))   // exactly at fire → next day
  assert.equal(nextFireAt(s, at(2026, 9, 14, 8, 59)), at(2026, 9, 14, 9))
})
test('interval next is after + every, event has no next', () => {
  assert.equal(nextFireAt(parseSchedule('every 4 hours'), 1000), 1000 + 4 * 3_600_000)
  assert.equal(nextFireAt(parseSchedule('on meeting-notes-ready'), 1000), null)
})
test('describes schedules and next runs in words', () => {
  assert.equal(describeSchedule(parseSchedule('weekdays 09:00')), 'Weekdays at 09:00')
  assert.equal(describeSchedule(parseSchedule('mon,wed,fri 16:00')), 'Mon, Wed, Fri at 16:00')
  assert.equal(describeSchedule(parseSchedule('every 4 hours')), 'Every 4 hours')
  assert.equal(describeSchedule(parseSchedule('on meeting-notes-ready')), 'When meeting notes are ready')
  const now = at(2026, 9, 14, 8)
  assert.equal(describeNext(at(2026, 9, 14, 16), now), 'Today 16:00')
  assert.equal(describeNext(at(2026, 9, 15, 9), now), 'Tomorrow 09:00')
  assert.equal(describeNext(at(2026, 9, 18, 16), now), 'Fri 16:00')
  assert.equal(describeNext(null, now), 'After your next meeting')
})
