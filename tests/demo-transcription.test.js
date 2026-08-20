import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptionClient } from '../demo-transcription.js';

test('transcribe sends Unmute multipart fields and normalizes quota metadata', async () => {
  let request;
  const client = createTranscriptionClient({
    endpoint: 'https://api.unmute.example/v1/demo/stt',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        ok: true,
        data: { text: 'The real transcript.' },
        demo: { attempts_used: 2, attempt_limit: 5 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await client.transcribe({
    blob: new Blob(['audio'], { type: 'audio/webm' }),
    durationSeconds: 2.5,
    flowType: 'scratchpad'
  });

  assert.equal(request.url, 'https://api.unmute.example/v1/demo/stt');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.body.get('duration_seconds'), '2.5');
  assert.equal(request.init.body.get('flow_type'), 'scratchpad');
  assert.equal(request.init.body.get('file').type, 'audio/webm');
  assert.deepEqual(result, { text: 'The real transcript.', attemptsUsed: 2, attemptLimit: 5 });
});

test('quota and upstream errors keep the server message', async () => {
  const client = createTranscriptionClient({
    endpoint: '/v1/demo/stt',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, message: 'Five demo transcriptions used.' }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(
    client.transcribe({ blob: new Blob(['audio']), durationSeconds: 1, flowType: 'dictation' }),
    (error) => error.status === 429 && error.message === 'Five demo transcriptions used.'
  );
});

test('a successful response without transcript text is rejected', async () => {
  const client = createTranscriptionClient({
    endpoint: '/v1/demo/stt',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: { text: '' } }), { status: 200 })
  });

  await assert.rejects(
    client.transcribe({ blob: new Blob(['audio']), durationSeconds: 1, flowType: 'dictation' }),
    /No speech was detected/i
  );
});
