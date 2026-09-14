import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDefinition, serializeDefinition, definitionFromFields, slugify } from './definition'

const EXAMPLE = `---\nname: Morning recap\nschedule: weekdays 09:00\nwindow: yesterday-or-last-run\nkind: read-only\nprovider: agent\ninputs: sessions\nwhen-empty: note\nmax-minutes: 8\nspeak: false\n---\nTell me what I worked on.\n`

test('parses the spec example', () => {
  const d = parseDefinition('morning-recap', EXAMPLE)
  assert.equal(d.name, 'Morning recap'); assert.equal(d.maxMinutes, 8); assert.deepEqual(d.inputs, ['sessions'])
  assert.equal(d.prompt, 'Tell me what I worked on.')
  assert.deepEqual(parseDefinition('morning-recap', serializeDefinition(d)), d)
})

test('defaults differ for events', () => {
  const d = definitionFromFields('notes', { name: 'Action items', schedule: 'on meeting-notes-ready', prompt: 'List action items.' })
  assert.equal(d.window.type, 'none'); assert.equal(d.kind, 'read-only'); assert.equal(d.maxMinutes, 10); assert.equal(d.speak, false)
})

test('defaults for clock and interval schedules', () => {
  const clock = definitionFromFields('c', { name: 'Clock', schedule: 'daily 09:00', prompt: 'p' })
  assert.equal(clock.window.type, 'yesterday-or-last-run')
  assert.equal(clock.provider, 'agent')
  assert.equal(clock.whenEmpty, 'note')
  const interval = definitionFromFields('i', { name: 'Interval', schedule: 'every 4 hours', prompt: 'p' })
  assert.equal(interval.window.type, 'yesterday-or-last-run')
})

test('rejects what the spec rejects', () => {
  assert.throws(() => parseDefinition('x', EXAMPLE.replace('speak: false', 'colour: red')), /Unknown key "colour"/)
  assert.throws(() => definitionFromFields('x', { name: 'a', schedule: 'daily 09:00', prompt: ' ' }), /prompt/)
  assert.throws(() => definitionFromFields('x', { name: 'a', schedule: 'daily 09:00', prompt: 'p', kind: 'takes-actions', provider: 'codex' }), /Claude/)
  assert.throws(() => definitionFromFields('x', { name: 'a', schedule: 'daily 09:00', prompt: 'p', maxMinutes: 45 }), /1 and 30/)
  assert.throws(() => parseDefinition('x', EXAMPLE.replace('inputs: sessions', 'inputs: sessions, bogus')), /bogus/)
})

test('missing name throws', () => {
  assert.throws(() => parseDefinition('x', EXAMPLE.replace('name: Morning recap\n', '')), /name/)
  assert.throws(() => definitionFromFields('x', { name: '', schedule: 'daily 09:00', prompt: 'p' } as any), /name/)
})

test('empty prompt body throws', () => {
  assert.throws(() => parseDefinition('x', EXAMPLE.replace('Tell me what I worked on.\n', '')), /prompt/)
})

test('takes-actions with provider agent or claude is allowed', () => {
  const d = definitionFromFields('x', { name: 'a', schedule: 'daily 09:00', prompt: 'p', kind: 'takes-actions', provider: 'claude' })
  assert.equal(d.provider, 'claude')
  const d2 = definitionFromFields('y', { name: 'a', schedule: 'daily 09:00', prompt: 'p', kind: 'takes-actions' })
  assert.equal(d2.provider, 'agent')
})

test('slugs are unique and never empty', () => {
  assert.equal(slugify('Morning recap!', new Set(['morning-recap'])), 'morning-recap-2')
  assert.equal(slugify('日本', new Set()), 'routine')
})
