import { test, describe } from 'node:test'
import assert from 'node:assert'
import { effectiveSilenceThreshold, decideCut, type CutInput } from './vadPolicy'

describe('effectiveSilenceThreshold', () => {
  test('quiet room: configured threshold wins', () => {
    assert.equal(effectiveSilenceThreshold(0.015, 0.003), 0.015)
  })
  test('noisy café: raises to floor*1.6 (measured floor 0.013 → 0.0208)', () => {
    assert.ok(Math.abs(effectiveSilenceThreshold(0.015, 0.013) - 0.0208) < 1e-9)
  })
  test('caps at 0.045 so speech can never read as silence', () => {
    assert.equal(effectiveSilenceThreshold(0.015, 0.2), 0.045)
  })
  test('no floor yet (recording just started): configured', () => {
    assert.equal(effectiveSilenceThreshold(0.015, null), 0.015)
  })
})

const base: CutInput = {
  rms: 0.1, chunkElapsedMs: 10_000, silenceSinceMs: null,
  minChunkMs: 30_000, silenceDurationMs: 400, hardCapMs: 45_000,
  softCapWindowMs: 5_000, threshold: 0.015,
}

describe('decideCut', () => {
  test('before minChunkMs: never cuts, even in silence', () => {
    assert.equal(decideCut({ ...base, rms: 0.001, silenceSinceMs: 1000 }), 'none')
  })
  test('sustained silence after minChunkMs cuts', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 31_000, rms: 0.001, silenceSinceMs: 400 }), 'silence')
  })
  test('silence not yet sustained: none', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 31_000, rms: 0.001, silenceSinceMs: 200 }), 'none')
  })
  test('hard cap always cuts', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 45_000, rms: 0.3 }), 'hard-cap')
  })
  test('soft-cap window: near the cap, a dip below 1.5x threshold cuts immediately', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 41_000, rms: 0.02 }), 'soft-cap')
  })
  test('soft-cap window: loud speech does NOT cut', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 41_000, rms: 0.1 }), 'none')
  })
  test('soft-cap window only opens inside hardCap - softCapWindow', () => {
    assert.equal(decideCut({ ...base, chunkElapsedMs: 39_000, rms: 0.02 }), 'none')
  })
})

describe('insert cut (permit, never force)', () => {
  const silent = {
    ...base, rms: 0.001, silenceSinceMs: 800, chunkElapsedMs: 12_000,
  }

  test('a pending insert in sustained silence past the floor cuts', () => {
    assert.equal(decideCut({ ...silent, insertPending: true }), 'insert')
  })

  test('no pending insert: unchanged behaviour, no cut before minChunkMs', () => {
    assert.equal(decideCut(silent), 'none')
  })

  test('NEVER cuts mid-speech, however long the chunk has run', () => {
    assert.equal(
      decideCut({ ...silent, rms: 0.2, silenceSinceMs: null, insertPending: true }),
      'none',
    )
  })

  test('never cuts below the floor — a sliver transcribes badly', () => {
    assert.equal(
      decideCut({ ...silent, chunkElapsedMs: 3_000, insertPending: true }),
      'none',
    )
  })

  test('silence must be SUSTAINED, not a momentary dip', () => {
    assert.equal(
      decideCut({ ...silent, silenceSinceMs: 100, insertPending: true }),
      'none',
    )
  })

  test('hard cap still outranks an insert cut', () => {
    assert.equal(
      decideCut({ ...silent, chunkElapsedMs: 45_000, insertPending: true }),
      'hard-cap',
    )
  })

  test('past minChunkMs an ordinary silence cut still wins the label', () => {
    assert.equal(
      decideCut({ ...silent, chunkElapsedMs: 31_000, insertPending: true }),
      'silence',
    )
  })
})
