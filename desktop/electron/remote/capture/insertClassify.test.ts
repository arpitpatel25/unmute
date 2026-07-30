import { test, describe } from 'node:test'
import assert from 'node:assert'
import { classifyText, LINE_MAX_CHARS } from './insertClassify'

const noFs = () => false
const anyPathExists = () => true

describe('urls', () => {
  test('https', () => assert.equal(classifyText('https://slack.com/x', noFs), 'url'))
  test('http', () => assert.equal(classifyText('http://example.com', noFs), 'url'))
  test('with a query string and fragment', () => {
    assert.equal(classifyText('https://a.com/b?c=d&e=f#g', noFs), 'url')
  })
  test('surrounding whitespace is tolerated', () => {
    assert.equal(classifyText('  https://a.com  ', noFs), 'url')
  })
  test('a bare domain is NOT a url — it is an ordinary line', () => {
    assert.equal(classifyText('example.com', noFs), 'line')
  })
  test('a url with a newline after it is a block, not a url', () => {
    assert.equal(classifyText('https://a.com\nand more', noFs), 'block')
  })
})

describe('paths', () => {
  test('absolute path that exists', () => {
    assert.equal(classifyText('/Users/me/notes.md', anyPathExists), 'path')
  })
  test('tilde path that exists', () => {
    assert.equal(classifyText('~/notes.md', anyPathExists), 'path')
  })
  test('a path with spaces that exists', () => {
    assert.equal(classifyText('/Users/me/my notes.md', anyPathExists), 'path')
  })
  test('absolute-looking but NOT on disk falls through to line', () => {
    assert.equal(classifyText('/not/real', noFs), 'line')
  })
  test('a relative path is never a path', () => {
    assert.equal(classifyText('src/index.ts', anyPathExists), 'line')
  })
})

describe('lines vs blocks', () => {
  test('short single line', () => {
    assert.equal(classifyText('fix the login bug', noFs), 'line')
  })
  test('exactly at the limit is still a line', () => {
    assert.equal(classifyText('a'.repeat(LINE_MAX_CHARS), noFs), 'line')
  })
  test('one over the limit becomes a block', () => {
    assert.equal(classifyText('a'.repeat(LINE_MAX_CHARS + 1), noFs), 'block')
  })
  test('any newline makes it a block, however short', () => {
    assert.equal(classifyText('a\nb', noFs), 'block')
  })
  test('a carriage return counts as a newline', () => {
    assert.equal(classifyText('a\r\nb', noFs), 'block')
  })
  test('a stack trace is a block', () => {
    assert.equal(classifyText('Traceback:\n  File "a.py"\nValueError', noFs), 'block')
  })
})

describe('the default is the cheap failure', () => {
  test('empty string is a block, never inlined', () => {
    assert.equal(classifyText('', noFs), 'block')
  })
  test('whitespace only is a block', () => {
    assert.equal(classifyText('   \n  ', noFs), 'block')
  })
})
