import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRollout, watchThread } from './rollout'

// Shapes below are copied from REAL rollout files on a live machine
// (~/.codex/sessions/2026/07/25/rollout-*.jsonl), not invented — the whole
// value of this parser is that it matches what Codex actually writes.
const line = (type: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'event_msg', payload: { type, ...payload } })

test('a turn in flight is processing', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    line('user_message', { message: 'do the thing' }),
  ].join('\n'))
  assert.equal(snap.state, 'processing')
  assert.equal(snap.everCompleted, false)
})

test('a completed turn is READY, not done — the ball is with the user', () => {
  // ORCHESTRATE-VISION §3: "the step is over but the ball is with you". A Codex
  // thread is always continuable, so it must never settle straight to `done`.
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    line('user_message', { message: 'reply pong' }),
    line('agent_message', { message: 'pong' }),
    line('task_complete', { turn_id: 't1', last_agent_message: 'pong' }),
  ].join('\n'))
  assert.equal(snap.state, 'ready')
  assert.equal(snap.lastAgentMessage, 'pong')
  assert.equal(snap.everCompleted, true)
})

test('a second turn started after one completed returns to processing', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1' }),
    line('task_complete', { turn_id: 't1', last_agent_message: 'first' }),
    line('task_started', { turn_id: 't2' }),
  ].join('\n'))
  assert.equal(snap.state, 'processing')
  // The headline still reflects the last COMPLETED turn.
  assert.equal(snap.lastAgentMessage, 'first')
})

test('turns are captured in order and capped', () => {
  // The assistant side comes from `response_item`, not the `agent_message`
  // event: only the response item carries the phase that separates a running
  // commentary line from the final answer.
  const lines: string[] = [line('task_started', {})]
  for (let i = 0; i < 10; i++) {
    lines.push(line('user_message', { message: `u${i}` }))
    lines.push(JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: `a${i}` }],
    } }))
  }
  lines.push(line('task_complete', { last_agent_message: 'a9' }))
  const snap = parseRollout(lines.join('\n'), 4)
  assert.equal(snap.turns.length, 4)
  assert.deepEqual(snap.turns.map((t) => t.text), ['u8', 'a8', 'u9', 'a9'])
  assert.equal(snap.turns[0].role, 'user')
})

test('a torn final line (Codex mid-write) is ignored, not fatal', () => {
  // Rollouts are appended live; a poll can read a half-written last line.
  const snap = parseRollout([
    line('task_started', {}),
    line('task_complete', { last_agent_message: 'ok' }),
    '{"type":"event_msg","payload":{"type":"tok',
  ].join('\n'))
  assert.equal(snap.state, 'ready')
  assert.equal(snap.lastAgentMessage, 'ok')
})

test('an error event marks the task failed', () => {
  const snap = parseRollout([
    line('task_started', {}),
    line('error', { message: 'stream broke' }),
  ].join('\n'))
  assert.equal(snap.state, 'failed')
})

test('empty transcript is processing, never a crash', () => {
  const snap = parseRollout('')
  assert.equal(snap.state, 'processing')
  assert.equal(snap.turns.length, 0)
  assert.equal(snap.lastAgentMessage, null)
})

test('second-precision timestamps are normalised to ms', () => {
  // Codex writes started_at in SECONDS; Unmute's staleness clock is in ms, so a
  // raw copy would look ~55 years stale and instantly mark every task stuck.
  const snap = parseRollout(line('task_started', { started_at: 1784927426 }))
  assert.equal(snap.updatedAt, 1784927426_000)
})

test('unknown event types are ignored (forward compatible)', () => {
  const snap = parseRollout([
    line('task_started', {}),
    line('some_future_event_openai_adds', { whatever: 1 }),
    line('task_complete', { last_agent_message: 'fine' }),
  ].join('\n'))
  assert.equal(snap.state, 'ready')
  assert.equal(snap.lastAgentMessage, 'fine')
})

// ── the rich item stream ─────────────────────────────────────────────────────
//
// Shapes below are verbatim from the real "Open Mr. B's latest YouTube video"
// thread (2026-07-25). Before this, the parser kept only `agent_message`, so a
// turn that opened a browser, searched YouTube, verified the channel and opened
// the video rendered as ONE grey sentence.

