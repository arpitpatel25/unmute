export const DEMO_MODES = Object.freeze(['dictation', 'scratchpad', 'capture', 'remote']);

export const SCRIPT = Object.freeze({
  dictation: 'Turn these rough thoughts into a clear launch note.',
  scratchpad: [
    'The launch note should lead with speed, not features.',
    'Then explain that your words survive bad internet.'
  ],
  capture: 'Use the simple light treatment and show the real product in the page.',
  remote: 'Email Maya the launch update and tell her the beta opens Friday.'
});

const GUIDES = Object.freeze({
  dictation: {
    ready: ['Tap Fn', 'Start dictating into Notes'],
    recording: ['Tap Fn again', 'Finish this dictation'],
    processing: ['Processing', 'Unmute is turning speech into text'],
    delivered: ['Delivered', 'The words landed at the cursor']
  },
  scratchpad: {
    ready: ['Tap Fn', 'Start the first thought'],
    recording: ['Tap Scratchpad', 'Hold this instead of sending it'],
    armed: ['Tap Fn', 'Pause and keep this segment'],
    paused: ['Tap Fn', 'Continue the same scratchpad'],
    resumed: ['Tap Fn', 'Pause after the second thought'],
    review: ['Choose a destination', 'Nothing sends until you choose'],
    delivered: ['Delivered', 'Both thoughts landed together']
  },
  capture: {
    ready: ['Tap Fn', 'Start talking before you capture context'],
    recording: ['Tap Scratchpad', 'Keep speech and captured context together'],
    armed: ['Copy the link', 'Captured items land where they happened'],
    link: ['Take a screenshot', 'Use ⌘⇧4 while the mic is on'],
    image: ['Tap Fn', 'Pause and review the ordered pad'],
    review: ['Paste at cursor', 'Deliver speech, link, and image together'],
    delivered: ['Delivered', 'Every piece landed in the same order']
  },
  remote: {
    ready: ['Tap Right Option', 'Start a task for your agent'],
    recording: ['Tap Right Option again', 'Submit the spoken task'],
    working: ['Task created', 'The notch keeps the work in reach'],
    done: ['Open the notch', 'See what your agent finished']
  }
});

function guide(mode, step) {
  const [action, detail] = GUIDES[mode][step] ?? GUIDES[mode].ready;
  return { action, detail };
}

export function createDemoState(mode = 'dictation') {
  const safeMode = DEMO_MODES.includes(mode) ? mode : 'dictation';
  return {
    mode: safeMode,
    step: 'ready',
    pillPhase: 'hidden',
    guide: guide(safeMode, 'ready'),
    scratchpad: { armed: false, expanded: true, entries: [] },
    captures: [],
    note: { title: 'Launch note', blocks: [] },
    notch: { state: 'idle', expanded: false, title: '', result: '' },
    remote: { model: 'Claude Sonnet 4.5', agent: 'Claude Code', transcript: SCRIPT.remote }
  };
}

function withStep(state, step, extra = {}) {
  return { ...state, ...extra, step, guide: guide(state.mode, step) };
}

function segment(content, index) {
  return { id: `segment-${index}`, type: 'segment', kind: 'segment', content };
}

function deliverPad(state) {
  const blocks = state.scratchpad.entries.map((entry) => ({
    type: entry.kind === 'segment' ? 'text' : entry.kind === 'url' ? 'link' : 'image',
    content: entry.content
  }));
  return withStep(state, 'delivered', {
    pillPhase: 'output',
    note: { ...state.note, blocks },
    scratchpad: { armed: false, expanded: false, entries: [] }
  });
}

export function actionToEvent(action, state) {
  const events = {
    fn: { type: 'FN_TAP' },
    stop: { type: state.mode === 'remote' ? 'RIGHT_OPTION_TAP' : 'FN_TAP' },
    'right-option': { type: 'RIGHT_OPTION_TAP' },
    scratchpad: { type: 'TOGGLE_SCRATCHPAD' },
    'capture-url': { type: 'CAPTURE_URL' },
    'capture-screenshot': { type: 'CAPTURE_SCREENSHOT' },
    'deliver-cursor': { type: 'DELIVER_SCRATCHPAD', destination: 'cursor' },
    'deliver-task': { type: 'DELIVER_SCRATCHPAD', destination: 'task' },
    'toggle-notch': { type: 'TOGGLE_NOTCH' },
    'cycle-model': { type: 'CYCLE_MODEL' },
    'discard-pad': { type: 'DISCARD_PAD' },
    reset: { type: 'RESET' }
  };
  return events[action] ?? null;
}

