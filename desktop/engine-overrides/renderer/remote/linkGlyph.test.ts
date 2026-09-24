import test from 'node:test'
import assert from 'node:assert/strict'
import { linkKind, localPath } from './linkGlyph'

// The classifier's whole value is that it never consults a brand table, so the
// cases that matter most are the ones a brand table would get wrong.

test('schemes are recognised case-insensitively', () => {
  assert.equal(linkKind('mailto:a@b.com'), 'mail')
  assert.equal(linkKind('MAILTO:A@B.COM'), 'mail')
  assert.equal(linkKind('tel:+15551234'), 'phone')
  assert.equal(linkKind('sms:+15551234'), 'phone')
})

test('every web host is equal — a household name and an unknown one', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=iYlODtkyw_I',
    'https://github.com/apple/swift-markdown',
    'http://some-obscure-thing.example.co.uk/x',
  ]) {
    assert.equal(linkKind(url), 'web', url)
  }
})

test('a remote .png is still a web link — scheme is checked before extension', () => {
  assert.equal(linkKind('https://example.com/a.png'), 'web')
})

test('local paths, by shape', () => {
  assert.equal(linkKind('/Users/x/notes.txt'), 'file')
  assert.equal(linkKind('/Users/x/shot.PNG'), 'image')
  assert.equal(linkKind('/not/on/this/mac/'), 'folder')
  assert.equal(linkKind('~/.codex/sessions'), 'file') // see the note on stat below
})

test('file:// urls, including percent-encoding', () => {
  assert.equal(linkKind('file:///Users/x/notes.txt'), 'file')
  assert.equal(linkKind('file:///Users/a%20b/c.png'), 'image')
  assert.equal(localPath('file:///Users/a%20b/c.png'), '/Users/a b/c.png')
})

test('Unmute task links are session links', () => {
  assert.equal(linkKind('unmute://task/abc123'), 'session')
})

test('degenerate input falls through to web rather than throwing', () => {
  assert.equal(linkKind(''), 'web')
  assert.equal(linkKind('   '), 'web')
  // Relative paths are not resolvable from a renderer, so they are not guessed
  // at against the wrong working directory.
  assert.equal(linkKind('docs/readme.md'), 'web')
  assert.equal(localPath('docs/readme.md'), null)
})

// THE ONE DELIBERATE DIVERGENCE from the Swift twin, pinned so it cannot drift
// silently into being an accident: the notch can `stat` and will call an
// extension-less local path a folder when it really is one. A renderer cannot,
// so it says `file`. Both refuse to guess from a brand.
test('extension-less local path: renderer says file, notch may say folder', () => {
  assert.equal(linkKind('/Users/x/sessions'), 'file')
})
