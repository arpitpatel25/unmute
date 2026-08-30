import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planResume } from './resume.ts'
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
