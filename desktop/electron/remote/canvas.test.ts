import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractCanvases, extractImages, liftCanvases, CANVAS_MAX_CHARS } from './canvas'
import { canvasContract, CONTRACT_SENTINEL } from './canvas-contract'
import type { Block } from './blocks'

const say = (text: string): Block => ({ kind: 'message', role: 'assistant', text })
const asked = (text: string): Block => ({ kind: 'message', role: 'user', text })

describe('extractCanvases', () => {
  it('leaves ordinary prose completely alone', () => {
    const { text, found } = extractCanvases('Water evaporates because\n\nfast molecules escape.')
    assert.equal(text, 'Water evaporates because\n\nfast molecules escape.')
    assert.deepEqual(found, [])
  })

  it('lifts a fence out and keeps the prose', () => {
    const { text, found } = extractCanvases(
      'Here is how it works.\n\n```unmute-canvas svg\n<svg/>\n```\n\nThat is the whole story.')
    assert.equal(text, 'Here is how it works.\n\nThat is the whole story.')
    assert.equal(found.length, 1)
    assert.equal(found[0].format, 'svg')
    assert.equal(found[0].source, '<svg/>')
  })

  // THE FENCE IS OURS, NOT THE LANGUAGE. A conversation *about* SVG must still
  // be able to show SVG source as source.
  it('ignores a plain ```svg block', () => {
    const body = 'You write it like this:\n\n```svg\n<svg/>\n```'
    const { text, found } = extractCanvases(body)
    assert.equal(text, body)
    assert.deepEqual(found, [])
  })

  // Vendoring 3.4MB of renderer for one format was not worth it; the fence
  // degrades to readable source instead of a blank card.
  it('leaves a mermaid fence in the prose, since nothing renders it', () => {
    const body = 'Look:\n```unmute-canvas mermaid\ngraph TD; A-->B\n```'
    const { text, found } = extractCanvases(body)
    assert.equal(text, body)
    assert.deepEqual(found, [])
  })

  // A canvas can legitimately contain a fence — an HTML page showing a code
  // sample — so the scan must stop at the FIRST close, not the last.
  it('handles two canvases without swallowing the prose between them', () => {
    const { text, found } = extractCanvases(
      'First:\n```unmute-canvas svg\n<svg/>\n```\nThen:\n```unmute-canvas html\n<b>hi</b>\n```\nDone.')
    assert.equal(text, 'First:\nThen:\nDone.')
    assert.equal(found.length, 2)
    assert.deepEqual(found.map((f) => f.format), ['svg', 'html'])
  })

  // Truncated mid-write. Rendering half a drawing, or eating the rest of the
  // message looking for a close that never comes, are both worse than showing
  // the source.
  it('leaves an unclosed fence in the prose', () => {
    const body = 'Here:\n```unmute-canvas svg\n<svg/>'
    const { text, found } = extractCanvases(body)
    assert.equal(text, body)
    assert.deepEqual(found, [])
  })

  // An old build meeting a format a newer one emits shows the source rather
  // than nothing.
  it('leaves an unknown format in the prose', () => {
    const body = 'Look:\n```unmute-canvas hologram\nx\n```'
    const { text, found } = extractCanvases(body)
    assert.equal(text, body)
    assert.deepEqual(found, [])
  })

  it('refuses a canvas over the size cap, and says so rather than dropping it', () => {
    const { found } = extractCanvases(
      '```unmute-canvas svg\n' + 'x'.repeat(CANVAS_MAX_CHARS + 1) + '\n```')
    assert.equal(found.length, 1)
    assert.equal(found[0].tooLarge, true)
  })

  it('does not leave a hole where the fence was', () => {
    const { text } = extractCanvases('Before.\n\n```unmute-canvas svg\n<svg/>\n```\n\nAfter.')
    assert.equal(text, 'Before.\n\nAfter.')
  })
})

describe('extractImages', () => {
  it('lifts the path out and keeps the prose', () => {
    const { text, paths } = extractImages(
      'This is what a red panda looks like.\n\nunmute-image: /tmp/panda.jpg\n\nThey are not pandas.')
    assert.equal(text, 'This is what a red panda looks like.\n\nThey are not pandas.')
    assert.deepEqual(paths, ['/tmp/panda.jpg'])
  })

  // A relative path has no meaning at the surface — there is no working
  // directory to resolve it against.
  it('ignores a relative path', () => {
    const body = 'unmute-image: ./panda.jpg'
    assert.deepEqual(extractImages(body), { text: body, paths: [] })
  })

  // Far more likely to be the model TALKING about the feature than using it.
  it('ignores a line that is not an image file', () => {
    const body = 'unmute-image: /tmp/notes.txt'
    assert.deepEqual(extractImages(body), { text: body, paths: [] })
  })

  it('leaves prose that merely mentions the marker alone', () => {
    const body = 'You write unmute-image: followed by a path.'
    assert.deepEqual(extractImages(body), { text: body, paths: [] })
  })

  it('takes every image when there are several', () => {
    const { paths } = extractImages('unmute-image: /a/one.png\nunmute-image: /b/two.webp')
    assert.deepEqual(paths, ['/a/one.png', '/b/two.webp'])
  })
})

