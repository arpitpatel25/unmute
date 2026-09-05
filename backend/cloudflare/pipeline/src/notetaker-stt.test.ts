import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

type FetchCall = { url: string; init?: RequestInit }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Notetaker managed STT cascade', () => {
  test('uses OpenRouter Qwen first and does not call Groq after usable text', async () => {
    const module = await import('./notetakerSttCascade').catch(() => null) as null | {
      transcribeNotetakerWithFallback?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    assert.equal(typeof module?.transcribeNotetakerWithFallback, 'function', 'Notetaker cascade is not implemented')

    const calls: FetchCall[] = []
    const result = await module!.transcribeNotetakerWithFallback!({
      audio: new Uint8Array([82, 73, 70, 70]),
      filename: 'chunk.wav',
      mimeType: 'audio/wav',
      durationSeconds: 12,
      language: '',
      openRouterApiKey: 'openrouter-test-key',
      groqApiKey: 'groq-test-key',
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return jsonResponse({
          text: 'Hello from Qwen.',
          segments: [{ start: 0.2, end: 1.1, text: 'Hello from Qwen.' }],
          usage: { seconds: 12, cost: 0.000036 },
        })
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/audio/transcriptions')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    assert.equal(body.model, 'qwen/qwen3-asr-0.6b')
    assert.equal(body.response_format, 'verbose_json')
    assert.deepEqual(body.timestamp_granularities, ['segment'])
    assert.equal(result.provider, 'openrouter')
    assert.equal(result.text, 'Hello from Qwen.')
  })

  test('falls back to Groq Whisper when Qwen returns empty output', async () => {
    const module = await import('./notetakerSttCascade').catch(() => null) as null | {
      transcribeNotetakerWithFallback?: (options: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    }
    assert.equal(typeof module?.transcribeNotetakerWithFallback, 'function', 'Notetaker cascade is not implemented')

    const calls: FetchCall[] = []
    const result = await module!.transcribeNotetakerWithFallback!({
      audio: new Uint8Array([82, 73, 70, 70]),
      filename: 'chunk.wav',
      mimeType: 'audio/wav',
      durationSeconds: 12,
      language: '',
      openRouterApiKey: 'openrouter-test-key',
      groqApiKey: 'groq-test-key',
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        if (calls.length === 1) return jsonResponse({ text: '   ', usage: { seconds: 12, cost: 0.000036 } })
        return jsonResponse({
          text: 'Recovered by Whisper.',
          segments: [{ start: 0, end: 1.4, text: 'Recovered by Whisper.', avg_logprob: -0.1 }],
        })
      },
    })

    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://api.groq.com/openai/v1/audio/transcriptions')
    const groqBody = calls[1].init?.body as FormData
    assert.equal(groqBody.get('model'), 'whisper-large-v3')
    assert.equal(groqBody.get('response_format'), 'verbose_json')
    assert.equal(result?.provider, 'groq')
    assert.equal(result?.text, 'Recovered by Whisper.')
  })

  test('uses Qwen duration pricing when OpenRouter omits response cost', async () => {
    const { transcribeNotetakerWithFallback } = await import('./notetakerSttCascade')
    const result = await transcribeNotetakerWithFallback({
      audio: new Uint8Array([82, 73, 70, 70]),
      filename: 'chunk.wav',
      mimeType: 'audio/wav',
      durationSeconds: 12,
      language: '',
      openRouterApiKey: 'openrouter-test-key',
      groqApiKey: 'groq-test-key',
      fetchImpl: async () => jsonResponse({ text: 'Priced by duration.' }),
    })

    assert.ok(Math.abs((result?.rawCostUsd ?? 0) - 0.00004) < 1e-12)
  })

  test('returns no managed result when both Qwen and Groq fail', async () => {
    const module = await import('./notetakerSttCascade').catch(() => null) as null | {
      transcribeNotetakerWithFallback?: (options: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    }
    assert.equal(typeof module?.transcribeNotetakerWithFallback, 'function', 'Notetaker cascade is not implemented')

    let calls = 0
    const result = await module!.transcribeNotetakerWithFallback!({
      audio: new Uint8Array([82, 73, 70, 70]),
      filename: 'chunk.wav',
      mimeType: 'audio/wav',
      durationSeconds: 12,
      language: '',
      openRouterApiKey: 'openrouter-test-key',
      groqApiKey: 'groq-test-key',
      fetchImpl: async () => {
        calls++
        return jsonResponse({ error: 'upstream unavailable' }, 503)
      },
    })

    assert.equal(calls, 2)
    assert.equal(result, null)
  })
})
