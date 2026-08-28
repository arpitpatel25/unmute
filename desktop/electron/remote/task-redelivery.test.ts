import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from './task-manager.ts'
import type { AgentExecutor } from './executor.ts'

/**
 * A CLI we can kill, and whose typed input we can inspect.
 *
 * The field case (2026-08-28 08:25): the task was typed in, Codex immediately
 * ran `npm install -g @openai/codex` instead, and exited 0 twelve seconds later.
 * The user's words were never seen by any model — but they were sitting in
 * meta.json the whole time, and nothing ever tried again.
 */
function fakeCli() {
  let alive = true
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  const typed: string[] = []
  const ex: AgentExecutor & { onExit(cb: (e: { exitCode: number }) => void): void } = {
    get alive() { return alive },
    async spawn() { alive = true },
    async isReady() {},
    writeStdin(t: string) { typed.push(t) },
    write() {},
    resize() {},
    onData() {},
    onExit(cb) { exitCb = cb },
    kill() { alive = false },
  }
  return {
    ex, typed,
    die(code = 0) { alive = false; exitCb?.({ exitCode: code }) },
    revive() { alive = true },
  }
}

async function fixture(opts: Record<string, unknown> = {}) {
  const base = await fs.mkdtemp(join(tmpdir(), 'unmute-redeliver-'))
  const cli = fakeCli()
  const mgr = new TaskManager({
    executorFactory: () => cli.ex,
    baseDir: base,
    trustAcceptMs: 0,
    pollMs: 50,
    ...opts,
  } as never)
  return { mgr, ...cli }
}

/** Tests leave tasks mid-flight on purpose; stop their pollers so the runner
 *  is not held open by work the assertions no longer care about. */
function teardown(mgr: TaskManager) {
  for (const t of mgr.list()) mgr.kill(t.id)
  mgr.stopMaintenance()
}

test('an unproven dispatch that dies is re-delivered, not lost', async () => {
  const { mgr, typed, die } = await fixture()
  const id = await mgr.dispatch('help me with reddit marketing', { agent: 'claude' })
  const before = typed.length
  assert.ok(before > 0, 'the intent was typed once')

  // The CLI quits without the turn ever starting — an update chooser, a crash.
  die(0)
  await new Promise((r) => setTimeout(r, 400))

  assert.ok(typed.length > before, 'the user’s words must be sent again, not dropped')
  assert.match(typed[typed.length - 1], /reddit marketing/, 'and it is the SAME intent')
  teardown(mgr)
})

test('a re-delivered task keeps its card, rather than spawning a second one', async () => {
  const { mgr, die } = await fixture()
  const id = await mgr.dispatch('help me with reddit marketing', { agent: 'claude' })
  die(0)
  await new Promise((r) => setTimeout(r, 400))

  assert.equal(mgr.list().length, 1, 'one utterance is one card')
  assert.equal(mgr.get(id)?.state, 'processing', 'and it is trying again, not failed')
  teardown(mgr)
})

test('a PROVEN delivery that dies is failed, never re-sent', async () => {
  // THE RULE THAT KEEPS THIS SAFE. Re-sending something the agent already acted
  // on could repeat a side effect — a message sent twice, a file written twice.
  // Retry only on positive evidence that nothing landed.
  const { mgr, typed, die } = await fixture()
  const id = await mgr.dispatch('send the email', { agent: 'claude' })
  const before = typed.length
  mgr.noteDeliveryProven(id, 'test')

  die(0)
  await new Promise((r) => setTimeout(r, 400))

  assert.equal(typed.length, before, 'nothing may be typed a second time')
  assert.equal(mgr.get(id)?.state, 'failed')
  teardown(mgr)
})

test('re-delivery is bounded — a CLI that dies every time must not loop forever', async () => {
  const { mgr, typed, die } = await fixture()
  await mgr.dispatch('do a thing', { agent: 'claude' })
  for (let i = 0; i < 6; i++) {
    die(0)
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(typed.length <= 4, `bounded retries, got ${typed.length} sends`)
  assert.equal(mgr.list()[0].state, 'failed', 'and it ends up honestly failed')
  teardown(mgr)
})

test('the intent survives on disk, which is what makes any of this possible', async () => {
  const { mgr } = await fixture()
  const id = await mgr.dispatch('help me with reddit marketing', { agent: 'claude' })
  const meta = JSON.parse(await fs.readFile(join(mgr.get(id)!.home, 'meta.json'), 'utf8'))
  assert.match(meta.intent, /reddit marketing/)
  teardown(mgr)
})
