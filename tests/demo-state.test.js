import test from 'node:test';
import assert from 'node:assert/strict';
import { actionToEvent, createDemoState, transition } from '../demo-state.js';

function recordAndStop(state) {
  const type = state.mode === 'remote' ? 'RIGHT_OPTION_TAP' : 'FN_TAP';
  state = transition(state, { type });
  return transition(state, { type });
}

test('dictation delivers only the transcript returned by the server', () => {
  let state = recordAndStop(createDemoState('dictation'));
  assert.equal(state.step, 'processing');
  assert.deepEqual(state.note.blocks, []);
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'These are the words I actually said.', attemptsUsed: 1, attemptLimit: 5 });
  assert.deepEqual(state.note.blocks, [{ type: 'text', content: 'These are the words I actually said.' }]);
  assert.deepEqual(state.attempts, { used: 1, limit: 5, remaining: 4 });
  assert.equal(state.pillPhase, 'output');
});

test('failed transcription returns to a retryable state without invented text', () => {
  let state = recordAndStop(createDemoState('dictation'));
  state = transition(state, { type: 'TRANSCRIPTION_FAILED', message: 'The connection dropped.' });
  assert.equal(state.step, 'error');
  assert.equal(state.error, 'The connection dropped.');
  assert.deepEqual(state.note.blocks, []);
  state = transition(state, { type: 'RETRY' });
  assert.equal(state.step, 'ready');
  assert.equal(state.error, '');
});

test('scratchpad accumulates real transcribed segments across pauses', () => {
  let state = createDemoState('scratchpad');
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TOGGLE_SCRATCHPAD' });
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'First real thought.', attemptsUsed: 1, attemptLimit: 5 });
  assert.equal(state.step, 'paused');
  assert.deepEqual(state.scratchpad.entries.map((entry) => entry.content), ['First real thought.']);
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'Second real thought.', attemptsUsed: 2, attemptLimit: 5 });
  state = transition(state, { type: 'DELIVER_SCRATCHPAD', destination: 'cursor' });
  assert.deepEqual(state.note.blocks.map((block) => block.content), ['First real thought.', 'Second real thought.']);
});

test('capture keeps pasted image data in order with real speech', () => {
  let state = createDemoState('capture');
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TOGGLE_SCRATCHPAD' });
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'Use this screenshot.', attemptsUsed: 1, attemptLimit: 5 });
  state = transition(state, { type: 'IMAGE_PASTED', id: 'image-1', url: 'blob:real-image', name: 'Screenshot.png' });
  assert.deepEqual(state.scratchpad.entries.map((entry) => entry.kind), ['segment', 'image']);
  assert.equal(state.scratchpad.entries[1].url, 'blob:real-image');
  state = transition(state, { type: 'DELIVER_SCRATCHPAD', destination: 'cursor' });
  assert.deepEqual(state.note.blocks, [
    { type: 'text', content: 'Use this screenshot.' },
    { type: 'image', content: 'Screenshot.png', url: 'blob:real-image' }
  ]);
});

test('the fifth server-reported attempt prevents another recording', () => {
  let state = recordAndStop(createDemoState('dictation'));
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'Final try.', attemptsUsed: 5, attemptLimit: 5 });
  state = transition(state, { type: 'RESET' });
  assert.equal(state.attempts.remaining, 0);
  assert.equal(state.step, 'quota');
  assert.deepEqual(transition(state, { type: 'FN_TAP' }), state);
});

test('Remote uses the real transcript as the notch task prompt', () => {
  let state = recordAndStop(createDemoState('remote'));
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'Email Maya and say the beta opens Friday.', attemptsUsed: 1, attemptLimit: 5 });
  assert.equal(state.notch.state, 'working');
  assert.equal(state.remote.transcript, 'Email Maya and say the beta opens Friday.');
  assert.equal(state.notch.title, 'New Unmute task');
  state = transition(state, { type: 'REMOTE_COMPLETE', result: 'Task demonstration complete' });
  assert.equal(state.notch.result, 'Task demonstration complete');
});

test('mode changes preserve server quota but clear transient content', () => {
  let state = recordAndStop(createDemoState('dictation'));
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'One.', attemptsUsed: 1, attemptLimit: 5 });
  state = transition(state, { type: 'SELECT_MODE', mode: 'capture' });
  assert.equal(state.mode, 'capture');
  assert.equal(state.attempts.used, 1);
  assert.deepEqual(state.note.blocks, []);
});

test('browser controls map to tap-toggle, retry, and reset events', () => {
  assert.deepEqual(actionToEvent('fn', createDemoState('dictation')), { type: 'FN_TAP' });
  assert.deepEqual(actionToEvent('stop', createDemoState('remote')), { type: 'RIGHT_OPTION_TAP' });
  assert.deepEqual(actionToEvent('scratchpad', createDemoState('capture')), { type: 'TOGGLE_SCRATCHPAD' });
  assert.deepEqual(actionToEvent('retry', createDemoState('dictation')), { type: 'RETRY' });
  assert.deepEqual(actionToEvent('reset', createDemoState('dictation')), { type: 'RESET' });
  assert.equal(actionToEvent('not-a-control', createDemoState('dictation')), null);
});
