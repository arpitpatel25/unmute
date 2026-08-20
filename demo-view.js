import { DEMO_MODES, SCRIPT } from './demo-state.js';

const MODE_LABELS = {
  dictation: ['Dictation', 'Voice → text'],
  scratchpad: ['Scratchpad', 'Pause. Continue. Choose.'],
  capture: ['Capture', 'Speech + context'],
  remote: ['Unmute Remote', 'Voice → task']
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
  if (state.note.blocks.length === 0) {
    return `<p class="note-placeholder"><span class="note-caret"></span></p>`;
  }
  return state.note.blocks.map((block) => {
    if (block.type === 'link') {
      return `<p class="note-link"><span aria-hidden="true">🔗</span> <a href="${esc(block.content)}" tabindex="-1">${esc(block.content)}</a></p>`;
    }
    if (block.type === 'image') {
      return `<figure class="note-capture"><div class="capture-preview" aria-label="Captured screenshot preview">
        <span class="capture-window-bar"><i></i><i></i><i></i></span>
        <span class="capture-preview-copy"><b>Put the real product in the page.</b><em>Landing page reference</em></span>
      </div><figcaption>${esc(block.content)}</figcaption></figure>`;
    }
    return `<p>${esc(block.content)}</p>`;
  }).join('');
}

function notesSurface(state) {
  return `<div class="notes-app" data-surface="notes">
    <div class="notes-toolbar">
      <div class="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div>
      <button class="notes-sidebar-toggle" tabindex="-1" aria-label="Toggle sidebar">▥</button>
      <div class="notes-tools" aria-hidden="true"><span>⌫</span><span>↗</span><span>•••</span></div>
    </div>
    <div class="notes-body">
      <aside class="notes-sidebar" aria-label="Notes folders">
        <div class="notes-sidebar-label">iCloud</div>
        <div><span>▣</span> All iCloud <b>24</b></div>
        <div class="selected"><span>▤</span> Notes <b>18</b></div>
        <div><span>🗑</span> Recently Deleted</div>
      </aside>
      <section class="note-editor" aria-label="Quick Note">
        <time>20 August 2026 at 9:41 PM</time>
        <h2>${esc(state.note.title)}</h2>
        <div class="note-content">${noteBlocks(state)}</div>
      </section>
    </div>
  </div>`;
}

function waveform() {
  return `<span class="waveform" aria-hidden="true">${[3, 7, 12, 6, 16, 9, 4, 13, 8, 2, 10, 5, 14, 7, 3, 9, 5, 2].map((h) => `<i style="--h:${h}px"></i>`).join('')}</span>`;
}

function pillCore(state) {
  if (state.pillPhase === 'hidden') return '';
  if (state.pillPhase === 'output') {
    return `<span class="pill-core pill-output" data-pill-phase="output" aria-label="Delivered">✓</span>`;
  }
  if (state.pillPhase === 'paused') {
    return `<span class="pill-core pill-paused" data-pill-phase="paused"><i></i><span>Paused</span></span>`;
  }
  if (state.pillPhase === 'processing') {
    return `<span class="pill-core pill-processing" data-pill-phase="processing"><i></i><span>Processing</span><b aria-hidden="true"><i></i><i></i><i></i></b></span>`;
  }
  return `<span class="pill-core pill-recording" data-pill-phase="recording">
    ${state.mode === 'remote' ? '<span class="remote-glyph" aria-label="Remote">⌁</span>' : '<i class="record-dot"></i>'}
    ${waveform()}
    <button class="pill-stop" type="button" data-action="stop" aria-label="Stop and submit"><i></i></button>
  </span>`;
}

function agentModel(state) {
  if (state.mode !== 'remote' || !['recording', 'processing'].includes(state.pillPhase)) return '';
  return `<button class="agent-model-control" type="button" data-action="cycle-model" aria-label="Agent and model: ${esc(state.remote.agent)}, ${esc(state.remote.model)}">
    <span class="agent-half"><i class="agent-mark">C</i><b>${esc(state.remote.agent)}</b></span>
    <span class="model-half"><b>${esc(state.remote.model)}</b><i>⌄</i></span>
  </button>`;
}

function scratchpadChip(state) {
  const visible = ['scratchpad', 'capture'].includes(state.mode) && state.pillPhase !== 'hidden' && state.pillPhase !== 'output';
  if (!visible) return '';
  return `<button class="scratchpad-chip ${state.scratchpad.armed ? 'is-armed' : ''}" type="button" data-action="scratchpad" aria-pressed="${state.scratchpad.armed}" aria-label="${state.scratchpad.armed ? 'Disarm' : 'Arm'} Scratchpad">
    <span class="nib" aria-hidden="true">✎</span><span>Scratchpad</span>
  </button>`;
}

function scratchpadEntries(state) {
  return state.scratchpad.entries.map((entry) => {
    const icon = entry.kind === 'url' ? '↗' : entry.kind === 'image' ? '▧' : '›';
    const duration = entry.kind === 'segment' ? '<time>0:07</time>' : '';
    return `<div class="scratchpad-entry" data-entry-kind="${entry.kind}"><span>${icon}</span><p>${esc(entry.content)}</p>${duration}<button type="button" tabindex="-1" aria-label="Remove item">×</button></div>`;
  }).join('');
}

