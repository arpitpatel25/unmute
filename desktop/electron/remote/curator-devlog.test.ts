import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { devLogEnabled, devlog, devlogDump } from './curator-devlog.ts'

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
