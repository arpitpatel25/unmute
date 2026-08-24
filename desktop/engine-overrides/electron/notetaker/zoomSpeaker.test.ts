import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { pollZoomSpeaker, type NativeAxLike } from './zoomSpeaker'

function fakeAx(nodes: Array<{ id: number; role: string; label: string; actions: string[] }>): NativeAxLike {
  return {
    find: () => ({ app: 'zoom.us', nodes, total: nodes.length }),
  }
}

describe('pollZoomSpeaker', () => {
  test('finds a name adjacent to a common speaking-state hint', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'Sarah Chen is speaking', actions: [] },
      { id: 2, role: 'AXStaticText', label: 'Participants (4)', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, 'Sarah Chen')
    assert.equal(result.candidateCount, 1)
  })

  test('handles a parenthesized hint', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'John Park (active speaker)', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, 'John Park')
  })

  test('no matching nodes returns null speakerName, zero candidates', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXButton', label: 'Mute', actions: ['AXPress'] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, null)
    assert.equal(result.candidateCount, 0)
  })

  test('empty node list returns null, does not throw', () => {
    const result = pollZoomSpeaker(fakeAx([]))
    assert.equal(result.speakerName, null)
    assert.equal(result.candidateCount, 0)
  })

  test('an ax.find() error result returns null, does not throw', () => {
    const ax: NativeAxLike = { find: () => ({ app: 'zoom.us', nodes: [], total: 0, error: 'app not running' }) }
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, null)
  })

  test('every matching node is captured in rawCandidates, even though only the first is used as speakerName', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'Sarah Chen is speaking', actions: [] },
      { id: 2, role: 'AXStaticText', label: 'John Park is speaking', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.candidateCount, 2)
    assert.equal(result.rawCandidates.length, 2)
    assert.equal(result.speakerName, 'Sarah Chen') // first match wins, deterministic
  })

  test('a hint with no recoverable name (empty after stripping) returns null, not an empty string', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXStaticText', label: 'is speaking', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.speakerName, null)
  })

  // Diagnostics — added after a whole-plan review found that rawCandidates
  // alone (only nodes matching the heuristic) is useless for diagnosing
  // exactly the case it exists for: a wrong heuristic, where every poll
  // would otherwise look identically empty regardless of whether Zoom
  // wasn't running, resolved but returned nothing, or resolved and returned
  // plenty of nodes that just didn't match the regex.

  test('allNodes contains every node the walk returned, not just regex matches', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXButton', label: 'Mute', actions: [] },
      { id: 2, role: 'AXStaticText', label: 'Participants (4)', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.allNodes.length, 2)
    assert.deepEqual(result.allNodes, [
      { role: 'AXButton', label: 'Mute' },
      { role: 'AXStaticText', label: 'Participants (4)' },
    ])
  })

  test('nodesReturned/totalWalked reflect a real, non-empty tree even when nothing matches', () => {
    const ax = fakeAx([
      { id: 1, role: 'AXButton', label: 'Mute', actions: [] },
      { id: 2, role: 'AXButton', label: 'Leave', actions: [] },
    ])
    const result = pollZoomSpeaker(ax)
    assert.equal(result.candidateCount, 0)
    assert.equal(result.nodesReturned, 2) // distinguishes "resolved, found nothing" from "never resolved"
    assert.equal(result.totalWalked, 2)
    assert.equal(result.axError, null)
  })

  test('an ax.find() error surfaces verbatim in axError, with nodesReturned 0', () => {
    const ax: NativeAxLike = { find: () => ({ app: 'zoom.us', nodes: [], total: 0, error: "app 'zoom.us' is not running" }) }
    const result = pollZoomSpeaker(ax)
    assert.equal(result.axError, "app 'zoom.us' is not running")
    assert.equal(result.nodesReturned, 0)
    assert.equal(result.allNodes.length, 0)
  })

  test('an empty node list (Zoom resolved, zero nodes) has axError null, not confused with a real error', () => {
    const result = pollZoomSpeaker(fakeAx([]))
    assert.equal(result.axError, null)
    assert.equal(result.nodesReturned, 0)
  })
})
