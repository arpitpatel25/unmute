// Every UI state the landing page shows, as fixtures for the REAL notch helper.
// `node scenes.mjs` writes fixtures/scene-*.json; `node capture-all.mjs` runs them.
//
// Nothing here is a drawing: each shot is what unmute-notch renders when main
// sends it this payload. Payload shapes follow IPC.swift / PillModel.swift /
// ScratchpadModel.swift at unmute-cloud HEAD; label strings follow
// providers.ts ("Claude Code CLI", "Codex CLI") and init.ts (agent lane =
// "Unmute Agent", blank option lists).
import { writeFileSync, mkdirSync } from 'node:fs'

const dir = new URL('./fixtures/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })

const agents = [
  { id: 'claude', label: 'Claude Code CLI', available: true, terminal: false },
  { id: 'codex', label: 'Codex CLI', available: true, terminal: false },
]
const claudeModels = [{ id: 'opus', label: 'Opus', detail: '' }, { id: 'sonnet', label: 'Sonnet', detail: '' }]

const pill = (state) => ({ type: 'pill', state })
const hide = pill({ phase: 'hidden' })
const fnRec = pill({ phase: 'recording', kind: 'dictation', level: 0, elapsed: 3 })
const fnProc = pill({ phase: 'processing', kind: 'dictation' })
const fnOut = pill({ phase: 'output', kind: 'dictation' })
const orchestrator = { kind: 'remote', agent: 'Claude Code CLI', agentConnected: true, model: 'Opus',
  agentOptions: agents, modelOptions: claudeModels, modelAxes: [] }
const roptRec = pill({ phase: 'recording', level: 0, elapsed: 2, canType: true, ...orchestrator })
const roptProc = pill({ phase: 'processing', ...orchestrator })
const agentLane = { kind: 'remote', agent: 'Unmute Agent', agentConnected: true, agentOptions: [], modelOptions: [], modelAxes: [] }
const agentRec = pill({ phase: 'recording', level: 0, elapsed: 2, canType: true, ...agentLane })
const agentProc = pill({ phase: 'processing', ...agentLane })
const state = (s, working = 0, attention = 0) => ({ type: 'setState', state: s, attention, working })
const activity = (s, summary = '') => ({ type: 'agentActivity', activity: { state: s, summary, interactionId: 'i1', agentRunId: 'r1', provider: 'claude' } })
const phase = (p) => ({ type: 'capturePhase', phase: p })

const slots = [
  { id: 'unmute-agent', title: 'Unmute Agent', kind: 'agent', status: 'ready', demanding: false },
  { id: 't-landing', title: 'landing page', status: 'processing', demanding: false, backend: 'claude', terminal: false },
  { id: 't-auth', title: 'auth service', status: 'needs-user', ask: 'Should the refresh retry on a 401?', demanding: true, backend: 'codex', terminal: false },
  { id: 't-csv', title: 'csv parser', status: 'done', demanding: false, backend: 'claude', terminal: false },
]
const pocket = (mode, at, s = slots, waiting = 1) => ({ type: 'pocket', data: { mode, at, waiting, remoteKey: 'fn', slots: s } })

const scene = (name, steps, extra = {}) =>
  writeFileSync(`${dir}scene-${name}.json`, JSON.stringify({ fakeNotch: '200x34', region: true, fill: 0.45, steps, ...extra }, null, 1))
const shot = (name, send, wait = 900) => ({ send, wait, shot: name })

// ── BAR + PILL: the two things that are on screen in almost every scene ──────
scene('core', [
  shot('pill-fn-rec', [state('dormant'), fnRec]),
  shot('pill-fn-proc', [fnProc]),
  shot('pill-fn-out', [fnOut], 500),
  shot('pill-ropt-rec', [hide, roptRec]),
  shot('pill-ropt-proc', [roptProc]),
  shot('bar-sending', [hide, phase('routing')]),
  shot('bar-working1', [phase('idle'), state('active', 1)]),
  shot('bar-working2', [state('active', 2)]),
  shot('bar-working4', [state('active', 4)]),
  shot('pill-agent-rec', [state('dormant'), agentRec]),
  shot('pill-agent-proc', [agentProc]),
  shot('bar-agent-listening', [hide, state('idle'), activity('listening')], 600),
  shot('bar-agent-searching', [activity('searching')], 600),
  shot('bar-agent-thinking', [activity('thinking')], 600),
  shot('bar-agent-done', [activity('complete', 'Saved')], 600),
  shot('bar-inpocket', [state('idle'), { type: 'pocketLanded', title: 'landing page' }], 700),
  shot('bar-needsyou', [pocket('closed', 0), state('attention', 1, 1)]),
])

// ── POCKET: every session in the notch; talk into one without opening it ────
scene('pocket', [
  shot('pocket-closed', [state('idle', 1), pocket('closed', 0)]),
  shot('pocket-open-landing', [pocket('open', 1)], 1100),
  shot('pocket-open-auth', [pocket('open', 2)], 1100),
  shot('pocket-open-csv', [pocket('open', 3)], 1100),
  shot('pocket-aimed', [pocket('open', 2), phase('listening'),
    pill({ phase: 'recording', level: 0, elapsed: 2, taskId: 't-auth', kind: 'remote', agent: 'Codex CLI', agentConnected: true,
      agentOptions: agents, modelOptions: [], modelAxes: [], modelEmpty: 'Settings are managed in the original application' })], 1100),
  shot('pocket-sent', [hide, phase('routing'),
    pocket('open', 2, slots.map((s) => s.id === 't-auth' ? { ...s, status: 'processing', ask: null, demanding: false } : s), 0)], 1100),
])

// ── SCRATCHPAD + CAPTURE ──────────────────────────────────────────────────────
const seg = (id, text, s, e) => ({ id, type: 'segment', text, startMs: s, endMs: e })
const img = (id, name) => ({ id, type: 'insert', kind: 'image', content: `/Users/you/Library/Caches/unmute/${name}` })
const pad = (entries, extra = {}) => ({ type: 'scratchpad', data: { enabled: true, armed: true,
  pad: { id: 'p1', origin: 'task', entries }, destinations: { openTask: { id: 't-auth', name: 'auth service' } }, ...extra } })
const fnRecAimedPad = pill({ phase: 'recording', kind: 'dictation', level: 0, elapsed: 4 })
scene('scratch', [
  shot('pill-flash', [state('dormant'), roptRec, pill({ phase: 'recording', level: 0, elapsed: 3, canType: true, captureFlashToken: 1, ...orchestrator })], 70),
  shot('pill-scratch-rec', [hide, { type: 'scratchpad', data: { enabled: true, armed: true } }, fnRecAimedPad], 900),
  shot('pad-1', [pad([seg('e1', '', 0, 0)])], 900),
  shot('pad-2', [pad([seg('e1', 'No null check here before the token is refreshed', 0, 4200)])], 900),
  shot('pad-3', [pad([seg('e1', 'No null check here before the token is refreshed', 0, 4200),
    seg('e2', "Also, where's the retry limit?", 9000, 15400)])], 900),
  shot('pad-4', [pad([seg('e1', 'No null check here before the token is refreshed', 0, 4200),
    seg('e2', "Also, where's the retry limit?", 9000, 15400), img('e3', 'Unmute-2026-09-29-refresh.png')])], 900),
  shot('pad-5', [pad([seg('e1', 'No null check here before the token is refreshed', 0, 4200),
    seg('e2', "Also, where's the retry limit?", 9000, 15400), img('e3', 'Unmute-2026-09-29-refresh.png'),
    seg('e4', 'And the error path swallows the 401 instead of surfacing it', 31000, 37600)])], 900),
  shot('pill-paused', [pill({ phase: 'paused', kind: 'dictation' })], 900),
  shot('pad-sending', [pad([seg('e1', 'No null check here before the token is refreshed', 0, 4200),
    seg('e2', "Also, where's the retry limit?", 9000, 15400), img('e3', 'Unmute-2026-09-29-refresh.png'),
    seg('e4', 'And the error path swallows the 401 instead of surfacing it', 31000, 37600)], { delivering: true })], 900),
])

// ── EXPANDED SURFACES at 45%: the smallest size a user can pick ───────────────
const task = (blocks, extra = {}) => ({ type: 'showTask', task: { id: 't-new', title: 'Pricing landing page', status: 'processing',
  kind: 'session', alive: true, backend: 'claude', terminal: false, modelLabel: 'Opus', canCompose: true, blocks, ...extra } })
const T0 = { kind: 'turnStart', startedAt: '$NOW-4000' }
const u1 = { kind: 'message', role: 'user', text: 'build a landing page for the pricing launch' }
scene('session', [
  shot('task-1', [task([T0, u1]), state('task', 1), { type: 'surfaceFill', fill: 0.45 }], 1300),
  shot('task-2', [task([T0, u1, { kind: 'fileRead', path: 'docs/pricing-brief.md', lines: 84 }])], 1100),
  shot('task-3', [task([T0, u1, { kind: 'fileRead', path: 'docs/pricing-brief.md', lines: 84 },
    { kind: 'fileChange', path: 'src/pages/pricing.tsx', verb: 'create', added: 142, removed: 0, status: 'done' }])], 1100),
  shot('task-4', [task([T0, u1, { kind: 'fileRead', path: 'docs/pricing-brief.md', lines: 84 },
    { kind: 'fileChange', path: 'src/pages/pricing.tsx', verb: 'create', added: 142, removed: 0, status: 'done' },
    { kind: 'message', role: 'assistant', text: 'Laying out the hero, the three plans and the FAQ from the brief.' }])], 1100),
])

const agentTask = (blocks, status = 'ready') => ({ type: 'showTask', task: { id: 'unmute-agent', title: 'Unmute Agent', status,
  kind: 'session', alive: true, backend: 'claude', terminal: false, canCompose: true, blocks } })
const say = (role, text) => ({ kind: 'message', role, text })
scene('agent', [
  shot('agent-save-1', [agentTask([say('user', 'save this — good example of onboarding, for the redesign')], 'processing'),
    state('task'), { type: 'surfaceFill', fill: 0.45 }], 1300),
  shot('agent-save-2', [agentTask([say('user', 'save this — good example of onboarding, for the redesign'),
    say('assistant', 'Saved **Onboarding teardown** with your note: *"good example of onboarding, for the redesign."*')])], 1100),
  shot('agent-ask-1', [agentTask([say('user', 'what was that onboarding video I saved?')], 'processing')], 1100),
  shot('agent-ask-2', [agentTask([say('user', 'what was that onboarding video I saved?'),
    say('assistant', '**Onboarding teardown** — youtube.com/watch?v=onb-teardown\n\nYou saved it on Sep 14 and said: *"good example of onboarding, for the redesign."*')])], 1100),
  shot('agent-meet-1', [agentTask([say('user', 'any follow-ups for me from that call?')], 'processing')], 1100),
  shot('agent-meet-2', [agentTask([say('user', 'any follow-ups for me from that call?'),
    say('assistant', 'Two are yours from **Onboarding redesign**:\n\n1. Rewrite the onboarding copy for the three-screen flow\n2. Share the Figma with Priya before Friday')])], 1100),
  shot('agent-meet-3', [agentTask([say('user', 'any follow-ups for me from that call?'),
    say('assistant', 'Two are yours from **Onboarding redesign**:\n\n1. Rewrite the onboarding copy for the three-screen flow\n2. Share the Figma with Priya before Friday'),
    say('user', 'start a task for the first one'),
    say('assistant', 'Started **Onboarding copy** in Claude Code with the call notes attached.')])], 1100),
])
console.log('fixtures written')

// Re-shots with clean timing: each starts from a quiet surface.
scene('fixups', [
  { send: [pocket('closed', 0), state('attention', 1, 1)], wait: 1800, shot: 'bar-needsyou' },
  { send: [state('dormant'), pocket('closed', 0, [], 0), roptRec], wait: 1200 },
  { send: [pill({ phase: 'recording', level: 0, elapsed: 3, canType: true, captureFlashToken: 7, ...orchestrator })], wait: 45, shot: 'pill-flash' },
])
