import { randomUUID } from 'node:crypto'
import { devEvent } from './curator-devlog'

export type TaskReplySource = 'task-composer' | 'right-option' | 'scratchpad-open-task' | 'internal'
export type TaskReplyOutcome = 'started' | 'succeeded' | 'failed' | 'refused' | 'timed-out' | 'retained'

export interface TaskReplyTraceLogger {
  event(name: string, fields: Record<string, unknown>): void
}

export interface TaskReplyTrace {
  attemptId: string
  taskId: string
  draftId: string | null
  source: TaskReplySource
  startedAt: number
  now: () => number
}

interface BeginFields {
  taskId: string
  draftId?: string | null
  source: TaskReplySource
  textChars: number
  attachments: number
}

interface BeginOptions {
  attemptId?: string
  now?: () => number
}

function base(trace: TaskReplyTrace, now = Date.now()): Record<string, unknown> {
  return {
    attemptId: trace.attemptId,
    taskId: trace.taskId,
    draftId: trace.draftId,
    source: trace.source,
    elapsedMs: Math.max(0, now - trace.startedAt),
  }
}

/** Dev-only breadcrumbs before a delivery attempt exists (typing, paste and
 * capture staging). `draftId` joins them to the later attempt. */
export function emitTaskReplyInput(
  log: TaskReplyTraceLogger,
  fields: Record<string, unknown> & { taskId: string; draftId: string; source: TaskReplySource; action: string },
): void {
  devEvent(log, 'task-reply-input', fields)
}

/** Start one end-to-end delivery attempt. Every provider boundary receives this
 * same immutable context, making concurrent task replies separable in logs. */
export function beginTaskReplyTrace(
  log: TaskReplyTraceLogger,
  fields: BeginFields,
  options: BeginOptions = {},
): TaskReplyTrace {
  const now = options.now ?? Date.now
  const trace: TaskReplyTrace = {
    attemptId: options.attemptId ?? randomUUID(),
    taskId: fields.taskId,
    draftId: fields.draftId ?? null,
    source: fields.source,
    startedAt: now(),
    now,
  }
  devEvent(log, 'task-reply-trace', {
    ...base(trace, trace.startedAt), stage: 'attempt', outcome: 'started',
    textChars: fields.textChars, attachments: fields.attachments,
  })
  return trace
}

export function emitTaskReplyStep(
  log: TaskReplyTraceLogger,
  trace: TaskReplyTrace,
  stage: string,
  outcome: TaskReplyOutcome,
  fields: Record<string, unknown> = {},
  now: () => number = trace.now,
): void {
  devEvent(log, 'task-reply-trace', { ...base(trace, now()), stage, outcome, ...fields })
}

export function finishTaskReplyTrace(
  log: TaskReplyTraceLogger,
  trace: TaskReplyTrace,
  outcome: Exclude<TaskReplyOutcome, 'started'>,
  fields: Record<string, unknown> = {},
  now: () => number = trace.now,
): void {
  emitTaskReplyStep(log, trace, 'attempt', outcome, fields, now)
}
