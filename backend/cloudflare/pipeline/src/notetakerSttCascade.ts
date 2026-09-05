export const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
export const OPENROUTER_NOTETAKER_MODEL = 'qwen/qwen3-asr-0.6b'
export const OPENROUTER_QWEN_COST_PER_SECOND_USD = 0.012 / 3600
export const GROQ_NOTETAKER_MODEL = 'whisper-large-v3'
const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

export type NotetakerTimestampSegment = {
  start: number
  end: number
  text: string
  avg_logprob?: number
  no_speech_prob?: number
  compression_ratio?: number
}

export type NotetakerManagedTranscript = {
  provider: 'openrouter' | 'groq'
  model: string
  text: string
  segments: NotetakerTimestampSegment[]
  rawCostUsd: number
  latencyMs: number
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type NotetakerSTTCascadeOptions = {
  audio: Uint8Array
  filename: string
  mimeType: string
  durationSeconds: number
  language?: string
  openRouterApiKey: string
  groqApiKey: string
  fetchImpl?: FetchLike
}

type UpstreamPayload = {
  text?: unknown
  segments?: unknown
  usage?: { cost?: unknown }
}

function base64Audio(audio: Uint8Array): string {
  let binary = ''
  const stride = 0x8000
  for (let offset = 0; offset < audio.length; offset += stride) {
    binary += String.fromCharCode(...audio.subarray(offset, offset + stride))
  }
  return btoa(binary)
}

function normalizedSegments(value: unknown): NotetakerTimestampSegment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const segment = candidate as Record<string, unknown>
    if (typeof segment.start !== 'number' || typeof segment.end !== 'number' || typeof segment.text !== 'string') return []
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start) return []
    return [{
      start: segment.start,
      end: segment.end,
      text: segment.text,
      ...(typeof segment.avg_logprob === 'number' ? { avg_logprob: segment.avg_logprob } : {}),
      ...(typeof segment.no_speech_prob === 'number' ? { no_speech_prob: segment.no_speech_prob } : {}),
      ...(typeof segment.compression_ratio === 'number' ? { compression_ratio: segment.compression_ratio } : {}),
    }]
  })
}

async function readUsablePayload(response: Response): Promise<{ text: string; segments: NotetakerTimestampSegment[]; reportedCostUsd: number | null } | null> {
  if (!response.ok) return null
  let payload: UpstreamPayload
  try {
    payload = await response.json() as UpstreamPayload
  } catch {
    return null
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) return null
  const reportedCost = payload.usage?.cost
  return {
    text,
    segments: normalizedSegments(payload.segments),
    reportedCostUsd: typeof reportedCost === 'number' && Number.isFinite(reportedCost) ? reportedCost : null,
  }
}

async function tryOpenRouter(options: NotetakerSTTCascadeOptions, fetchImpl: FetchLike): Promise<NotetakerManagedTranscript | null> {
  if (!options.openRouterApiKey) return null
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(OPENROUTER_STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://unmute.app',
        'X-OpenRouter-Title': 'Unmute Notetaker',
      },
      body: JSON.stringify({
        model: OPENROUTER_NOTETAKER_MODEL,
        input_audio: { data: base64Audio(options.audio), format: options.mimeType === 'audio/wav' ? 'wav' : options.mimeType.replace('audio/', '') },
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
        temperature: 0,
        ...(options.language ? { language: options.language } : {}),
      }),
    })
    const payload = await readUsablePayload(response)
    if (!payload) return null
    return {
      provider: 'openrouter',
      model: OPENROUTER_NOTETAKER_MODEL,
      text: payload.text,
      segments: payload.segments,
      rawCostUsd: payload.reportedCostUsd ?? OPENROUTER_QWEN_COST_PER_SECOND_USD * options.durationSeconds,
      latencyMs: Date.now() - startedAt,
    }
  } catch {
    return null
  }
}

async function tryGroq(options: NotetakerSTTCascadeOptions, fetchImpl: FetchLike): Promise<NotetakerManagedTranscript | null> {
  if (!options.groqApiKey) return null
  const startedAt = Date.now()
  try {
    const form = new FormData()
    form.append('file', new Blob([options.audio], { type: options.mimeType }), options.filename)
    form.append('model', GROQ_NOTETAKER_MODEL)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'segment')
    form.append('temperature', '0')
    if (options.language) form.append('language', options.language)
    const response = await fetchImpl(GROQ_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.groqApiKey}` },
      body: form,
    })
    const payload = await readUsablePayload(response)
    if (!payload) return null
    return {
      provider: 'groq',
      model: GROQ_NOTETAKER_MODEL,
      text: payload.text,
      segments: payload.segments,
      // Groq does not return cost in its transcription body. Preserve the
      // existing duration-based accounting for the fallback lane.
      rawCostUsd: 0.111 / 3600 * options.durationSeconds,
      latencyMs: Date.now() - startedAt,
    }
  } catch {
    return null
  }
}

/** Notetaker only: Qwen is primary, existing Groq Whisper is the managed
 * fallback. A null result tells the desktop to use its on-device Parakeet. */
export async function transcribeNotetakerWithFallback(options: NotetakerSTTCascadeOptions): Promise<NotetakerManagedTranscript | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  return await tryOpenRouter(options, fetchImpl) ?? await tryGroq(options, fetchImpl)
}