function scratchpadPaper(state) {
  const visible = state.scratchpad.entries.length > 0;
  return `<aside class="scratchpad-wrap ${visible ? 'is-visible' : ''}" data-surface="scratchpad" aria-hidden="${!visible}">
    ${visible ? `<div class="scratchpad-paper">
      <header><span class="nib">✎</span><strong>Scratchpad</strong><small>${state.scratchpad.armed ? 'keeping' : 'held'}</small><span>⌄</span></header>
      <div class="scratchpad-list">${scratchpadEntries(state)}</div>
      <footer>
        <button type="button" data-action="deliver-cursor" class="pad-primary">Paste at cursor</button>
        <button type="button" data-action="deliver-task">New task</button>
        <button type="button" data-action="discard-pad" class="pad-discard">Discard</button>
      </footer>
    </div>` : ''}
  </aside>`;
}

function pillSurface(state) {
  const visible = state.pillPhase !== 'hidden' || state.scratchpad.entries.length > 0;
  return `<div class="input-surface ${visible ? 'is-visible' : ''}" data-surface="pill">
    <div class="pill-balance" aria-hidden="true"></div>
    <div class="pill-cluster">${agentModel(state)}${pillCore(state)}${scratchpadChip(state)}</div>
    ${scratchpadPaper(state)}
  </div>`;
}

function notchSurface(state) {
  const active = state.notch.state !== 'idle';
  const status = state.notch.state === 'done' ? 'Done' : 'Working';
  return `<button class="unmute-notch ${active ? 'is-active' : ''} ${state.notch.expanded ? 'is-expanded' : ''}" type="button" data-action="toggle-notch" data-surface="notch" data-notch-state="${state.notch.state}" aria-label="Unmute notch" aria-expanded="${state.notch.expanded}" ${active ? '' : 'tabindex="-1"'}>
    <span class="hardware-notch" aria-hidden="true"></span>
    ${active ? `<span class="notch-bar">
      <span class="notch-identity"><i class="status-dot"></i><span class="un-mark">un</span><strong>${esc(state.notch.title)}</strong></span>
      <span class="notch-status">${status}</span>
    </span>` : ''}
    ${active && state.notch.expanded ? `<span class="notch-task-surface">
      <span class="task-header"><span><i class="status-dot"></i><span class="agent-mark">C</span><strong>${esc(state.notch.title)}</strong></span><em>${status}</em></span>
      <span class="task-prompt">“${esc(SCRIPT.remote)}”</span>
      <span class="task-result ${state.notch.state === 'done' ? 'is-done' : ''}"><i>${state.notch.state === 'done' ? '✓' : ''}</i><span><strong>${state.notch.state === 'done' ? esc(state.notch.result) : 'Working in Mail'}</strong><small>${state.notch.state === 'done' ? 'The launch update was sent to Maya.' : 'Preparing the message and checking the recipient.'}</small></span></span>
    </span>` : ''}
  </button>`;
}

function guideControls(state) {
  const remote = state.mode === 'remote';
  const complete = state.step === 'delivered' || state.step === 'done';
  return `<div class="demo-guide" aria-live="polite">
    <div class="guide-copy"><span class="guide-step">${complete ? 'Complete' : 'Your turn'}</span><strong>${esc(state.guide.action)}</strong><small>${esc(state.guide.detail)}</small></div>
    <div class="guide-actions">
      ${remote ? '<button class="keycap" type="button" data-action="right-option"><span>⌥</span> Right Option</button>' : '<button class="keycap" type="button" data-action="fn"><span>fn</span></button>'}
      ${state.mode === 'capture' && state.step === 'armed' ? '<button class="context-key" type="button" data-action="capture-url"><span>⌘C</span> Copy link</button>' : ''}
      ${state.mode === 'capture' && state.step === 'link' ? '<button class="context-key" type="button" data-action="capture-screenshot"><span>⌘⇧4</span> Screenshot</button>' : ''}
      ${complete ? '<button class="replay-button" type="button" data-action="reset">↻ Replay</button>' : ''}
    </div>
  </div>`;
}

export function renderDemo(state) {
  return `<div class="unmute-demo" data-mode="${state.mode}">
    <div class="demo-tabs" role="tablist" aria-label="Choose a product demo">${modeTabs(state)}</div>
    <div class="macbook-stage">
      <div class="macbook">
        <div class="macbook-display">
          <div class="macbook-screen">
            ${notesSurface(state)}
            ${notchSurface(state)}
            ${pillSurface(state)}
          </div>
        </div>
        <div class="macbook-base"><span></span></div>
      </div>
    </div>
    ${guideControls(state)}
    <p class="demo-keyboard-note">Use the controls above or press <kbd>${state.mode === 'remote' ? 'Alt' : 'F'}</kbd> on your keyboard.</p>
  </div>`;
}
