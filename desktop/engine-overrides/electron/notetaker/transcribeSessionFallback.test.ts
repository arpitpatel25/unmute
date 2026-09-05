import assert from 'node:assert/strict'
import { test } from 'node:test'

const encoded = {
  wav: Buffer.from('RIFF-test'),
  durationSeconds: 12,
  sampleRate: 16_000,
}

test('uses local Parakeet when managed Notetaker STT has no result', async () => {
  const module = await import('./notetakerSttFallback').catch(() => null) as null | {
    transcribeEncodedChunkWithFallback?: (
      channel: 'mic' | 'system',
      value: typeof encoded,
      dependencies: {
        managed: () => Promise<null>
        local: () => Promise<string>
      },
    ) => Promise<{ text: string; failed: boolean; segments: unknown[] }>
  }
  assert.equal(typeof module?.transcribeEncodedChunkWithFallback, 'function', 'Desktop Notetaker fallback is not implemented')

  const result = await module!.transcribeEncodedChunkWithFallback!(
    'mic',
    encoded,
    {
      managed: async () => null,
      local: async () => 'Recovered locally.',
    },
  )

  assert.deepEqual(result, { text: 'Recovered locally.', failed: false, segments: [] })
})

test('does not call local Parakeet after a usable managed transcript', async () => {
  const module = await import('./notetakerSttFallback').catch(() => null) as null | {
    transcribeEncodedChunkWithFallback?: (
      channel: 'mic' | 'system',
      value: typeof encoded,
      dependencies: {
        managed: () => Promise<{ text: string; segments?: unknown[] }>
        local: () => Promise<string>
      },
    ) => Promise<{ text: string; failed: boolean; segments: unknown[] }>
  }
  assert.equal(typeof module?.transcribeEncodedChunkWithFallback, 'function', 'Desktop Notetaker fallback is not implemented')

  let localCalls = 0
  const result = await module!.transcribeEncodedChunkWithFallback!(
    'system',
    encoded,
    {
      managed: async () => ({
        text: 'Managed transcript.',
        segments: [{ start: 0, end: 1, text: 'Managed transcript.' }],
      }),
      local: async () => { localCalls++; return 'Should not be used.' },
    },
  )

  assert.equal(localCalls, 0)
  assert.equal(result.text, 'Managed transcript.')
  assert.equal(result.failed, false)
})
