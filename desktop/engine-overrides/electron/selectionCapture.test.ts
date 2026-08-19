import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureSelection,
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
    const { deps, trace } = recorder({ initialClipboard: 'previous clipboard' })
    const withSelection: SelectionCaptureDeps = {
      ...deps,
      simulateCopy: async () => { deps.writeTextAndRecord('the selected words') },
    }

    const r = await captureSelection(withSelection)

    assert.deepEqual(r, { text: 'the selected words', source: 'selection' })
    assert.equal(trace.at(-1), 'write("previous clipboard")+record', 'the slot is handed back')
  })

  // THE 19 AUGUST CORRUPTION. A dictation leaves its own transcript on the
  // pasteboard. The next capture used to stand that in for an absent selection,
  // so the previous utterance was silently prepended to the next one — in one
  // case to an Agent request, which acted on it and dispatched a task the user
  // never asked for.
  test('a pasteboard from before the capture is never used, whoever filled it', async () => {
    for (const clipboard of [
      'the thing I dictated a moment ago',
      'a github link I copied an hour ago',
      '   surrounded by whitespace   ',
    ]) {
      const { deps } = recorder({ initialClipboard: clipboard })

      const r = await captureSelection(deps)

      assert.deepEqual(r, { text: null, source: 'none' }, JSON.stringify(clipboard))
    }
  })

  test('a copy that throws is indistinguishable from an empty selection', async () => {
    const { deps } = recorder({
      initialClipboard: 'something copied earlier',
      simulateCopy: async () => { throw new Error('accessibility not granted') },
    })

    assert.deepEqual(await captureSelection(deps), { text: null, source: 'none' })
  })

  test('an empty pasteboard yields nothing', async () => {
    const { deps } = recorder({ initialClipboard: '' })

    assert.deepEqual(await captureSelection(deps), { text: null, source: 'none' })
  })

  // The clear is a BORROW, not a wipe: it exists so anything read after the
  // copy can only have come from the copy. What was there goes back on every
  // path, because the pasteboard belongs to the user.
  test('clears before the copy and restores afterwards, in order', async () => {
    const { deps, trace, slot } = recorder({ initialClipboard: 'user material' })

    await captureSelection(deps)

    assert.deepEqual(trace, [
      'write("")+record',
      'copy',
      'settle',
      'write("user material")+record',
    ])
    assert.equal(slot(), 'user material')
  })

  test('restores the pasteboard even when the copy throws', async () => {
    const { deps, slot } = recorder({
      initialClipboard: 'user material',
      simulateCopy: async () => { throw new Error('helper died') },
    })

    await captureSelection(deps)

    assert.equal(slot(), 'user material', 'a thrown copy must not eat the pasteboard')
  })

  test('a selection wins even when the pasteboard also holds something', async () => {
    const { deps } = recorder({ initialClipboard: 'stale clipboard text' })
    const withSelection: SelectionCaptureDeps = {
      ...deps,
      simulateCopy: async () => { deps.writeTextAndRecord('what is highlighted now') },
    }

    assert.deepEqual(await captureSelection(withSelection), {
      text: 'what is highlighted now', source: 'selection',
    })
  })
})
