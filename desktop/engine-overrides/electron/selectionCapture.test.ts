import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureSelection,
  shouldUseClipboardFallback,
  type SelectionCaptureDeps,
} from './selectionCapture'

/** Every pasteboard effect, in the order it happened. The restore ordering is
 *  part of the contract, so the trace is asserted and not just the result. */
function recorder(
  overrides: Partial<SelectionCaptureDeps> & { initialClipboard?: string } = {},
) {
  const trace: string[] = []
  let slot = overrides.initialClipboard ?? ''
  const deps: SelectionCaptureDeps = {
    readClipboardText: () => slot,
    writeTextAndRecord: (t: string) => {
      slot = t
      trace.push(`write(${JSON.stringify(t)})+record`)
    },
    simulateCopy: async () => { trace.push('copy') },
    settle: async () => { trace.push('settle') },
    ...overrides,
  }
  return { deps, trace, slot: () => slot }
}

describe('captureSelection', () => {
  test('returns the selection when Cmd+C copies something', async () => {
    const { deps, trace } = recorder({
      initialClipboard: 'previous clipboard',
      simulateCopy: async () => { trace.push('copy') },
    })
    // The copy lands real text in the slot, as a live selection would.
    const withSelection: SelectionCaptureDeps = {
      ...deps,
      simulateCopy: async () => { deps.writeTextAndRecord('the selected words') },
    }

    const r = await captureSelection(withSelection, { useClipboardFallback: false })

    assert.equal(r.text, 'the selected words')
    assert.equal(r.source, 'selection')
  })

  // THE BUG. Nothing was selected, the clipboard holds real content, and the
  // caller asked for the fallback — this returned null because the fallback
  // lived only in the branch that runs when the copy THROWS.
  test('falls back to the clipboard when nothing was selected', async () => {
    const { deps } = recorder({ initialClipboard: 'the copied paragraph' })

    const r = await captureSelection(deps, { useClipboardFallback: true })

    assert.equal(r.text, 'the copied paragraph')
    assert.equal(r.source, 'clipboard')
  })

  test('returns nothing when no selection and the fallback is off', async () => {
    const { deps } = recorder({ initialClipboard: 'the copied paragraph' })

    const r = await captureSelection(deps, { useClipboardFallback: false })

    assert.equal(r.text, null)
    assert.equal(r.source, 'none')
  })

  test('falls back to the clipboard when the copy throws', async () => {
    const { deps } = recorder({
      initialClipboard: 'the copied paragraph',
      simulateCopy: async () => { throw new Error('Accessibility not granted') },
    })

    const r = await captureSelection(deps, { useClipboardFallback: true })

    assert.equal(r.text, 'the copied paragraph')
    assert.equal(r.source, 'clipboard')
  })

  // THE REGRESSION THE FALLBACK SHIPPED WITH.
  //
  // Unmute delivers a dictation by writing it to the pasteboard and pasting it,
  // so after every dictation the clipboard holds unmute's OWN last output. The
  // stand-in could not tell that from something the user deliberately copied, so
  // speaking to an agent attached the previous utterance to it — 12 times in one
  // afternoon in the field. The pasteboard being non-empty is not evidence of
  // user intent when we are the ones who filled it.
  test('refuses a clipboard that is only our own last delivery', async () => {
    const { deps } = recorder({ initialClipboard: 'the thing I dictated a moment ago' })

    const r = await captureSelection(deps, {
      useClipboardFallback: true,
      lastDelivered: 'the thing I dictated a moment ago',
    })

    assert.equal(r.text, null)
    assert.equal(r.source, 'none')
  })

  test('ignores surrounding whitespace when recognising our own delivery', async () => {
    const { deps } = recorder({ initialClipboard: '  my last dictation \n' })

    const r = await captureSelection(deps, {
      useClipboardFallback: true,
      lastDelivered: 'my last dictation',
    })

    assert.equal(r.source, 'none')
  })

  // …but a genuine copy still gets through, which is the whole point of the
  // stand-in. Losing this would re-open the bug it was written for.
  test('still uses a clipboard the user actually copied', async () => {
    const { deps } = recorder({ initialClipboard: 'a paragraph I copied from an article' })

    const r = await captureSelection(deps, {
      useClipboardFallback: true,
      lastDelivered: 'something else I dictated earlier',
    })

    assert.equal(r.text, 'a paragraph I copied from an article')
    assert.equal(r.source, 'clipboard')
  })

  test('an empty clipboard yields nothing even with the fallback on', async () => {
    const { deps } = recorder({ initialClipboard: '   ' })

    const r = await captureSelection(deps, { useClipboardFallback: true })

    assert.equal(r.text, null)
    assert.equal(r.source, 'none')
  })

  test('restores the original clipboard, pre-clearing before the copy', async () => {
    const { deps, trace, slot } = recorder({ initialClipboard: 'user content' })

    await captureSelection(deps, { useClipboardFallback: false })

    assert.deepEqual(trace, [
      'write("")+record',
      'copy',
      'settle',
      'write("user content")+record',
    ])
    assert.equal(slot(), 'user content')
  })

  test('restores the original clipboard even when the copy throws', async () => {
    const { deps, slot } = recorder({
      initialClipboard: 'user content',
      simulateCopy: async () => { throw new Error('boom') },
    })

    await captureSelection(deps, { useClipboardFallback: false })

    assert.equal(slot(), 'user content')
  })
})

describe('shouldUseClipboardFallback', () => {
  // Plain dictation pastes at a cursor. Standing the pasteboard in for an
  // absent selection would prepend it to EVERY utterance the user speaks with
  // something copied — the corruption the pre-clear exists to prevent.
  test('is off for plain dictation at a cursor', () => {
    assert.equal(shouldUseClipboardFallback('dictation', 'dictation'), false)
  })

  test('is on for an instruction, which is gathering context to act on', () => {
    assert.equal(shouldUseClipboardFallback('instruction', 'dictation'), true)
  })

  // A Remote capture reuses the dictation machinery wholesale and is started
  // with mode 'dictation' (startRemoteCapture → startSession('dictation',
  // 'remote')), so the mode alone cannot tell these apart. The kind can.
  test('is on for a Remote dispatch even though its mode says dictation', () => {
    assert.equal(shouldUseClipboardFallback('dictation', 'remote'), true)
  })
})
