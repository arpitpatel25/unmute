import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoState, transition } from '../demo-state.js';

test('switching modes clears the previous flow and restores its first instruction', () => {
  let state = createDemoState('dictation');
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'SELECT_MODE', mode: 'remote' });

  assert.equal(state.mode, 'remote');
  assert.equal(state.step, 'ready');
  assert.equal(state.pillPhase, 'hidden');
  assert.equal(state.note.blocks.length, 0);
  assert.equal(state.guide.action, 'Tap Right Option');
});

test('two Fn taps record and deliver dictation to Notes after processing completes', () => {
  let state = createDemoState('dictation');
  state = transition(state, { type: 'FN_TAP' });
  assert.equal(state.pillPhase, 'recording');

  state = transition(state, { type: 'FN_TAP' });
  assert.equal(state.pillPhase, 'processing');
  assert.equal(state.note.blocks.length, 0);

  state = transition(state, { type: 'PROCESSING_DONE' });
  assert.equal(state.pillPhase, 'output');
  assert.deepEqual(state.note.blocks, [{ type: 'text', content: 'Turn these rough thoughts into a clear launch note.' }]);
});

test('an armed scratchpad pauses instead of delivering and resumes the same pad', () => {
  let state = createDemoState('scratchpad');
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TOGGLE_SCRATCHPAD' });
  state = transition(state, { type: 'FN_TAP' });

  assert.equal(state.pillPhase, 'paused');
  assert.equal(state.scratchpad.armed, true);
  assert.equal(state.scratchpad.entries.length, 1);
  assert.equal(state.note.blocks.length, 0);

  state = transition(state, { type: 'FN_TAP' });
  assert.equal(state.pillPhase, 'recording');
  state = transition(state, { type: 'FN_TAP' });
  assert.equal(state.scratchpad.entries.length, 2);

  state = transition(state, { type: 'DELIVER_SCRATCHPAD', destination: 'cursor' });
  assert.equal(state.pillPhase, 'output');
  assert.equal(state.scratchpad.entries.length, 0);
  assert.deepEqual(state.note.blocks.map((block) => block.content), [
    'The launch note should lead with speed, not features.',
    'Then explain that your words survive bad internet.'
  ]);
});

test('capture keeps copied links and screenshots between speech segments in event order', () => {
  let state = createDemoState('capture');
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TOGGLE_SCRATCHPAD' });
  state = transition(state, { type: 'CAPTURE_URL' });
  state = transition(state, { type: 'CAPTURE_SCREENSHOT' });
  state = transition(state, { type: 'FN_TAP' });

  assert.deepEqual(state.scratchpad.entries.map((entry) => entry.kind), ['segment', 'url', 'image']);

  state = transition(state, { type: 'DELIVER_SCRATCHPAD', destination: 'cursor' });
  assert.deepEqual(state.note.blocks.map((block) => block.type), ['text', 'link', 'image']);
  assert.equal(state.note.blocks[1].content, 'https://conductor.build');
  assert.equal(state.note.blocks[2].content, 'unmute-demo-capture.png');
});

test('Remote is tap-toggle and moves the task from the pill into the notch', () => {
  let state = createDemoState('remote');
  state = transition(state, { type: 'RIGHT_OPTION_TAP' });
  assert.equal(state.pillPhase, 'recording');
  assert.equal(state.remote.model, 'Claude Sonnet 4.5');

  state = transition(state, { type: 'RIGHT_OPTION_TAP' });
  assert.equal(state.pillPhase, 'processing');
  assert.equal(state.notch.state, 'working');
  assert.equal(state.notch.title, 'Send launch update');

  state = transition(state, { type: 'REMOTE_CREATED' });
  assert.equal(state.pillPhase, 'output');
  assert.equal(state.notch.state, 'working');

  state = transition(state, { type: 'REMOTE_COMPLETE' });
  assert.equal(state.notch.state, 'done');
  assert.equal(state.notch.result, 'Email sent successfully');

  state = transition(state, { type: 'TOGGLE_NOTCH' });
  assert.equal(state.notch.expanded, true);
});

test('events that do not belong to the current flow are ignored', () => {
  const state = createDemoState('dictation');
  assert.deepEqual(transition(state, { type: 'RIGHT_OPTION_TAP' }), state);
  assert.deepEqual(transition(state, { type: 'CAPTURE_SCREENSHOT' }), state);
});
