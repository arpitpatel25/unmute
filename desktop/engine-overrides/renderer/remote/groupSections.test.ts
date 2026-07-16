import { test, describe } from 'node:test'
import assert from 'node:assert'
import { groupSections } from './groupSections'

const t = (id: string, group: string | null, updatedAt: number) => ({ id, group, updatedAt })

describe('groupSections', () => {
  test('no groups anywhere → single unnamed section, order untouched (wall unchanged)', () => {
    const tasks = [t('a', null, 3), t('b', null, 2), t('c', null, 1)]
    const s = groupSections(tasks)
    assert.equal(s.length, 1)
    assert.equal(s[0].name, null)
    assert.deepEqual(s[0].tasks.map((x) => x.id), ['a', 'b', 'c'])
  })

  test('named sections order by most-recent member; ungrouped last', () => {
    const tasks = [t('n1', 'on-call', 10), t('u1', null, 9), t('v1', 'video', 8), t('n2', 'on-call', 2), t('v2', 'video', 7)]
    const s = groupSections(tasks)
    assert.deepEqual(s.map((x) => x.name), ['on-call', 'video', null])
    assert.deepEqual(s[0].tasks.map((x) => x.id), ['n1', 'n2'])   // input order preserved
    assert.deepEqual(s[1].tasks.map((x) => x.id), ['v1', 'v2'])
    assert.deepEqual(s[2].tasks.map((x) => x.id), ['u1'])
  })

  test('input order (newest-first) preserved within a section', () => {
    const tasks = [t('new', 'g', 5), t('old', 'g', 1)]
    assert.deepEqual(groupSections(tasks)[0].tasks.map((x) => x.id), ['new', 'old'])
  })

  test('whitespace/empty group values count as ungrouped', () => {
    const tasks = [t('a', '  ', 2), t('b', 'real', 1)]
    const s = groupSections(tasks)
    assert.deepEqual(s.map((x) => x.name), ['real', null])
  })

  test('empty input → empty output', () => {
    assert.deepEqual(groupSections([]), [])
  })
})
