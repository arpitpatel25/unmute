export const DEMO_MODES = Object.freeze(['dictation', 'scratchpad', 'capture', 'remote']);

const GUIDES = Object.freeze({
  dictation: {
    ready: ['Start dictating', 'Your microphone is used only while the pill is active'],
    recording: ['Speak naturally', 'Tap the stop button when you are finished'],
    processing: ['Transcribing', 'Your recording is being sent to Unmute'],
    delivered: ['Delivered', 'Your words landed at the cursor'],
    error: ['Try again', 'Your note was not changed'],
    quota: ['Demo complete', 'You used all five free transcriptions']
  },
  scratchpad: {
    ready: ['Start a thought', 'Arm Scratchpad before you stop'],
    recording: ['Keep this thought', 'Tap Scratchpad, then stop recording'],
    processing: ['Transcribing', 'This segment will be held in Scratchpad'],
    paused: ['Thought held', 'Record another segment or paste at the cursor'],
    delivered: ['Delivered', 'Your held thoughts landed together'],
    error: ['Try this segment again', 'Your existing Scratchpad is unchanged'],
    quota: ['Demo complete', 'Paste the thoughts you already recorded']
  },
  capture: {
    ready: ['Start with your voice', 'Arm Scratchpad before you stop'],
    recording: ['Add the context', 'Speak, then paste a screenshot with Command-V'],
    processing: ['Transcribing', 'Your screenshot stays in this browser'],
    paused: ['Context held', 'Paste or drop a screenshot, then choose a destination'],
    delivered: ['Delivered', 'Your words and screenshot landed together'],
    error: ['Try this segment again', 'Your pasted screenshot is still here'],
    quota: ['Demo complete', 'Paste the context you already collected']
  },
  remote: {
    ready: ['Start a task', 'Say what you want an agent to do'],
    recording: ['Describe the task', 'Tap stop when the request is complete'],
    processing: ['Transcribing', 'Unmute is preparing the task request'],
    working: ['Task created', 'The notch keeps its progress in reach'],
    done: ['Open the notch', 'See the task demonstration result'],
    error: ['Try again', 'No task was created'],
    quota: ['Demo complete', 'You used all five free transcriptions']
  }
});

function guide(mode, step) {
  const [action, detail] = GUIDES[mode][step] ?? GUIDES[mode].ready;
  return { action, detail };
}