/** A `response_item` line — the layer that carries tool calls and phases. */
const item = (payload: Record<string, unknown>) =>
  JSON.stringify({ type: 'response_item', payload })

test("a tool step keeps Codex's own title, code, output and wall time", () => {
  const snap = parseRollout([
    item({
      type: 'custom_tool_call', call_id: 'call_A', name: 'exec',
      input: 'const r = await tools.mcp__node_repl__js({"title":"Search YouTube","code":"await tab.goto(x)"});',
    }),
    item({
      type: 'custom_tool_call_output', call_id: 'call_A',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 99.1 seconds\nOutput:\n' },
               { type: 'input_text', text: 'found the video' }],
    }),
  ].join('\n'))
  const step = snap.turns.find((t) => t.role === 'tool')!
  assert.equal(step.title, 'Search YouTube', "the label Codex showed, not the internal tool name")
  assert.equal(step.durationMs, 99_100, "wall time lifted out of Codex's status preamble")
  assert.match(step.code!, /tab\.goto/)
  assert.equal(step.output, 'found the video', 'preamble stripped, result kept')
  assert.equal(step.ok, true)
})

test('a step titles itself from the command when there is no title', () => {
  const snap = parseRollout(item({
    type: 'custom_tool_call', call_id: 'c1', name: 'exec',
    input: 'const r = await tools.exec_command({"cmd":"sed -n 1,240p SKILL.md"});',
  }))
  assert.equal(snap.turns.find((t) => t.role === 'tool')!.title, 'sed -n 1,240p SKILL.md')
})

test('an output with no matching call is dropped, not attached to the wrong step', () => {
  const snap = parseRollout([
    item({ type: 'custom_tool_call', call_id: 'mine', name: 'exec', input: '{"title":"Mine"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'someone-elses', output: 'not mine' }),
  ].join('\n'))
  const steps = snap.turns.filter((t) => t.role === 'tool')
  assert.equal(steps.length, 1)
  assert.equal(steps[0].output, undefined)
})

test('commentary and the final answer stay distinguishable', () => {
  // Codex greys the running "I'll do X" line and gives the answer full weight;
  // collapsing them would make a long thread unskimmable.
  const snap = parseRollout([
    item({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'I will look it up.' }] }),
    item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Opened it.' }] }),
  ].join('\n'))
  // A `work` marker heads the run — that is what Codex's "Worked for …" line is.
  assert.deepEqual(snap.turns.map((t) => t.role), ['work', 'commentary', 'assistant'])
})

test("Codex's injected context is NEVER shown back to the user", () => {
  // <app-context> and <recommended_plugins> arrive as developer- and user-role
  // messages. Rendering them would put pages of prompt scaffolding in the notch
  // and, worse, attribute it to the user.
  const snap = parseRollout([
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>x</app-context>' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>y' }] }),
    line('user_message', { message: "Open Mr. B's latest video." }),
  ].join('\n'))
  assert.deepEqual(snap.turns, [{ role: 'user', text: "Open Mr. B's latest video." }])
})

test('an assistant answer appears once, not twice', () => {
  // Both `event_msg agent_message` and `response_item message` carry it; only
  // the latter knows the phase, so only the latter is read.
  const snap = parseRollout([
    line('agent_message', { message: 'Opened it.' }),
    item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Opened it.' }] }),
  ].join('\n'))
  assert.equal(snap.turns.length, 1)
})

