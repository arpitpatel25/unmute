import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskManager } from './task-manager.ts'
import type { AgentExecutor } from './executor.ts'

async function tmpBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-live-'))
}

// ── A terminal that is painting is not stuck ──
//
// Field failure (2026-08-19/20, task 628700b8): marked `task-stuck` NINE times in
// one night, every one followed by `stuck-recovered {"via":"hook"}` — it was
// working the whole time. `stuck` is inferred from a 4-minute gap in hook events
// and status writes, so any turn that thinks, or runs one long tool, for longer
// than that reads as hung. Worse, each verdict wrote an unsolicited Enter into
// the live session. The PTY was streaming a spinner throughout: we were watching
// it work and calling it dead.
test('a task whose terminal keeps painting is never called stuck', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const cbs: Array<(chunk: string) => void> = []
  const raw: string[] = []
  let aliveFlag = true
  const ex: AgentExecutor & { raw: string[] } = {
    raw,
    get alive() { return aliveFlag },
    async spawn() {}, async isReady() {},
    writeStdin() {}, write(d) { raw.push(d) }, resize() {},
    onData(cb) { cbs.push(cb) },
    kill() { aliveFlag = false },
  }
  const tm = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 20, staleMs: 100 })
  let wentStuck = false
  tm.on('stuck', () => { wentStuck = true })
  const id = await tm.dispatch('grind through 619 transcripts')
  try {
    const rawBefore = ex.raw.length
    // Claude's spinner, one frame at a time — no hooks, no status writes, just paint.
    for (let i = 0; i < 20; i++) {
      for (const cb of cbs) cb('\u001b[27;1H\u001b[38;5;174m✶')
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(wentStuck, false, 'a session painting its spinner was declared stuck')
    assert.equal(tm.get(id)!.state, 'processing')
    assert.equal(ex.raw.length, rawBefore, 'an unsolicited Enter was typed into a working session')
  } finally {
    tm.kill(id) // a failing assert must not leave the poll loop holding the event loop open
  }
})
