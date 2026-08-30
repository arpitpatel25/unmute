import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planResume, isReapedScratchCwd } from './resume.ts'
import type { LocatedSession } from './locate.ts'

const owned: LocatedSession = {
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  harness: 'claude',
  path: '/home/.claude/projects/-Users-me-work/aaaaaaaa-1111-2222-3333-444444444444.jsonl',
  cwd: '/Users/me/work',
}
const unowned: LocatedSession = {
  sessionId: '019f2123-9c04-73a1-919a-eaecdff9067f',
  harness: 'codex',
  path: '/home/.codex/sessions/2026/08/30/rollout-2026-08-30T10-13-29-019f2123-9c04-73a1-919a-eaecdff9067f.jsonl',
  cwd: '/Users/me/repo',
}

test('a session Unmute already owns wakes its card, rather than minting a second', () => {
  const plan = planResume({ located: owned, existingTaskId: 'task-7', intent: 'carry on with the migration' })

  assert.deepEqual(plan, { action: 'wake', taskId: 'task-7', followUp: 'carry on with the migration' })
})

test('waking with nothing to say sends no follow-up', () => {
  const plan = planResume({ located: owned, existingTaskId: 'task-7' })

  assert.deepEqual(plan, { action: 'wake', taskId: 'task-7' })
})

test('a session Unmute never started is forked, keeping its harness and directory', () => {
  const plan = planResume({ located: unowned, intent: 'add the pricing row' })

  assert.deepEqual(plan, {
    action: 'fork',
    harness: 'codex',
    sessionId: '019f2123-9c04-73a1-919a-eaecdff9067f',
    cwd: '/Users/me/repo',
    intent: 'add the pricing row',
  })
})

test('a fork with nothing to say still opens the conversation', () => {
  const plan = planResume({ located: unowned })

  assert.equal(plan.action, 'fork')
  assert.equal(plan.action === 'fork' && plan.intent, 'Continue from where we left off.')
})

/**
 * Dispatch requires a directory for a fork. Without one the fork would fall
 * back to a fresh unrelated session in a scratch dir — which looks like
 * success and is not: the whole point is inheriting the conversation.
 */
test('a fork whose directory could not be recovered is refused, not downgraded', () => {
  const { cwd: _dropped, ...noCwd } = unowned

  const plan = planResume({ located: noCwd, intent: 'carry on' })

  assert.equal(plan.action, 'refuse')
  assert.match(plan.action === 'refuse' ? plan.reason : '', /director/i)
})

/** A stale id for a card that has since been removed must not wake nothing. */
test('an owned session whose card is gone is forked instead of woken', () => {
  const plan = planResume({ located: owned, existingTaskId: undefined, intent: 'carry on' })

  assert.equal(plan.action, 'fork')
  assert.equal(plan.action === 'fork' && plan.harness, 'claude')
})

// ── A REAPED SCRATCH DIRECTORY IS NOT A REASON TO REFUSE ──
//
// Until the lifecycle change, a finished one-off was fully erased fifteen
// minutes after its last turn — remove() fs.rm'd the task's home, which for a
// scratch task IS its cwd. The conversation survived (Claude keeps transcripts
// in ~/.claude/projects, Codex in ~/.codex/sessions, neither inside the task
// dir), so the session is perfectly resumable — but the directory it names is
// gone, and refusing on that made the resume feature unable to recover from
// the exact bug that most needed recovering from.
//
// The distinction that matters: Unmute OWNS the scratch directory. Its absence
// means the task was reaped, and recreating an empty one is faithful — there
// was never anything in it worth keeping. A user's own project directory is
// different: if that is gone, something happened outside Unmute and guessing
// is not ours to do.

const LOCAL = '/Users/me/.unmute/remote/local'

test('a missing scratch cwd is recreated rather than refused', () => {
  assert.equal(isReapedScratchCwd(`${LOCAL}/254ba44a-da34-4eeb-8274-bbfd178137c5`, LOCAL), true)
})

test('a missing project directory is not ours to recreate', () => {
  assert.equal(isReapedScratchCwd('/Users/me/tools/unmute/unmute-cloud', LOCAL), false)
})

test('a path that merely mentions the scratch root is not inside it', () => {
  assert.equal(isReapedScratchCwd('/Users/me/notes/.unmute/remote/local-notes', LOCAL), false)
})

test('the scratch root itself is not a task directory', () => {
  assert.equal(isReapedScratchCwd(LOCAL, LOCAL), false)
})