test('a huge tool output is clipped rather than shipped whole to the notch', () => {
  const snap = parseRollout([
    item({ type: 'custom_tool_call', call_id: 'c', name: 'exec', input: '{"title":"Snapshot"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'c', output: 'x'.repeat(50_000) }),
  ].join('\n'))
  const step = snap.turns.find((t) => t.role === 'tool')!
  assert.ok(step.output!.length < 2_200, 'clipped')
  assert.match(step.output!, /more characters/, 'and says so')
})

test('the headline is still the final answer, not the last tool step', () => {
  // The notch/doorbell reads lastAgentMessage; a tool step must never become
  // the thing the user is told the task produced.
  const snap = parseRollout([
    line('task_started', {}),
    item({ type: 'custom_tool_call', call_id: 'c', name: 'exec', input: '{"title":"Keep video open"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'c', output: 'ok' }),
    line('task_complete', { last_agent_message: 'Opened MrBeast’s latest video.' }),
  ].join('\n'))
  assert.equal(snap.lastAgentMessage, 'Opened MrBeast’s latest video.')
})

test('the work run is headed by Codex\'s own reported duration', () => {
  // Codex shows the turn's WALL time, which includes model thinking. Measured
  // on one real turn: reported 167s vs 107s of step time — deriving it from the
  // steps would read visibly wrong next to the real Codex window. `duration_ms`
  // is already milliseconds, so it must NOT go through the epoch-seconds helper.
  const snap = parseRollout([
    line('task_started', { started_at: 1784990760 }),
    item({ type: 'custom_tool_call', call_id: 'c', name: 'exec', input: '{"title":"Search"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'c', output: 'Script completed\nWall time 99.1 seconds\nOutput:\nx' }),
    item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done' }] }),
    line('task_complete', { last_agent_message: 'done', duration_ms: 166877 }),
  ].join('\n'))
  const work = snap.turns.find((t) => t.role === 'work')!
  assert.equal(work.durationMs, 166_877)
})

test('a work run with no reported duration falls back to the steps, never to nothing', () => {
  const snap = parseRollout([
    item({ type: 'custom_tool_call', call_id: 'c', name: 'exec', input: '{"title":"Search"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'c', output: 'Script completed\nWall time 2.0 seconds\nOutput:\nx' }),
  ].join('\n'))
  assert.equal(snap.turns.find((t) => t.role === 'work')!.durationMs, 2000)
})

test("Codex's own plumbing steps are not shown as work", () => {
  // `wait` is how the model polls a still-running cell. Codex never shows it;
  // listing it is like reporting "checked whether it was done yet" as a step.
  const snap = parseRollout([
    item({ type: 'function_call', call_id: 'w', name: 'wait', arguments: '{"cell_id":"7"}' }),
    item({ type: 'function_call_output', call_id: 'w', output: 'still going' }),
  ].join('\n'))
  assert.equal(snap.turns.filter((t) => t.role === 'tool').length, 0)
})

// ── pendingToolCalls: the shadow a blocked turn casts on disk ────────────────
// Observed 2026-07-30: a Computer Use consent ("Allow ChatGPT to use WhatsApp?")
// stops the turn mid-exec. Codex writes the call line and then nothing — no
// output, no task_complete, no hook. The unclosed call is the only trace.

/** response_item helper that also sets the inner `type` (the call/output pair). */
const resp = (type: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'response_item', payload: { type, ...payload } })

test('an exec awaiting consent leaves the call unclosed', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    line('user_message', { message: 'open whatsapp' }),
    resp('custom_tool_call', { call_id: 'c1', name: 'exec', input: 'open -a WhatsApp' }),
  ].join('\n'))
  assert.equal(snap.pendingToolCalls, 1)
  assert.equal(snap.pendingToolName, 'exec')
  // Still `processing` — an unclosed call is NOT on its own proof of blocking.
  assert.equal(snap.state, 'processing')
})

test('a closed call leaves nothing pending', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    resp('custom_tool_call', { call_id: 'c1', name: 'exec', input: 'ls' }),
    resp('custom_tool_call_output', { call_id: 'c1', output: 'ok' }),
    line('task_complete', { duration_ms: 1200, last_agent_message: 'done' }),
  ].join('\n'))
  assert.equal(snap.pendingToolCalls, 0)
  assert.equal(snap.pendingToolName, null)
  assert.equal(snap.state, 'ready')
})

test('several unclosed calls are all counted', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    resp('custom_tool_call', { call_id: 'c1', name: 'exec', input: 'a' }),
    resp('custom_tool_call', { call_id: 'c2', name: 'shell', input: 'b' }),
    resp('custom_tool_call_output', { call_id: 'c1', output: 'ok' }),
  ].join('\n'))
  assert.equal(snap.pendingToolCalls, 1)
  assert.equal(snap.pendingToolName, 'shell')
})

// ── watchThread: latency shortcut, never a correctness dependency ────────────

test('watching a thread with no transcript yet is a harmless no-op', async () => {
  // A just-dispatched thread has no rollout. That must return a usable disposer
  // rather than throwing into the poll loop.
  const stop = await watchThread('no-such-thread', () => {}, '/nonexistent-sessions-dir')
  assert.equal(typeof stop, 'function')
  stop(); stop()          // idempotent
})

