import { actionToEvent, createDemoState, transition } from './demo-state.js';
import { createRecorder } from './demo-recorder.js';
import { createTranscriptionClient } from './demo-transcription.js';
import { renderDemo } from './demo-view.js';

const root = document.querySelector('[data-demo-root]');

if (root) {
  let state = createDemoState('dictation');
  const recorder = createRecorder();
  const endpoint = root.dataset.sttEndpoint || '/v1/demo/stt';
  const transcription = createTranscriptionClient({ endpoint });
  const imageUrls = new Set();
  let remoteTimer = null;
  let busy = false;

  const render = () => { root.innerHTML = renderDemo(state); };
  const reduce = (event) => { state = transition(state, event); render(); };

  function clearRemoteTimer() {
    if (remoteTimer) window.clearTimeout(remoteTimer);
    remoteTimer = null;
  }

  function revokeImages() {
    imageUrls.forEach((url) => URL.revokeObjectURL(url));
    imageUrls.clear();
  }

  async function enableMicrophone() {
    if (busy) return;
    busy = true;
    try {
      await recorder.requestPermission();
      recorder.cancel();
      reduce({ type: 'PERMISSION_GRANTED' });
    } catch (error) {
      reduce({ type: 'PERMISSION_DENIED', message: error?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in your browser settings, then retry.'
        : error?.message });
    } finally {
      busy = false;
    }
  }

  async function beginRecording(event) {
    if (busy || state.attempts.remaining === 0) return;
    const next = transition(state, event);
    if (next.step !== 'recording' || state.step === 'recording') return;
    state = next;
    render();
    busy = true;
    try {
      await recorder.start();
    } catch (error) {
      reduce({ type: 'PERMISSION_DENIED', message: error?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in your browser settings, then retry.'
        : error?.message });
    } finally {
      busy = false;
    }
  }

  async function stopAndTranscribe(event) {
    if (busy || state.step !== 'recording') return;
    state = transition(state, event);
    render();
    busy = true;
    try {
      const recording = await recorder.stop();
      const result = await transcription.transcribe({
        ...recording,
        flowType: state.mode
      });
      reduce({ type: 'TRANSCRIPTION_SUCCEEDED', ...result });
      if (state.mode === 'remote' && state.step === 'working') {
        remoteTimer = window.setTimeout(() => {
          reduce({ type: 'REMOTE_COMPLETE', result: 'Task demonstration complete' });
        }, 2400);
      }
    } catch (error) {
      reduce({ type: 'TRANSCRIPTION_FAILED', message: error?.message });
    } finally {
      busy = false;
    }
  }

  async function activate(event) {
    if (!event) return;
    if (event.type === 'FN_TAP' || event.type === 'RIGHT_OPTION_TAP') {
      if (state.step === 'recording') await stopAndTranscribe(event);
      else await beginRecording(event);
      return;
    }
    if (event.type === 'RESET' || event.type === 'DISCARD_PAD') revokeImages();
    reduce(event);
  }

  function acceptImage(file) {
    if (state.mode !== 'capture' || !file?.type?.startsWith('image/')) return false;
    const url = URL.createObjectURL(file);
    imageUrls.add(url);
    reduce({
      type: 'IMAGE_PASTED',
      id: globalThis.crypto?.randomUUID?.() || `image-${Date.now()}`,
      url,
      name: file.name || 'Pasted screenshot'
    });
    return true;
  }

  root.addEventListener('click', async (event) => {
    const mode = event.target.closest('[data-demo-mode]');
    if (mode) {
      clearRemoteTimer();
      recorder.cancel();
      revokeImages();
      reduce({ type: 'SELECT_MODE', mode: mode.dataset.demoMode });
      return;
    }
    const control = event.target.closest('[data-action]');
    if (!control) return;
    if (control.dataset.action === 'enable-mic') {
      await enableMicrophone();
      return;
    }
    await activate(actionToEvent(control.dataset.action, state));
  });

  root.addEventListener('keydown', (event) => {
    if (!event.target.matches('[role="tab"]')) return;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    tabs[(index + delta + tabs.length) % tabs.length]?.click();
  });

  document.addEventListener('keydown', async (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || state.permission !== 'granted') return;
    if (event.target.matches('input, textarea, [contenteditable]')) return;
    if (state.mode !== 'remote' && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      await activate({ type: 'FN_TAP' });
    } else if (state.mode === 'remote' && event.key === 'Alt' && event.location === 2) {
      event.preventDefault();
      await activate({ type: 'RIGHT_OPTION_TAP' });
    }
  });

  document.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith('image/'));
    if (acceptImage(file)) event.preventDefault();
  });

  root.addEventListener('dragover', (event) => {
    if (state.mode === 'capture' && [...(event.dataTransfer?.items || [])].some((item) => item.type.startsWith('image/'))) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  root.addEventListener('drop', (event) => {
    const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith('image/'));
    if (acceptImage(file)) event.preventDefault();
  });

  window.addEventListener('beforeunload', () => {
    recorder.cancel();
    revokeImages();
  });

  render();
}
