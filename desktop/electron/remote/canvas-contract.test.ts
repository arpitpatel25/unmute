import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canvasContract, withCanvasContract, CANVAS_TOOLS } from './canvas-contract'

describe('canvasContract', () => {
  it('has an instruction for every tool the picker offers', () => {
    for (const tool of CANVAS_TOOLS) assert.ok(canvasContract(tool), `no contract for ${tool}`)
  })

  // NOTHING FIRES ON ITS OWN. An unarmed message must be delivered exactly as
  // the person said it — this is the whole guarantee of the feature.
  it('is null when no tool is armed', () => {
    assert.equal(canvasContract(undefined), null)
    assert.equal(canvasContract(''), null)
  })

  // An older host meeting a tool a newer surface armed should still send the
  // message, rather than failing the send outright.
  it('is null for an unknown tool rather than throwing', () => {
    assert.equal(canvasContract('hologram'), null)
  })

  it('tells every tool to answer in words first', () => {
    for (const tool of CANVAS_TOOLS) {
      assert.match(canvasContract(tool)!, /ANSWER IN WORDS FIRST/,
        `${tool} does not carry the listening rule`)
    }
  })

  // The sandbox is not advisory: a drawing that assumes a network or a white
  // background is a drawing that renders wrong or not at all.
  it('warns the drawing tools about the sandbox and the dark ground', () => {
    for (const tool of ['diagram', 'interactive']) {
      const text = canvasContract(tool)!
      assert.match(text, /No network/i)
      assert.match(text, /DARK background/i)
      assert.match(text, /resizable|any width/i)
    }
  })

  it('names the exact fence the extractor looks for', () => {
    assert.match(canvasContract('diagram')!, /```unmute-canvas svg/)
    assert.match(canvasContract('interactive')!, /```unmute-canvas html/)
  })

  it('tells the image tool the marker the extractor looks for', () => {
    assert.match(canvasContract('image')!, /unmute-image: \/absolute\/path/)
  })

  // A model cannot make an image and must not pretend otherwise.
  it('forbids inventing an image', () => {
    assert.match(canvasContract('image')!, /cannot generate one/i)
  })
})

describe('withCanvasContract', () => {
  it('returns the words untouched when nothing is armed', () => {
    assert.equal(withCanvasContract('what is the status?', undefined), 'what is the status?')
  })

  // ORDER IS NOT NEGOTIABLE: rules first, the request last, so the request is
  // the last thing read rather than context for a page of process.
  it('puts the contract before the words, separated by a rule', () => {
    const out = withCanvasContract('explain evaporation', 'diagram')
    assert.ok(out.endsWith('\n\n---\n\nexplain evaporation'))
    assert.ok(out.indexOf('ANSWER IN WORDS FIRST') < out.indexOf('explain evaporation'))
  })

  it('leaves the words alone for an unknown tool', () => {
    assert.equal(withCanvasContract('hello', 'hologram'), 'hello')
  })
})
