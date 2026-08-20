export class TranscriptionError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
  }
}

export function createTranscriptionClient({ endpoint, fetchImpl = globalThis.fetch } = {}) {
  if (!endpoint) throw new Error('A demo transcription endpoint is required.');
  if (!fetchImpl) throw new Error('Fetch is not available in this browser.');

  async function transcribe({ blob, durationSeconds, flowType }) {
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('duration_seconds', String(durationSeconds));
    form.append('flow_type', flowType || 'dictation');

    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', body: form, credentials: 'include' });
    } catch {
      throw new TranscriptionError('Could not reach Unmute. Check your connection and try again.');
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new TranscriptionError('Unmute returned an unreadable response.', response.status);
    }
    if (!response.ok || body?.ok === false) {
      throw new TranscriptionError(body?.message || 'Unmute could not transcribe this recording.', response.status);
    }

    const text = String(body?.data?.text || '').trim();
    if (!text) throw new TranscriptionError('No speech was detected. Try again.', response.status);
    const demo = body.demo || {};
    return {
      text,
      attemptsUsed: Number(demo.attempts_used ?? body.attempts_used ?? 1),
      attemptLimit: Number(demo.attempt_limit ?? body.attempt_limit ?? 5)
    };
  }

  return { transcribe };
}
