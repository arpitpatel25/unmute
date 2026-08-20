import { actionToEvent, createDemoState, transition } from './demo-state.js';
import { renderDemo } from './demo-view.js';

const root = document.querySelector('[data-demo-root]');

if (root) {
  let state = createDemoState('dictation');
  let timers = [];

  const clearTimers = () => {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers = [];
  };

  const later = (event, delay) => {
    timers.push(window.setTimeout(() => {
      state = transition(state, event);
      render();
    }, delay));
  };

  const scheduleAutomaticStates = (event) => {
    if (event.type === 'FN_TAP' && state.mode === 'dictation' && state.step === 'processing') {
      later({ type: 'PROCESSING_DONE' }, 850);
    }
    if (event.type === 'RIGHT_OPTION_TAP' && state.mode === 'remote' && state.step === 'working') {
      later({ type: 'REMOTE_CREATED' }, 650);
      later({ type: 'REMOTE_COMPLETE' }, 2600);
    }
  };

  const dispatch = (event) => {
    if (!event) return;
    if (event.type === 'SELECT_MODE' || event.type === 'RESET') clearTimers();
    state = transition(state, event);
    render();
    scheduleAutomaticStates(event);
  };

  const render = () => {
    root.innerHTML = renderDemo(state);
  };

  root.addEventListener('click', (event) => {
    const mode = event.target.closest('[data-demo-mode]');
    if (mode) {
      dispatch({ type: 'SELECT_MODE', mode: mode.dataset.demoMode });
      return;
    }
    const control = event.target.closest('[data-action]');
    if (control) dispatch(actionToEvent(control.dataset.action, state));
  });

  root.addEventListener('keydown', (event) => {
    if (!event.target.matches('[role="tab"]')) return;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    dispatch({ type: 'SELECT_MODE', mode: next.dataset.demoMode });
    root.querySelector(`[data-demo-mode="${next.dataset.demoMode}"]`)?.focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.target.matches('input, textarea, [contenteditable]')) return;
    if (state.mode !== 'remote' && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      dispatch({ type: 'FN_TAP' });
    }
    if (state.mode === 'remote' && event.key === 'Alt') {
      event.preventDefault();
      dispatch({ type: 'RIGHT_OPTION_TAP' });
    }
  });

  render();
}
