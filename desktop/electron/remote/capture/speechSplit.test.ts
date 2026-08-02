import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sentenceBoundaries, splitSpeech } from './speechSplit'

/** Everything the composer relies on: trim each piece, join with one space. */
const rejoin = (pieces: { text: string }[]) => pieces.map((p) => p.text.trim()).join(' ')

describe('sentenceBoundaries', () => {
  test('a boundary is the index just past the space after a sentence', () => {
    assert.deepEqual(sentenceBoundaries('One. Two. Three.'), [5, 10])
  })

  test('the last sentence has no trailing space, so it opens no boundary', () => {
    assert.deepEqual(sentenceBoundaries('Only one sentence.'), [])
  })

  test('question and exclamation marks end sentences too', () => {
    assert.deepEqual(sentenceBoundaries('Really? Yes! Fine.'), [8, 13])
  })

  test('closing quotes and brackets ride with the terminator', () => {
    assert.deepEqual(sentenceBoundaries('He said "go." Then left.'), [14])
  })

  test('a run of terminators is ONE boundary, not several', () => {
    assert.deepEqual(sentenceBoundaries('What?! Now.'), [7])
  })

  test('a newline is NOT a boundary — rejoining would eat the line break', () => {
    assert.deepEqual(sentenceBoundaries('One.\nTwo.'), [])
  })

  test('no sentence punctuation at all yields nothing to cut at', () => {
    assert.deepEqual(sentenceBoundaries('just some words with no full stop'), [])
  })
})

describe('splitSpeech places the seam where the copy happened', () => {
  // THE FIELD BUG, as it was reported. One dictation, a link copied after
  // "…this tracker", and the composed paste put the link at the very end.
  const REAL = 'So I want you to go through the open source cross project, '
    + "right? It's about agent or this tracker. It allows you to do all case "
    + 'straight multiple agents.'

  test('the real transcript splits after the sentence the copy followed', () => {
    // Spoken over 15s; the copy landed at 9s, just after "…this tracker."
    const pieces = splitSpeech(REAL, 0, 15_000, [9_000])

    assert.equal(pieces.length, 2)
    assert.equal(
      pieces[0].text.trim(),
      'So I want you to go through the open source cross project, '
      + "right? It's about agent or this tracker.",
    )
    assert.equal(pieces[1].text.trim(), 'It allows you to do all case straight multiple agents.')
    assert.ok(pieces[1].startMs > 9_000, 'the piece after the copy must sort AFTER it')
  })

  test('a copy early in the utterance splits at the FIRST boundary, not the last', () => {
    const pieces = splitSpeech(REAL, 0, 15_000, [4_500])
    assert.equal(pieces.length, 2)
    assert.equal(
      pieces[0].text.trim(),
      'So I want you to go through the open source cross project, right?',
    )
  })

  test('two copies open two seams, in order', () => {
    const pieces = splitSpeech(REAL, 0, 15_000, [4_500, 9_000])
    assert.equal(pieces.length, 3)
    assert.ok(pieces[0].startMs < pieces[1].startMs)
    assert.ok(pieces[1].startMs < pieces[2].startMs)
    assert.ok(pieces[1].startMs > 4_500)
    assert.ok(pieces[2].startMs > 9_000)
  })

  test('NO CHARACTER IS LOST — the pieces rejoin to the original, exactly', () => {
    for (const times of [[9_000], [4_500], [4_500, 9_000], [1], [14_999]]) {
      assert.equal(rejoin(splitSpeech(REAL, 0, 15_000, times)), REAL, `times=${times}`)
    }
  })
})

describe('splitSpeech refuses to split when it cannot do better', () => {
  const TEXT = 'One. Two. Three.'

  test('nothing copied ⇒ one piece, and the text is the SAME string', () => {
    const pieces = splitSpeech(TEXT, 0, 10_000, [])
    assert.equal(pieces.length, 1)
    assert.strictEqual(pieces[0].text, TEXT, 'same reference, not merely equal')
  })

  test('a copy at or before the start belongs to what came before', () => {
    assert.equal(splitSpeech(TEXT, 1_000, 10_000, [1_000]).length, 1)
    assert.equal(splitSpeech(TEXT, 1_000, 10_000, [500]).length, 1)
  })

  test('a copy at or after the end already sorts after the whole stretch', () => {
    assert.equal(splitSpeech(TEXT, 0, 10_000, [10_000]).length, 1)
    assert.equal(splitSpeech(TEXT, 0, 10_000, [12_000]).length, 1)
  })

  test('no sentence boundary ⇒ NEVER a mid-sentence cut, however many copies', () => {
    const run = 'go through the thread from this morning and compare it'
    const pieces = splitSpeech(run, 0, 10_000, [2_000, 4_000, 6_000])
    assert.equal(pieces.length, 1)
    assert.strictEqual(pieces[0].text, run)
  })

  test('a stretch with no measurable duration cannot be positioned in', () => {
    assert.equal(splitSpeech(TEXT, 0, 0, [1]).length, 1)
    assert.equal(splitSpeech(TEXT, 5_000, 1_000, [2_000]).length, 1)
  })

  test('empty text stays empty and stays one piece', () => {
    assert.deepEqual(splitSpeech('', 0, 10_000, [5_000]), [{ text: '', startMs: 0, endMs: 10_000 }])
  })
})

describe('splitSpeech edges', () => {
  test('more copies than boundaries: the extras append rather than forcing a cut', () => {
    const pieces = splitSpeech('One. Two. Three.', 0, 10_000, [1_000, 3_000, 5_000, 7_000, 9_000])
    assert.equal(pieces.length, 3, 'two boundaries ⇒ at most three pieces')
    assert.equal(rejoin(pieces), 'One. Two. Three.')
  })

  test('two copies a millisecond apart cannot be separated by speech', () => {
    // The second piece would have to start at t+1 == the second insert's own
    // time, and a segment sorts BEFORE an insert on a tie — so it would land in
    // front of the very insert it is supposed to follow. One cut, both inserts
    // side by side, which is the truth about what happened.
    const pieces = splitSpeech('One. Two. Three.', 0, 10_000, [5_000, 5_001])
    assert.equal(pieces.length, 2)
    assert.ok(pieces[1].startMs > 5_001 || pieces[1].startMs === 5_001)
  })

  test('every piece after a cut starts strictly after the insert it follows', () => {
    const pieces = splitSpeech('One. Two. Three. Four.', 0, 20_000, [5_000, 12_000])
    assert.equal(pieces.length, 3)
    assert.equal(pieces[1].startMs, 5_001)
    assert.equal(pieces[2].startMs, 12_001)
  })

  test('pieces tile the stretch — the first starts at startMs, the last ends at endMs', () => {
    const pieces = splitSpeech('One. Two. Three.', 2_000, 20_000, [9_000])
    assert.equal(pieces[0].startMs, 2_000)
    assert.equal(pieces[pieces.length - 1].endMs, 20_000)
    for (let i = 1; i < pieces.length; i++) {
      assert.equal(pieces[i - 1].endMs, pieces[i].startMs, 'no gap between pieces')
    }
  })
})
