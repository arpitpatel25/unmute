import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { draftInput } from './task-input'
import type { TaskDraft } from './task-draft'

const draft = (over: Partial<TaskDraft> = {}): TaskDraft =>
  ({ text: 'give me image of try cua driver logo', attachments: [], ...over })

const flat = (parts: Awaited<ReturnType<typeof draftInput>>): string =>
  parts.flatMap((p) => p.type === 'text' ? [p.text] : []).join('')

describe('draftInput carries an armed tool into the PARTS', () => {
  // THE BUG THIS PINS, and it is worth stating plainly because the logs lied
  // about it. The contract was applied to the flat `text` string only, while
  // the structured transports consume the parts array — so delivery logged
  // 1173 characters, reported success, and the agent's own transcript recorded
  // the user's 36. Everything looked correct from the outside.
  it('puts the contract in a part, not only in the joined string', async () => {
    const parts = await draftInput(draft({ tool: 'image' }))
    assert.ok(parts.length >= 2, 'the contract should be its own leading part')
    assert.equal(parts[0].type, 'text')
    assert.match((parts[0] as { text: string }).text, /ANSWER IN WORDS FIRST/)
  })

  it('keeps the person’s words last, after the separator', async () => {
    const text = flat(await draftInput(draft({ tool: 'diagram' })))
    assert.ok(text.endsWith('\n\n---\n\ngive me image of try cua driver logo'))
  })

  // The two representations are handed to different transports; if they ever
  // disagree, one lane silently sends something else.
  it('makes the flat text and the parts agree', async () => {
    const parts = await draftInput(draft({ tool: 'diagram' }))
    assert.equal(flat(parts).includes('ANSWER IN WORDS FIRST'), true)
  })

  it('adds nothing at all when no tool is armed', async () => {
    const parts = await draftInput(draft())
    assert.equal(flat(parts), 'give me image of try cua driver logo')
    assert.equal(parts.length, 1)
  })

  it('adds nothing for a tool it does not recognise', async () => {
    const parts = await draftInput(draft({ tool: 'hologram' }))
    assert.equal(flat(parts), 'give me image of try cua driver logo')
  })

  it('prefixes once, not once per attachment', async () => {
    const parts = await draftInput(draft({
      tool: 'diagram',
      attachments: [
        { id: 'a', path: '/tmp/a.png', mimeType: 'image/png', name: 'a.png', offset: 0 },
        { id: 'b', path: '/tmp/b.png', mimeType: 'image/png', name: 'b.png', offset: 4 },
      ],
    }))
    const contracts = parts.filter((p) => p.type === 'text' && p.text.includes('ANSWER IN WORDS FIRST'))
    assert.equal(contracts.length, 1)
  })
})