test('an append wakes the watcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-rollout-'))
  const day = join(dir, '2026', '07', '30')
  await mkdir(day, { recursive: true })
  const id = '019fb306-3e84-7480-8d18-9a937b09293b'
  const file = join(day, `rollout-2026-07-30T18-05-58-${id}.jsonl`)
  await writeFile(file, line('task_started', { turn_id: 't1', started_at: 1784927426 }) + '\n')

  let hits = 0
  const stop = await watchThread(id, () => { hits++ }, dir, 20)
  try {
    await appendFile(file, line('user_message', { message: 'hello' }) + '\n')
    for (let i = 0; i < 60 && hits === 0; i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(hits > 0, 'appending to the rollout should have woken the watcher')
  } finally { stop() }
})

// ── newestThreadIdSince: creation time, not mtime ───────────────────────────
// 2026-07-30: two dispatches 29s apart resolved to the SAME threadId, so two
// cards rendered one Codex conversation. mtime is bumped by every append, so a
// thread that is merely STILL RUNNING looks brand new forever. Measured across
// 57 real rollouts: 26 had an mtime over a minute past creation, one by 18h.

import { newestThreadIdSince, rolloutCreatedAt } from './rollout'

async function sessionsWith(files: Array<{ name: string; mtimeOffsetMs?: number }>) {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-sessions-'))
  const day = join(dir, '2026', '07', '30')
  await mkdir(day, { recursive: true })
  for (const f of files) {
    const p = join(day, f.name)
    await writeFile(p, '')
    if (f.mtimeOffsetMs) {
      const t = new Date(Date.now() + f.mtimeOffsetMs)
      await utimes(p, t, t)
    }
  }
  return dir
}

const OLD = 'rollout-2026-07-30T21-12-54-019fb4df-77ad-7113-97fb-77419adae7e7.jsonl'
const NEW = 'rollout-2026-07-30T21-13-23-019fb500-1111-2222-3333-444455556666.jsonl'

test('rolloutCreatedAt reads the filename stamp, and null when absent', () => {
  assert.equal(rolloutCreatedAt(OLD), new Date(2026, 6, 30, 21, 12, 54).getTime())
  assert.equal(rolloutCreatedAt('not-a-rollout.jsonl'), null)
})

test('a STILL-RUNNING thread is not mistaken for a newly created one', async () => {
  // Only the old thread exists, and it is being appended to right now — so its
  // mtime is "now" while its creation is minutes old. Asking for threads created
  // in the last two seconds must find NOTHING, not hand back the running one.
  const dir = await sessionsWith([{ name: OLD, mtimeOffsetMs: 0 }])
  const id = await newestThreadIdSince(Date.now() - 2000, dir)
  assert.equal(id, null, 'mtime says "new", the filename says otherwise — trust the filename')
})

test('a genuinely new thread IS found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-sessions-'))
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const day = join(dir, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
  await mkdir(day, { recursive: true })
  await writeFile(join(day, `rollout-${stamp}-019fb500-1111-2222-3333-444455556666.jsonl`), '')
  const id = await newestThreadIdSince(Date.now() - 5000, dir)
  assert.equal(id, '019fb500-1111-2222-3333-444455556666')
})

test('a thread already owned by a live task is never handed out again', async () => {
  // The belt to the filename braces: even if timing were ambiguous, an id that
  // another task holds cannot be the thread we are creating right now.
  const dir = await sessionsWith([{ name: OLD }, { name: NEW }])
  const taken = new Set(['019fb500-1111-2222-3333-444455556666'])
  const id = await newestThreadIdSince(0, dir, taken)
  assert.equal(id, '019fb4df-77ad-7113-97fb-77419adae7e7')
})

test('an unparseable filename falls back to mtime rather than vanishing', async () => {
  // 57/57 real files parsed, but a naming change must degrade to the old
  // behaviour, never break task creation outright.
  const dir = await sessionsWith([{ name: 'rollout-weird-019fb777-1111-2222-3333-444455556666.jsonl', mtimeOffsetMs: 0 }])
  const id = await newestThreadIdSince(Date.now() - 5000, dir)
  assert.equal(id, '019fb777-1111-2222-3333-444455556666')
})
