import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoState, transition } from '../demo-state.js';
import { renderDemo } from '../demo-view.js';

test('the initial demo exposes four modes, one MacBook, Notes, and accessible controls', () => {
  const html = renderDemo(createDemoState('dictation'));

  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
  assert.equal((html.match(/class="macbook"/g) ?? []).length, 1);
  assert.match(html, /data-surface="notes"/);
  assert.match(html, /data-surface="notch"/);
  assert.match(html, /aria-label="Unmute notch"/);
  assert.match(html, /data-surface="pill"/);
  assert.match(html, /data-surface="scratchpad"/);
  assert.match(html, /data-action="fn"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<h3>/);
});

test('recording renders the native wordless anatomy instead of an invented listening label', () => {
  const state = transition(createDemoState('dictation'), { type: 'FN_TAP' });
  const html = renderDemo(state);

  assert.match(html, /data-pill-phase="recording"/);
  assert.match(html, /class="record-dot"/);
  assert.match(html, /class="waveform"/);
  assert.match(html, /data-action="stop"/);
  assert.doesNotMatch(html, />Listening</);
});

test('a paused scratchpad is paper beside the bottom pill with deliberate destinations', () => {
  let state = createDemoState('scratchpad');
  state = transition(state, { type: 'FN_TAP' });
  state = transition(state, { type: 'TOGGLE_SCRATCHPAD' });
  state = transition(state, { type: 'FN_TAP' });
  const html = renderDemo(state);

  assert.match(html, /data-pill-phase="paused"/);
  assert.match(html, />Paused</);
  assert.match(html, /class="scratchpad-paper"/);
  assert.match(html, />Paste at cursor</);
  assert.match(html, />New task</);
  assert.doesNotMatch(html, /Unmute · Orchestrator/);
});

test('captured context renders as structured URL and image rows', () => {
  let state = createDemoState('capture');
  for (const type of ['FN_TAP', 'TOGGLE_SCRATCHPAD', 'CAPTURE_URL', 'CAPTURE_SCREENSHOT']) {
    state = transition(state, { type });
  }
  const html = renderDemo(state);

  assert.match(html, /data-entry-kind="url"/);
  assert.match(html, /conductor\.build/);
  assert.match(html, /data-entry-kind="image"/);
  assert.match(html, /unmute-demo-capture\.png/);
});

test('Remote recording includes one joined agent and model control', () => {
  const state = transition(createDemoState('remote'), { type: 'RIGHT_OPTION_TAP' });
  const html = renderDemo(state);

  assert.match(html, /data-action="right-option"/);
  assert.equal((html.match(/class="agent-model-control"/g) ?? []).length, 1);
  assert.match(html, />Claude Code</);
  assert.match(html, />Claude Sonnet 4\.5</);
  assert.match(html, /class="remote-glyph"/);
});

test('completed Remote work stays in an expandable notch task surface', () => {
  let state = createDemoState('remote');
  for (const type of ['RIGHT_OPTION_TAP', 'RIGHT_OPTION_TAP', 'REMOTE_COMPLETE', 'TOGGLE_NOTCH']) {
    state = transition(state, { type });
  }
  const html = renderDemo(state);

  assert.match(html, /data-notch-state="done"/);
  assert.match(html, /class="notch-task-surface"/);
  assert.match(html, /Email sent successfully/);
  assert.doesNotMatch(html, /class="orchestrator-window"/);
});
