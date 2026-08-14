// Submission proof for a CLI reply was "did a `UserPromptSubmit` hook event
// arrive". That hook is Claude Code's, and Codex does not install it, so a
// Codex CLI reply could never be confirmed: it was typed into the terminal,
// Codex answered it, and Unmute still reported `prompt-submitted-hook-timeout`,
// retained the draft, and — because the first Enter looked unconfirmed — sent a
// SECOND Enter, duplicating the turn. A live session shows exactly that: "Hi"
// asked and answered twice.
//
// Codex writes each user turn to its rollout, which is proof it actually
// generates.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import type { AgentExecutor } from './executor'

async function codexTask(onSubmit: () => void) {
  const trace: string[] = []
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() {},
    writeStdin() {},
    writeDraftText(text) { trace.push(`text:${text}`) },
    async pasteImage() { return true },
    // Deliberately fires NO hook event: Codex has no UserPromptSubmit hook.
    submitDraft() { trace.push('submit'); onSubmit() },
    write() {}, resize() {}, onData() {}, kill() {},
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-codex-submit-'))
  const manager = new TaskManager({
    executorFactory: () => ex, baseDir,
    trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 300, pollMs: 99_999,
  })
  const id = await manager.dispatch('initial')
  const task = manager.get(id)!
  task.agent = 'codex'
  task.codexRolloutId = 'rollout-under-test'
  trace.length = 0
  return { manager, id, trace }
}

test('a Codex CLI reply is confirmed by its rollout, not by a hook Codex never fires', async () => {
  let userTurns = 1
  const { manager, id, trace } = await codexTask(() => { userTurns += 1 })
  ;(manager as any).codexUserTurns = async () => userTurns

  assert.equal(await manager.deliverDraft(id, 'summarize recent commits', []), true)
  assert.deepEqual(
    trace.filter((step) => step === 'submit'),
    ['submit'],
    'a confirmed first Enter must never be followed by a duplicate',
  )
  assert.equal(manager.get(id)!.deliveryError, undefined)
  manager.kill(id)
})

test('a Codex CLI reply that never reaches the rollout is reported failed and keeps its draft', async () => {
  const { manager, id } = await codexTask(() => { /* the turn never lands */ })
  ;(manager as any).codexUserTurns = async () => 1

  assert.equal(await manager.deliverDraft(id, 'summarize recent commits', []), false)
  assert.ok(manager.get(id)!.deliveryError, 'an unproven send must stay visible as a failure')
  manager.kill(id)
})
