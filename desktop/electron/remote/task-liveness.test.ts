import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from './task-manager.ts'
import type { AgentExecutor } from './executor.ts'

/** An executor whose PTY we can kill from the test, as node-pty would. */
function deadableExecutor() {
  let alive = true
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  const ex: AgentExecutor & { onExit(cb: (e: { exitCode: number }) => void): void } = {
    get alive() { return alive },
    async spawn() {},
    async isReady() {},
    writeStdin() {},
    write() {},
    resize() {},
    onData() {},
    onExit(cb) { exitCb = cb },
    // A real PTY emits exit when it is killed. A fake that stays silent hides
    // exactly the paths that matter here.
    kill() { if (alive) { alive = false; exitCb?.({ exitCode: 0 }) } },
  }
  return {
    ex,
    /** The CLI quits on its own — an update chooser, a crash, a `2. No, quit`. */
    die(code = 0) { alive = false; exitCb?.({ exitCode: code }) },
  }
}

async function manager() {
  const base = await fs.mkdtemp(join(tmpdir(), 'unmute-liveness-'))
  const built = deadableExecutor()
  const mgr = new TaskManager({
    executorFactory: () => built.ex,
    baseDir: base,
    trustAcceptMs: 0,
    pollMs: 50,
  } as never)
  return { mgr, ...built }
}

test('a CLI that exits under a running task fails the task instead of leaving it Working', async () => {
  // FIELD, 2026-08-28: Codex quit 0.5s after dispatch (it had been typed into a
  // menu). Nothing was watching the PTY, so the card sat at "Working 9m" over a
  // terminal that had been dead for nine minutes — indistinguishable, to the
  // user, from a task that was simply slow.
  //
  // Delivery is PROVEN here: an unproven death is re-delivered instead (see
  // task-redelivery.test.ts), and only a death after the agent demonstrably had
  // the words is a real failure.
  const { mgr, die } = await manager()
  const id = await mgr.dispatch('do a thing', { agent: 'claude' })
  assert.equal(mgr.get(id)?.state, 'processing')
  mgr.noteDeliveryProven(id, 'test')

  die(0)
  await new Promise((r) => setTimeout(r, 50))

  const task = mgr.get(id)!
  assert.equal(task.state, 'failed', 'a dead session is not a working one')
  assert.match(task.error?.reason ?? '', /exited/i, 'and it must say why')
})

test('the exit code is reported, because 0 and 1 mean different things', async () => {
  const { mgr, die } = await manager()
  const id = await mgr.dispatch('do a thing', { agent: 'claude' })
  mgr.noteDeliveryProven(id, 'test')
  die(137)
  await new Promise((r) => setTimeout(r, 50))
  assert.match(mgr.get(id)?.error?.detail ?? '', /137/)
})

test('a task that already finished is not rewritten by its session closing', async () => {
  // Normal shutdown: the work completed, THEN the REPL is killed. Marking that
  // failed would turn every successful task into a failure at teardown.
  const { mgr, die } = await manager()
  const id = await mgr.dispatch('do a thing', { agent: 'claude' })
  await mgr.setReportedStatus(id, {
    state: 'done',
    result: { summary: 'finished the thing' },
  } as never)
  assert.equal(mgr.get(id)?.state, 'done')

  die(0)
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(mgr.get(id)?.state, 'done', 'a terminal state is final')
  assert.equal(mgr.get(id)?.error, undefined)
})

test('app shutdown must not resurrect anything', async () => {
  // shutdown() kills persistent sessions WITHOUT marking them failed (they are
  // meant to be resumable). Re-delivery keys off "non-terminal and unproven",
  // which every such task is - so without a guard, quitting the app would spawn
  // a fresh CLI per session on the way out.
  const { mgr, ex } = await manager()
  const id = await mgr.dispatch('a long-running thing', { agent: 'claude', kind: 'session' })
  assert.equal(mgr.get(id)?.state, 'processing')

  mgr.shutdown()
  await new Promise((r) => setTimeout(r, 300))

  assert.equal(mgr.get(id)?.redeliveries ?? 0, 0, 'quitting is not a delivery failure')
  assert.equal(ex.alive, false, 'and nothing was respawned')
})