export function transition(state, event) {
  if (!state || !event?.type) return state;

  if (event.type === 'SELECT_MODE') {
    return DEMO_MODES.includes(event.mode) ? createDemoState(event.mode) : state;
  }
  if (event.type === 'RESET') return createDemoState(state.mode);
  if (event.type === 'DISCARD_PAD' && ['scratchpad', 'capture'].includes(state.mode)) {
    return createDemoState(state.mode);
  }
  if (event.type === 'TOGGLE_NOTCH' && state.mode === 'remote' && state.notch.state !== 'idle') {
    return { ...state, notch: { ...state.notch, expanded: !state.notch.expanded } };
  }

  if (state.mode === 'dictation') {
    if (event.type === 'FN_TAP' && state.step === 'ready') {
      return withStep(state, 'recording', { pillPhase: 'recording' });
    }
    if (event.type === 'FN_TAP' && state.step === 'recording') {
      return withStep(state, 'processing', { pillPhase: 'processing' });
    }
    if (event.type === 'PROCESSING_DONE' && state.step === 'processing') {
      return withStep(state, 'delivered', {
        pillPhase: 'output',
        note: { ...state.note, blocks: [{ type: 'text', content: SCRIPT.dictation }] }
      });
    }
    return state;
  }

  if (state.mode === 'scratchpad') {
    if (event.type === 'FN_TAP' && state.step === 'ready') {
      return withStep(state, 'recording', { pillPhase: 'recording' });
    }
    if (event.type === 'TOGGLE_SCRATCHPAD' && state.step === 'recording') {
      return withStep(state, 'armed', {
        scratchpad: { ...state.scratchpad, armed: true }
      });
    }
    if (event.type === 'FN_TAP' && state.step === 'armed') {
      return withStep(state, 'paused', {
        pillPhase: 'paused',
        scratchpad: { ...state.scratchpad, entries: [segment(SCRIPT.scratchpad[0], 1)] }
      });
    }
    if (event.type === 'FN_TAP' && state.step === 'paused') {
      return withStep(state, 'resumed', { pillPhase: 'recording' });
    }
    if (event.type === 'FN_TAP' && state.step === 'resumed') {
      return withStep(state, 'review', {
        pillPhase: 'paused',
        scratchpad: {
          ...state.scratchpad,
          entries: [...state.scratchpad.entries, segment(SCRIPT.scratchpad[1], 2)]
        }
      });
    }
    if (event.type === 'DELIVER_SCRATCHPAD' && state.step === 'review') return deliverPad(state);
    return state;
  }

  if (state.mode === 'capture') {
    if (event.type === 'FN_TAP' && state.step === 'ready') {
      return withStep(state, 'recording', { pillPhase: 'recording' });
    }
    if (event.type === 'TOGGLE_SCRATCHPAD' && state.step === 'recording') {
      return withStep(state, 'armed', {
        scratchpad: { ...state.scratchpad, armed: true, entries: [segment(SCRIPT.capture, 1)] }
      });
    }
    if (event.type === 'CAPTURE_URL' && state.step === 'armed') {
      const entry = { id: 'capture-url', type: 'insert', kind: 'url', content: 'https://conductor.build' };
      return withStep(state, 'link', {
        captures: [...state.captures, entry],
        scratchpad: { ...state.scratchpad, entries: [...state.scratchpad.entries, entry] }
      });
    }
    if (event.type === 'CAPTURE_SCREENSHOT' && state.step === 'link') {
      const entry = { id: 'capture-image', type: 'insert', kind: 'image', content: 'unmute-demo-capture.png' };
      return withStep(state, 'image', {
        captures: [...state.captures, entry],
        scratchpad: { ...state.scratchpad, entries: [...state.scratchpad.entries, entry] }
      });
    }
    if (event.type === 'FN_TAP' && state.step === 'image') {
      return withStep(state, 'review', { pillPhase: 'paused' });
    }
    if (event.type === 'DELIVER_SCRATCHPAD' && state.step === 'review') return deliverPad(state);
    return state;
  }

  if (state.mode === 'remote') {
    if (event.type === 'CYCLE_MODEL' && ['ready', 'recording'].includes(state.step)) {
      return {
        ...state,
        remote: {
          ...state.remote,
          model: state.remote.model === 'Claude Sonnet 4.5' ? 'Codex GPT-5.6' : 'Claude Sonnet 4.5',
          agent: state.remote.model === 'Claude Sonnet 4.5' ? 'Codex' : 'Claude Code'
        }
      };
    }
    if (event.type === 'RIGHT_OPTION_TAP' && state.step === 'ready') {
      return withStep(state, 'recording', { pillPhase: 'recording' });
    }
    if (event.type === 'RIGHT_OPTION_TAP' && state.step === 'recording') {
      return withStep(state, 'working', {
        pillPhase: 'processing',
        notch: { state: 'working', expanded: false, title: 'Send launch update', result: '' }
      });
    }
    if (event.type === 'REMOTE_CREATED' && state.step === 'working') {
      return { ...state, pillPhase: 'output' };
    }
    if (event.type === 'REMOTE_COMPLETE' && state.step === 'working') {
      return withStep(state, 'done', {
        pillPhase: 'hidden',
        notch: { ...state.notch, state: 'done', result: 'Email sent successfully' }
      });
    }
    return state;
  }

  return state;
}
