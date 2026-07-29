import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { devLogEnabled, devlog, devlogDump, devlogReason, devEvent, devFields } from './curator-devlog.ts'

// THE SAME GATE, FOR THE STRUCTURED EVENT LOG.
//
// A set of `TEMP(memory-debug)` events shipped ungated, so every user's
// ~/.unmute/remote/logs carried memory-calibration diagnostics they had no use
// for. Two shapes needed covering: whole events that exist only to debug, and
// debug FIELDS bolted onto an event that is genuinely useful.
test('devEvent emits only when the gate is on', () => {
  const prev = process.env.UNMUTE_CURATOR_DEVLOG
  const seen: Array<[string, Record<string, unknown>]> = []
  const log = { event: (n: string, p: Record<string, unknown>) => { seen.push([n, p]) } }
  try {
    delete process.env.UNMUTE_CURATOR_DEVLOG
    devEvent(log, 'gardening-planned', { count: 3 })
    assert.equal(seen.length, 0, 'a packaged build must write nothing')

    process.env.UNMUTE_CURATOR_DEVLOG = '1'
    devEvent(log, 'gardening-planned', { count: 3 })
    assert.deepEqual(seen, [['gardening-planned', { count: 3 }]], 'a dev build still gets the full event')
  } finally {
    if (prev === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prev
  }
})

test('devFields strips debug-only fields from an event that is otherwise kept', () => {
  const prev = process.env.UNMUTE_CURATOR_DEVLOG
  try {
    delete process.env.UNMUTE_CURATOR_DEVLOG
    assert.deepEqual(devFields({ nurseryNames: ['a'] }), {}, 'nothing extra reaches a user log')

    process.env.UNMUTE_CURATOR_DEVLOG = '1'
    assert.deepEqual(devFields({ nurseryNames: ['a'] }), { nurseryNames: ['a'] })
  } finally {
    if (prev === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prev
  }
})

// The ONLY gate is the env var. Fail-safe-off: when it is unset, devlog/devlogDump
// must be no-ops — no file, no dir — so a packaged public build logs nothing.
test('devlog/devlogDump are no-ops when UNMUTE_CURATOR_DEVLOG is unset: no file, no dir', async () => {
  const prevHome = process.env.HOME
  const prevFlag = process.env.UNMUTE_CURATOR_DEVLOG
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-off-'))
  process.env.HOME = home
  delete process.env.UNMUTE_CURATOR_DEVLOG
  try {
    assert.equal(devLogEnabled(), false)
    devlog({ stage: 'ux', kind: 'popup-open', proposalId: 'p1' })
    devlogDump('sw_1-synth', { anything: true })
    // Give any (wrongly-scheduled) async write a tick to (not) happen.
    await new Promise((r) => setTimeout(r, 25))
    const logsDir = path.join(home, '.unmute', 'remote', 'curator', 'logs')
    await assert.rejects(fs.stat(logsDir)) // the logs dir was never created
  } finally {
    process.env.HOME = prevHome
    if (prevFlag === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prevFlag
  }
})

// When the gate IS on, devlog appends one JSON line per call (with a ts) to
// logs/events.jsonl under the curator root — the timeline the tester replays.
test('devlog writes one JSON line per call when the gate is on', async () => {
  const prevHome = process.env.HOME
  const prevFlag = process.env.UNMUTE_CURATOR_DEVLOG
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-on-'))
  process.env.HOME = home
  process.env.UNMUTE_CURATOR_DEVLOG = '1'
  try {
    assert.equal(devLogEnabled(), true)
    devlog({ stage: 'scheduler', kind: 'sweep-start', sweepId: 'sw_1' })
    devlog({ stage: 'ux', kind: 'accept-click', proposalId: 'p1' })
    // Appends are serialized through a promise chain; poll until both land.
    const events = path.join(home, '.unmute', 'remote', 'curator', 'logs', 'events.jsonl')
    let lines: string[] = []
    for (let i = 0; i < 50 && lines.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20))
      try { lines = (await fs.readFile(events, 'utf8')).trim().split('\n').filter(Boolean) } catch { /* not yet */ }
    }
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.kind, 'sweep-start')
    assert.equal(first.stage, 'scheduler')
    assert.ok(typeof first.ts === 'string')
  } finally {
    process.env.HOME = prevHome
    if (prevFlag === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prevFlag
  }
})

// devlogReason is the ONE funnel every LLM stage's structured `reason` goes
// through. It must be a true no-op (no file, no dir) when the gate is off —
// mirrors devlog/devlogDump's fail-safe-off discipline.
test('devlogReason is a no-op when UNMUTE_CURATOR_DEVLOG is unset: no file, no dir', async () => {
  const prevHome = process.env.HOME
  const prevFlag = process.env.UNMUTE_CURATOR_DEVLOG
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-reason-off-'))
  process.env.HOME = home
  delete process.env.UNMUTE_CURATOR_DEVLOG
  try {
    assert.equal(devLogEnabled(), false)
    devlogReason('distill', { sweepId: 'sw_1', taskId: 't_1' }, 'excluded X because navigation')
    await new Promise((r) => setTimeout(r, 25))
    const logsDir = path.join(home, '.unmute', 'remote', 'curator', 'logs')
    await assert.rejects(fs.stat(logsDir))
  } finally {
    process.env.HOME = prevHome
    if (prevFlag === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prevFlag
  }
})

// When the gate is ON, devlogReason must ALSO be a no-op for a missing/blank
// reason — a stage with nothing to say writes nothing, ever.
test('devlogReason is a no-op for an absent/blank reason even when the gate is on', async () => {
  const prevHome = process.env.HOME
  const prevFlag = process.env.UNMUTE_CURATOR_DEVLOG
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-reason-blank-'))
  process.env.HOME = home
  process.env.UNMUTE_CURATOR_DEVLOG = '1'
  try {
    assert.equal(devLogEnabled(), true)
    devlogReason('synthesize', { sweepId: 'sw_1' }, undefined)
    devlogReason('synthesize', { sweepId: 'sw_1' }, '   ')
    // One genuine write, so we can tell the two no-ops above landed nothing.
    devlog({ stage: 'scheduler', kind: 'sweep-start', sweepId: 'sw_1' })
    const events = path.join(home, '.unmute', 'remote', 'curator', 'logs', 'events.jsonl')
    let lines: string[] = []
    for (let i = 0; i < 50 && lines.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20))
      try { lines = (await fs.readFile(events, 'utf8')).trim().split('\n').filter(Boolean) } catch { /* not yet */ }
    }
    assert.equal(lines.length, 1) // only the sentinel devlog() call, no 'reason' lines
    assert.equal(JSON.parse(lines[0]).kind, 'sweep-start')
  } finally {
    process.env.HOME = prevHome
    if (prevFlag === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prevFlag
  }
})

// When the gate is ON and a reason IS present, devlogReason writes exactly one
// structured 'reason'-kind line carrying stage + the correlation ids + reason.
test('devlogReason writes one structured reason line when the gate is on', async () => {
  const prevHome = process.env.HOME
  const prevFlag = process.env.UNMUTE_CURATOR_DEVLOG
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-reason-on-'))
  process.env.HOME = home
  process.env.UNMUTE_CURATOR_DEVLOG = '1'
  try {
    assert.equal(devLogEnabled(), true)
    devlogReason('distill', { sweepId: 'sw_1', taskId: 't_1' }, 'excluded X because navigation')
    const events = path.join(home, '.unmute', 'remote', 'curator', 'logs', 'events.jsonl')
    let lines: string[] = []
    for (let i = 0; i < 50 && lines.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20))
      try { lines = (await fs.readFile(events, 'utf8')).trim().split('\n').filter(Boolean) } catch { /* not yet */ }
    }
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.stage, 'distill')
    assert.equal(entry.kind, 'reason')
    assert.equal(entry.sweepId, 'sw_1')
    assert.equal(entry.taskId, 't_1')
    assert.equal(entry.reason, 'excluded X because navigation')
    assert.ok(typeof entry.ts === 'string')
  } finally {
    process.env.HOME = prevHome
    if (prevFlag === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = prevFlag
  }
})
