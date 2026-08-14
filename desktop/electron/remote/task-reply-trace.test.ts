import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginTaskReplyTrace,
  emitTaskReplyInput,
  emitTaskReplyStep,
  finishTaskReplyTrace,
  type TaskReplyTraceLogger,
} from './task-reply-trace'

function collectingLogger(seen: Array<[string, Record<string, unknown>]>): TaskReplyTraceLogger {
  return { event: (name, fields) => { seen.push([name, fields]) } }
}

test('task reply diagnostics are completely disabled outside dev builds', () => {
  const previous = process.env.UNMUTE_CURATOR_DEVLOG
  const seen: Array<[string, Record<string, unknown>]> = []
  try {
    delete process.env.UNMUTE_CURATOR_DEVLOG
    const log = collectingLogger(seen)
    emitTaskReplyInput(log, { taskId: 'task-1', draftId: 'draft-1', source: 'task-composer', action: 'text-edited' })
    const trace = beginTaskReplyTrace(log, {
      taskId: 'task-1', draftId: 'draft-1', source: 'task-composer',
      textChars: 12, attachments: 1,
    }, { attemptId: 'attempt-1', now: () => 100 })
    emitTaskReplyStep(log, trace, 'provider-selected', 'succeeded', { agent: 'codex-desktop' })
    finishTaskReplyTrace(log, trace, 'failed', { reason: 'not-confirmed' }, () => 140)
    assert.deepEqual(seen, [])
  } finally {
    if (previous === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = previous
  }
})

test('one attempt id correlates input, transport steps, timing and final disposition', () => {
  const previous = process.env.UNMUTE_CURATOR_DEVLOG
  const seen: Array<[string, Record<string, unknown>]> = []
  try {
    process.env.UNMUTE_CURATOR_DEVLOG = '1'
    const log = collectingLogger(seen)
    emitTaskReplyInput(log, {
      taskId: 'task-1', draftId: 'draft-1', source: 'right-option', action: 'capture-staged',
      textChars: 12, attachments: 2,
    })
    const trace = beginTaskReplyTrace(log, {
      taskId: 'task-1', draftId: 'draft-1', source: 'right-option',
      textChars: 12, attachments: 2,
    }, { attemptId: 'attempt-1', now: () => 100 })
    emitTaskReplyStep(log, trace, 'provider-selected', 'succeeded', {
      agent: 'codex', model: 'gpt-5.6-sol high', transport: 'codex-app-server',
    })
    finishTaskReplyTrace(log, trace, 'succeeded', { draftDisposition: 'cleared' }, () => 145)

    assert.equal(seen.length, 4)
    assert.deepEqual(seen[0], ['task-reply-input', {
      taskId: 'task-1', draftId: 'draft-1', source: 'right-option', action: 'capture-staged',
      textChars: 12, attachments: 2,
    }])
    assert.deepEqual(seen.slice(1).map(([, fields]) => fields.attemptId), ['attempt-1', 'attempt-1', 'attempt-1'])
    assert.deepEqual(seen[1], ['task-reply-trace', {
      attemptId: 'attempt-1', taskId: 'task-1', draftId: 'draft-1', source: 'right-option',
      stage: 'attempt', outcome: 'started', elapsedMs: 0, textChars: 12, attachments: 2,
    }])
    assert.deepEqual(seen[2][1], {
      attemptId: 'attempt-1', taskId: 'task-1', draftId: 'draft-1', source: 'right-option',
      stage: 'provider-selected', outcome: 'succeeded', elapsedMs: 0,
      agent: 'codex', model: 'gpt-5.6-sol high', transport: 'codex-app-server',
    })
    assert.deepEqual(seen[3][1], {
      attemptId: 'attempt-1', taskId: 'task-1', draftId: 'draft-1', source: 'right-option',
      stage: 'attempt', outcome: 'succeeded', elapsedMs: 45, draftDisposition: 'cleared',
    })
  } finally {
    if (previous === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = previous
  }
})