function normalizeAttempts(value = {}) {
  const limit = Number.isFinite(value.limit) ? value.limit : 5;
  const used = Math.max(0, Math.min(limit, Number.isFinite(value.used) ? value.used : 0));
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export function createDemoState(mode = 'dictation', attempts) {
  const safeMode = DEMO_MODES.includes(mode) ? mode : 'dictation';
  const normalizedAttempts = normalizeAttempts(attempts);
  const step = normalizedAttempts.remaining === 0 ? 'quota' : 'ready';
  return {
    mode: safeMode,
    step,
    pillPhase: 'hidden',
    guide: guide(safeMode, step),
    permission: 'idle',
    error: '',
    attempts: normalizedAttempts,
    scratchpad: { armed: false, expanded: true, entries: [] },
    note: { title: 'Quick Note', blocks: [] },
    notch: { state: 'idle', expanded: false, title: '', result: '' },
    remote: { model: 'Claude Sonnet 4.5', agent: 'Claude Code', transcript: '' }
  };
}

function withStep(state, step, extra = {}) {
  return { ...state, ...extra, step, guide: guide(state.mode, step) };
}

function attemptsFromEvent(state, event) {
  return normalizeAttempts({
    used: Number.isFinite(event.attemptsUsed) ? event.attemptsUsed : state.attempts.used + 1,
    limit: Number.isFinite(event.attemptLimit) ? event.attemptLimit : state.attempts.limit
  });
}

function segment(content, entries) {
  return { id: `segment-${entries.length + 1}`, type: 'segment', kind: 'segment', content };
}

function entriesToBlocks(entries) {
  return entries.map((entry) => entry.kind === 'image'
    ? { type: 'image', content: entry.content, url: entry.url }
    : { type: 'text', content: entry.content });
}

function deliverPad(state) {
  return withStep(state, 'delivered', {
    pillPhase: 'output',
    note: { ...state.note, blocks: entriesToBlocks(state.scratchpad.entries) },
    scratchpad: { armed: false, expanded: false, entries: [] }
  });
}

export function actionToEvent(action, state) {
  const events = {
    fn: { type: 'FN_TAP' },
    stop: { type: state.mode === 'remote' ? 'RIGHT_OPTION_TAP' : 'FN_TAP' },
    'right-option': { type: 'RIGHT_OPTION_TAP' },
    scratchpad: { type: 'TOGGLE_SCRATCHPAD' },
    'deliver-cursor': { type: 'DELIVER_SCRATCHPAD', destination: 'cursor' },
    'deliver-task': { type: 'DELIVER_SCRATCHPAD', destination: 'task' },
    'toggle-notch': { type: 'TOGGLE_NOTCH' },
    'cycle-model': { type: 'CYCLE_MODEL' },
    'discard-pad': { type: 'DISCARD_PAD' },
    retry: { type: 'RETRY' },
    reset: { type: 'RESET' }
  };
  return events[action] ?? null;
}

export function transition(state, event) {
  if (!state || !event?.type) return state;

  if (event.type === 'SELECT_MODE' && DEMO_MODES.includes(event.mode)) {
    return createDemoState(event.mode, state.attempts);
  }
  if (event.type === 'RESET') return createDemoState(state.mode, state.attempts);
  if (event.type === 'RETRY' && state.step === 'error') {
    return withStep(state, state.attempts.remaining ? 'ready' : 'quota', { error: '', pillPhase: 'hidden' });
  }
  if (event.type === 'PERMISSION_GRANTED') return { ...state, permission: 'granted', error: '' };
  if (event.type === 'PERMISSION_DENIED') {
    return withStep(state, 'error', { permission: 'denied', error: event.message || 'Microphone access is required.', pillPhase: 'hidden' });
  }
  if (event.type === 'DISCARD_PAD' && ['scratchpad', 'capture'].includes(state.mode)) {
    return createDemoState(state.mode, state.attempts);
  }
  if (event.type === 'TOGGLE_NOTCH' && state.mode === 'remote' && state.notch.state !== 'idle') {
    return { ...state, notch: { ...state.notch, expanded: !state.notch.expanded } };
  }
  if (event.type === 'TOGGLE_SCRATCHPAD' && ['scratchpad', 'capture'].includes(state.mode) && state.step === 'recording') {
    return { ...state, scratchpad: { ...state.scratchpad, armed: !state.scratchpad.armed } };
  }
  if (event.type === 'IMAGE_PASTED' && state.mode === 'capture' && event.url) {
    const entry = { id: event.id, type: 'insert', kind: 'image', content: event.name || 'Pasted screenshot', url: event.url };
    const next = { ...state, scratchpad: { ...state.scratchpad, armed: true, entries: [...state.scratchpad.entries, entry] } };
    return state.step === 'ready' ? withStep(next, 'paused', { pillPhase: 'paused' }) : next;
  }

  const startable = ['ready', 'paused', 'delivered'].includes(state.step) && state.attempts.remaining > 0;
  if (state.mode !== 'remote' && event.type === 'FN_TAP') {
    if (startable) return withStep(state, 'recording', { pillPhase: 'recording', error: '' });
    if (state.step === 'recording') return withStep(state, 'processing', { pillPhase: 'processing' });
    return state;
  }
  if (state.mode === 'remote' && event.type === 'RIGHT_OPTION_TAP') {
    if (startable) return withStep(state, 'recording', { pillPhase: 'recording', error: '' });
    if (state.step === 'recording') return withStep(state, 'processing', { pillPhase: 'processing' });
    return state;
  }

  if (event.type === 'TRANSCRIPTION_FAILED' && state.step === 'processing') {
    return withStep(state, 'error', { pillPhase: 'hidden', error: event.message || 'Transcription failed. Try again.' });
  }

  if (event.type === 'TRANSCRIPTION_SUCCEEDED' && state.step === 'processing') {
    const text = String(event.text || '').trim();
    if (!text) return withStep(state, 'error', { pillPhase: 'hidden', error: 'No speech was detected. Try again.' });
    const attempts = attemptsFromEvent(state, event);

    if (state.mode === 'dictation') {
      return withStep(state, 'delivered', {
        attempts,
        pillPhase: 'output',
        note: { ...state.note, blocks: [{ type: 'text', content: text }] }
      });
    }
    if (state.mode === 'remote') {
      return withStep(state, 'working', {
        attempts,
        pillPhase: 'output',
        remote: { ...state.remote, transcript: text },
        notch: { state: 'working', expanded: false, title: 'New Unmute task', result: '' }
      });
    }

    const entries = [...state.scratchpad.entries, segment(text, state.scratchpad.entries)];
    if (!state.scratchpad.armed) {
      return withStep(state, 'delivered', {
        attempts,
        pillPhase: 'output',
        note: { ...state.note, blocks: [{ type: 'text', content: text }] }
      });
    }
    return withStep(state, 'paused', {
      attempts,
      pillPhase: 'paused',
      scratchpad: { ...state.scratchpad, entries }
    });
  }

  if (event.type === 'DELIVER_SCRATCHPAD' && ['paused', 'quota'].includes(state.step) && state.scratchpad.entries.length) {
    return deliverPad(state);
  }
  if (event.type === 'REMOTE_COMPLETE' && state.mode === 'remote' && state.step === 'working') {
    return withStep(state, 'done', {
      pillPhase: 'hidden',
      notch: { ...state.notch, state: 'done', result: event.result || 'Task demonstration complete' }
    });
  }
  if (event.type === 'CYCLE_MODEL' && state.mode === 'remote' && ['ready', 'recording'].includes(state.step)) {
    const codex = state.remote.agent === 'Claude Code';
    return { ...state, remote: { ...state.remote, agent: codex ? 'Codex' : 'Claude Code', model: codex ? 'Codex GPT-5.6' : 'Claude Sonnet 4.5' } };
  }

  return state;
}