describe('liftCanvases', () => {
  it('is a pure pass-through when nothing draws', () => {
    const blocks = [asked('hi'), say('hello')]
    assert.deepEqual(liftCanvases(blocks), blocks)
  })

  // THE POINT OF THE WHOLE MODULE: words first, picture last.
  it('moves the canvas to the end of the turn, after later prose', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('Here it is.\n```unmute-canvas svg\n<svg id="d"/>\n```'),
      say('And one more thing.'),
      { kind: 'turnEnd' },
    ])
    assert.deepEqual(out.map((b) => b.kind), ['turnStart', 'message', 'message', 'canvas', 'turnEnd'])
    assert.equal((out[1] as { text: string }).text, 'Here it is.')
    assert.equal((out[3] as { source: string }).source, '<svg id="d"/>')
  })

  it('leaves no empty bubble when the message was only a canvas', () => {
    const out = liftCanvases([say('```unmute-canvas svg\n<svg/>\n```')])
    assert.deepEqual(out.map((b) => b.kind), ['canvas'])
  })

  // A turn that draws six pictures has not answered the question, and the
  // surface is a notch panel rather than a gallery.
  it('shows one canvas per turn and drops the rest', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('```unmute-canvas svg\n<svg id="a"/>\n```\n```unmute-canvas svg\n<svg id="b"/>\n```'),
      { kind: 'turnEnd' },
    ])
    assert.equal(out.filter((b) => b.kind === 'canvas').length, 1)
    assert.match((out.find((b) => b.kind === 'canvas') as { source: string }).source, /id="a"/)
  })

  // MEASURED ON A REAL TASK. Claude's frame stream carried the final reply
  // twice — a proper assistant message and a shapeless duplicate with no uuid —
  // with a turnEnd between them, so the per-turn cap reset and the water cycle
  // drew twice, one card under the other.
  it('draws the same source once even across a turn boundary', () => {
    const svg = '<svg viewBox="0 0 800 400"/>'
    const body = `Here it is.\n\`\`\`unmute-canvas svg\n${svg}\n\`\`\``
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say(body),
      { kind: 'turnEnd' },
      { kind: 'turnStart', startedAt: 1 },
      say(body),
      { kind: 'turnEnd' },
    ])
    assert.equal(out.filter((b) => b.kind === 'canvas').length, 1)
  })

  it('still draws a genuinely different diagram in a later turn', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('```unmute-canvas svg\n<svg id="first"/>\n```'),
      { kind: 'turnEnd' },
      { kind: 'turnStart', startedAt: 1 },
      say('```unmute-canvas svg\n<svg id="second"/>\n```'),
      { kind: 'turnEnd' },
    ])
    assert.equal(out.filter((b) => b.kind === 'canvas').length, 2)
  })

  it('attaches the same fetched image once, however often it is repeated', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('unmute-image: /tmp/logo.png'),
      { kind: 'turnEnd' },
      { kind: 'turnStart', startedAt: 1 },
      say('unmute-image: /tmp/logo.png'),
      { kind: 'turnEnd' },
    ])
    assert.equal(out.filter((b) => b.kind === 'attachment').length, 1)
  })

  it('gives each turn its own allowance', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('```unmute-canvas svg\n<svg id="a"/>\n```'),
      { kind: 'turnEnd' },
      { kind: 'turnStart', startedAt: 1 },
      say('```unmute-canvas svg\n<svg id="b"/>\n```'),
      { kind: 'turnEnd' },
    ])
    assert.equal(out.filter((b) => b.kind === 'canvas').length, 2)
  })

  // The user's own words are never rewritten — someone pasting a fence into
  // the composer is quoting, not drawing.
  it('never draws from a user message', () => {
    const body = '```unmute-canvas svg\n<svg/>\n```'
    const out = liftCanvases([asked(body)])
    assert.equal((out[0] as { text: string }).text, body)
    assert.equal(out.length, 1)
  })

  // The contract rides inside the user's turn, so the transcript records it as
  // something they said. Rendered raw it is a wall of rules in their own
  // bubble, above the answer — which is exactly what shipped in dev.19.
  it('takes the contract back off the person’s own message', () => {
    const contract = canvasContract('diagram')!
    const out = liftCanvases([asked(`${contract}\n\n---\n\nexplain the water cycle`)])
    assert.equal((out[0] as { text: string }).text, 'explain the water cycle')
  })

  it('leaves a message that merely quotes the sentinel alone', () => {
    const body = `I saw "${CONTRACT_SENTINEL}" in the logs — what is that?`
    const out = liftCanvases([asked(body)])
    assert.equal((out[0] as { text: string }).text, body)
  })

  // Someone writing --- in their own message must not lose the front of it.
  it('does not cut at a separator the person wrote themselves', () => {
    const body = 'first\n\n---\n\nsecond'
    const out = liftCanvases([asked(body)])
    assert.equal((out[0] as { text: string }).text, body)
  })

  // A picture the agent fetched is not part of your prompt, so it must not
  // render above the reply the way an attachment you pasted does.
  it('marks a fetched image as the assistant’s and puts it after the words', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('Here is what one looks like.\nunmute-image: /tmp/panda.jpg'),
      { kind: 'turnEnd' },
    ])
    assert.deepEqual(out.map((b) => b.kind), ['turnStart', 'message', 'attachment', 'turnEnd'])
    const image = out[2] as { role?: string; mimeType: string; name: string }
    assert.equal(image.role, 'assistant')
    assert.equal(image.mimeType, 'image/jpeg')
    assert.equal(image.name, 'panda.jpg')
  })

  it('still places the canvas when the turn has no end marker yet', () => {
    const out = liftCanvases([
      { kind: 'turnStart', startedAt: 0 },
      say('Working on it.\n```unmute-canvas svg\n<svg/>\n```'),
    ])
    assert.deepEqual(out.map((b) => b.kind), ['turnStart', 'message', 'canvas'])
  })
})
