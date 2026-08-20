import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoState, transition } from '../demo-state.js';
import { renderDemo } from '../demo-view.js';

test('the initial demo asks for microphone access and explains the exact permission boundary', () => {
  const html = renderDemo(createDemoState('dictation'));
  assert.match(html, /data-action="enable-mic"/);
  assert.match(html, /Enable microphone/);
  assert.match(html, /Audio is sent to Unmute only when you record/);
  assert.match(html, /5 free transcriptions left/);
  assert.doesNotMatch(html, /Screenshot permission|Screen sharing|clipboard permission/i);
});

test('a granted demo exposes the real recording control and native wordless pill', () => {
  let state = transition(createDemoState('dictation'), { type: 'PERMISSION_GRANTED' });
  state = transition(state, { type: 'FN_TAP' });
  const html = renderDemo(state);
  assert.match(html, /data-pill-phase="recording"/);
  assert.match(html, /class="record-dot"/);
  assert.match(html, /class="waveform"/);
  assert.match(html, /data-action="stop"/);
  assert.doesNotMatch(html, />Listening</);
});

test('processing and errors tell the truth without substituting demo copy', () => {
  let state = transition(createDemoState('dictation'), { type: 'PERMISSION_GRANTED' });
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'FN_TAP' });
  assert.match(renderDemo(state), /Transcribing/);

  state = transition(state, { type: 'TRANSCRIPTION_FAILED', message: 'Could not reach Unmute.' });
  const html = renderDemo(state);
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not reach Unmute/);
  assert.match(html, /data-action="retry"/);
  assert.doesNotMatch(html, /Turn these rough thoughts/);
});

test('capture invites explicit paste or drop and renders the visitor image', () => {
  let state = createDemoState('capture');
  state = transition(state, { type: 'IMAGE_PASTED', id: 'image-1', url: 'blob:visitor-shot', name: 'Screenshot 1.png' });
  const html = renderDemo(state);
  assert.match(html, /data-paste-zone/);
  assert.match(html, /Paste with ⌘V or drop a screenshot/);
  assert.match(html, /src="blob:visitor-shot"/);
  assert.match(html, /Screenshot 1\.png/);
  assert.doesNotMatch(html, /unmute-demo-capture\.png/);
});

test('real scratchpad segments render as paper beside the bottom pill', () => {
  let state = transition(createDemoState('scratchpad'), { type: 'PERMISSION_GRANTED' });
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TOGGLE_SCRATCHPAD' });
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'A real held thought.', attemptsUsed: 1, attemptLimit: 5 });
  const html = renderDemo(state);
  assert.match(html, /class="scratchpad-paper"/);
  assert.match(html, /A real held thought/);
  assert.match(html, />Paste at cursor</);
  assert.doesNotMatch(html, /Unmute · Orchestrator/);
});

test('Remote notch displays the visitor transcript and labels the result as a demonstration', () => {
  let state = transition(createDemoState('remote'), { type: 'PERMISSION_GRANTED' });
  state = transition(state, { type: 'RIGHT_OPTION_TAP' });
  state = transition(state, { type: 'RIGHT_OPTION_TAP' });
  state = transition(state, { type: 'TRANSCRIPTION_SUCCEEDED', text: 'Sort my downloads by project.', attemptsUsed: 1, attemptLimit: 5 });
  state = transition(state, { type: 'TOGGLE_NOTCH' });
  const html = renderDemo(state);
  assert.match(html, /Sort my downloads by project/);
  assert.match(html, /Task demonstration/);
  assert.doesNotMatch(html, /Email Maya/);
});

test('quota state disables recording while preserving deliverable Scratchpad content', () => {
  let state = createDemoState('scratchpad');
  state = { ...state, attempts: { used: 5, limit: 5, remaining: 0 }, step: 'quota' };
  const html = renderDemo(state);
  assert.match(html, /0 free transcriptions left/);
  assert.match(html, /Demo limit reached/);
  assert.doesNotMatch(html, /data-action="fn"/);
});
