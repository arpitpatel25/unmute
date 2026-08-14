// The two composer read-backs are the gates every Codex Desktop delivery must
// pass. Both were measured wrong against the live app: `textContent` silently
// drops ProseMirror's block boundaries, so every multi-line dictation failed
// its equality check, and the attachment counter counted the tray's scroll
// wrapper rather than the attachments, so it read 1 no matter how many images
// were staged. These tests run the SHIPPED expressions against a DOM shaped
// like Codex's own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPOSER_TEXT_JS, COMPOSER_ATTACHMENT_COUNT_JS } from './cdp'

type FakeEl = {
  tagName: string
  children: FakeEl[]
  textContent: string
  querySelector: (selector: string) => unknown
  querySelectorAll: (selector: string) => unknown[]
}

const el = (tagName: string, textContent: string, opts: { trailingBreak?: boolean } = {}): FakeEl => ({
  tagName,
  textContent,
  children: [],
  querySelector: (selector) =>
    selector === 'br.ProseMirror-trailingBreak' && opts.trailingBreak ? {} : null,
  querySelectorAll: () => [],
})

const composer = (blocks: FakeEl[]): FakeEl => ({
  tagName: 'DIV',
  children: blocks,
  // ProseMirror concatenates block text with NO separator — this is the exact
  // behaviour that made the old read-back lie.
  textContent: blocks.map((b) => b.textContent).join(''),
  querySelector: () => null,
  querySelectorAll: () => [],
})

const runComposerText = (root: FakeEl | null): string =>
  new Function('document', `return ${COMPOSER_TEXT_JS}`)({
    querySelector: () => root,
  }) as string

const runAttachmentCount = (tray: FakeEl | null): number =>
  new Function('document', `return ${COMPOSER_ATTACHMENT_COUNT_JS}`)({
    querySelector: () => tray,
  }) as number

test('composer read-back restores the newline between two ProseMirror paragraphs', () => {
  const dom = composer([
    el('P', 'First point about the bug.'),
    el('P', '', { trailingBreak: true }),
    el('P', 'Second point about the fix.'),
  ])

  assert.equal(
    runComposerText(dom),
    'First point about the bug.\n\nSecond point about the fix.',
  )
})

test('composer read-back restores a single newline between consecutive lines', () => {
  const dom = composer([el('P', 'Line one of the reply.'), el('P', 'Line two of the reply.')])

  assert.equal(runComposerText(dom), 'Line one of the reply.\nLine two of the reply.')
})

test('composer read-back leaves a single-line message untouched', () => {
  assert.equal(runComposerText(composer([el('P', 'Please refactor the auth module.')])), 'Please refactor the auth module.')
})

test('composer read-back is empty when Codex has no composer mounted', () => {
  assert.equal(runComposerText(null), '')
})

test('attachment count reports every staged image, not the tray wrapper', () => {
  // Codex nests the previews under one scrolling wrapper, so the tray has a
  // single child whatever the image count is.
  const tray: FakeEl = {
    tagName: 'DIV',
    children: [el('DIV', '')],
    textContent: '',
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'img' ? [{}, {}] : []),
  }

  assert.equal(runAttachmentCount(tray), 2)
})

test('attachment count is zero when no tray is mounted', () => {
  assert.equal(runAttachmentCount(null), 0)
})
