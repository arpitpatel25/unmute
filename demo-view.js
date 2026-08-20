import { DEMO_MODES } from './demo-state.js';

const MODE_LABELS = {
  dictation: ['Dictation', 'Voice → text'],
  scratchpad: ['Scratchpad', 'Pause. Continue. Choose.'],
  capture: ['Capture', 'Speech + pasted context'],
  remote: ['Unmute Remote', 'Voice → task demo']
};

function esc(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function modeTabs(state) {
  return DEMO_MODES.map((mode, index) => {
    const [title, detail] = MODE_LABELS[mode];
    const active = state.mode === mode;
    return `<button class="demo-tab" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-demo-mode="${mode}">
      <span class="demo-tab-number">0${index + 1}</span>
      <span><strong>${title}</strong><small>${detail}</small></span>
    </button>`;
  }).join('');
}

function noteBlocks(state) {
  if (!state.note.blocks.length) return '<p class="note-placeholder"><span class="note-caret"></span></p>';
  return state.note.blocks.map((block) => {
    if (block.type === 'image') {
      return `<figure class="note-capture"><img src="${esc(block.url)}" alt="${esc(block.content)}"><figcaption>${esc(block.content)}</figcaption></figure>`;
    }
    return `<p>${esc(block.content)}</p>`;
  }).join('');
}

function notesSurface(state) {
  return `<div class="notes-app" data-surface="notes">
    <div class="notes-toolbar"><div class="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div><button class="notes-sidebar-toggle" tabindex="-1" aria-label="Toggle sidebar">▥</button><div class="notes-tools" aria-hidden="true"><span>⌫</span><span>↗</span><span>•••</span></div></div>
    <div class="notes-body">
      <aside class="notes-sidebar" aria-label="Notes folders"><div class="notes-sidebar-label">iCloud</div><div><span>▣</span> All iCloud <b>24</b></div><div class="selected"><span>▤</span> Notes <b>18</b></div><div><span>⌫</span> Recently Deleted</div></aside>
      <section class="note-editor" aria-label="Quick Note"><time>20 August 2026 at 9:41 PM</time><h2>${esc(state.note.title)}</h2><div class="note-content">${noteBlocks(state)}</div></section>
    </div>
  </div>`;
}

function waveform() {
  return `<span class="waveform" aria-hidden="true">${[3, 7, 12, 6, 16, 9, 4, 13, 8, 2, 10, 5, 14, 7, 3, 9, 5, 2].map((h) => `<i style="--h:${h}px"></i>`).join('')}</span>`;
}

function pillCore(state) {
  if (state.pillPhase === 'hidden') return '';
  if (state.pillPhase === 'output') return '<span class="pill-core pill-output" data-pill-phase="output" aria-label="Delivered">✓</span>';
  if (state.pillPhase === 'paused') return '<span class="pill-core pill-paused" data-pill-phase="paused"><i></i><span>Paused</span></span>';
  if (state.pillPhase === 'processing') return '<span class="pill-core pill-processing" data-pill-phase="processing"><i></i><span>Transcribing</span><b aria-hidden="true"><i></i><i></i><i></i></b></span>';
  return `<span class="pill-core pill-recording" data-pill-phase="recording">${state.mode === 'remote' ? '<span class="remote-glyph" aria-label="Remote">⌁</span>' : '<i class="record-dot"></i>'}${waveform()}<button class="pill-stop" type="button" data-action="stop" aria-label="Stop and transcribe"><i></i></button></span>`;
}

function agentModel(state) {
  if (state.mode !== 'remote' || state.pillPhase !== 'recording') return '';
  return `<button class="agent-model-control" type="button" data-action="cycle-model" aria-label="Agent and model: ${esc(state.remote.agent)}, ${esc(state.remote.model)}"><span class="agent-half"><i class="agent-mark">${state.remote.agent === 'Codex' ? 'O' : 'C'}</i><b>${esc(state.remote.agent)}</b></span><span class="model-half"><b>${esc(state.remote.model)}</b><i>⌄</i></span></button>`;
}

function scratchpadChip(state) {
  if (!['scratchpad', 'capture'].includes(state.mode) || state.step !== 'recording') return '';
  return `<button class="scratchpad-chip ${state.scratchpad.armed ? 'is-armed' : ''}" type="button" data-action="scratchpad" aria-pressed="${state.scratchpad.armed}"><span class="nib" aria-hidden="true">✎</span><span>Scratchpad</span></button>`;
}

function scratchpadEntries(state) {
  return state.scratchpad.entries.map((entry) => {
    if (entry.kind === 'image') {
      return `<div class="scratchpad-entry scratchpad-image" data-entry-kind="image"><img src="${esc(entry.url)}" alt="${esc(entry.content)}"><p>${esc(entry.content)}</p></div>`;
    }
    return `<div class="scratchpad-entry" data-entry-kind="segment"><span>›</span><p>${esc(entry.content)}</p></div>`;
  }).join('');
}

function pasteZone(state) {
  if (state.mode !== 'capture') return '';
  return `<div class="paste-zone" data-paste-zone tabindex="0"><span class="paste-icon">⌘V</span><span><strong>Paste with ⌘V or drop a screenshot</strong><small>No clipboard or screen permission is requested.</small></span></div>`;
}

function scratchpadPaper(state) {
  const visible = state.scratchpad.entries.length > 0;
  return `<aside class="scratchpad-wrap ${visible ? 'is-visible' : ''}" data-surface="scratchpad" aria-hidden="${!visible}">${visible ? `<div class="scratchpad-paper"><header><span class="nib">✎</span><strong>Scratchpad</strong><small>held on this page</small><span>⌄</span></header><div class="scratchpad-list">${scratchpadEntries(state)}</div><footer><button type="button" data-action="deliver-cursor" class="pad-primary">Paste at cursor</button><button type="button" data-action="discard-pad" class="pad-discard">Discard</button></footer></div>` : ''}</aside>`;
}

function pillSurface(state) {
  const visible = state.pillPhase !== 'hidden' || state.scratchpad.entries.length > 0;
  return `<div class="input-surface ${visible ? 'is-visible' : ''}" data-surface="pill"><div class="pill-balance" aria-hidden="true"></div><div class="pill-cluster">${agentModel(state)}${pillCore(state)}${scratchpadChip(state)}</div>${scratchpadPaper(state)}</div>`;
}

function notchSurface(state) {
  const active = state.notch.state !== 'idle';
  const status = state.notch.state === 'done' ? 'Done' : 'Working';
  return `<button class="unmute-notch ${active ? 'is-active' : ''} ${state.notch.expanded ? 'is-expanded' : ''}" type="button" data-action="toggle-notch" data-surface="notch" data-notch-state="${state.notch.state}" aria-label="Unmute notch" aria-expanded="${state.notch.expanded}" ${active ? '' : 'tabindex="-1"'}><span class="hardware-notch" aria-hidden="true"></span>${active ? `<span class="notch-bar"><span class="notch-identity"><i class="status-dot"></i><span class="un-mark">un</span><strong>${esc(state.notch.title)}</strong></span><span class="notch-status">${status}</span></span>` : ''}${active && state.notch.expanded ? `<span class="notch-task-surface"><span class="task-header"><span><i class="status-dot"></i><span class="agent-mark">${state.remote.agent === 'Codex' ? 'O' : 'C'}</span><strong>Task demonstration</strong></span><em>${status}</em></span><span class="task-prompt">“${esc(state.remote.transcript)}”</span><span class="task-result ${state.notch.state === 'done' ? 'is-done' : ''}"><i>${state.notch.state === 'done' ? '✓' : ''}</i><span><strong>${esc(state.notch.result || 'Showing how progress stays in reach')}</strong><small>This web demo does not run an agent on your Mac.</small></span></span></span>` : ''}</button>`;
}

function guideControls(state) {
  const remaining = state.attempts.remaining;
  let controls = '';
  if (state.step === 'quota') {
    controls = '<span class="quota-reached">Demo limit reached</span>';
  } else if (state.permission !== 'granted') {
    controls = '<button class="enable-mic" type="button" data-action="enable-mic"><span>●</span> Enable microphone</button>';
  } else if (state.step === 'error') {
    controls = '<button class="replay-button" type="button" data-action="retry">Retry</button>';
  } else if (state.step !== 'recording' && state.step !== 'processing' && state.step !== 'working') {
    controls = state.mode === 'remote'
      ? '<button class="keycap" type="button" data-action="right-option"><span>⌥</span> Start task</button>'
      : '<button class="keycap" type="button" data-action="fn"><span>fn</span> Start recording</button>';
  }
  if (['delivered', 'done'].includes(state.step)) controls += '<button class="replay-button" type="button" data-action="reset">Clear</button>';

  return `<div class="demo-guide" aria-live="polite"><div class="guide-copy"><span class="guide-step">${state.step === 'error' ? 'Recording failed' : 'Live demo'}</span><strong>${esc(state.guide.action)}</strong><small>${esc(state.guide.detail)}</small></div><div class="guide-actions">${controls}</div><div class="demo-privacy"><strong>${remaining} free transcription${remaining === 1 ? '' : 's'} left</strong><span>Audio is sent to Unmute only when you record.</span></div>${state.error ? `<p class="demo-error" role="alert">${esc(state.error)}</p>` : ''}</div>`;
}

export function renderDemo(state) {
  return `<div class="unmute-demo" data-mode="${state.mode}" data-step="${state.step}"><div class="demo-tabs" role="tablist" aria-label="Choose a product demo">${modeTabs(state)}</div><div class="macbook-stage"><div class="macbook"><div class="macbook-display"><div class="macbook-screen">${notesSurface(state)}${notchSurface(state)}${pillSurface(state)}${pasteZone(state)}</div></div><div class="macbook-base"><span></span></div></div></div>${guideControls(state)}</div>`;
}
