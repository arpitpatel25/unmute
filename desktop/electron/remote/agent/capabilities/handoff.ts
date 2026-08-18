import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'

/**
 * Handing outside work to the Orchestrator.
 *
 * THE LINE IS INSIDE VERSUS OUTSIDE, not small versus complex — consolidating
 * four sessions is neither small nor simple, yet it is entirely inside. Inside
 * is a closed set: the Agent's own memory, the user's session history, and the
 * Unmute objects it can create. Everything else in the world is outside, and
 * outside work becomes a task.
 *
 * Outside work is never REFUSED, it is handed off. In the field the Agent was
 * asked to send a message and could only report that it had no way to; with
 * this it creates a task that can, and says so.
 *
 * WHAT IT MUST NEVER SAY is that the work is done. "I've made a task to send
 * it" — never "I've sent it." For a surface with no window to inspect, a false
 * success is the worst failure available: the user has only the sentence they
 * were given.
 */

const MAX_INTENT_LENGTH = 2_000

const tools = [
  {
    name: 'task_create',
    description: 'Hand work to a new Orchestrator session — anything that touches the world'
      + ' outside Unmute: sending, messaging, driving another application, writing code or'
      + ' documents, editing files. The task appears immediately as a card the user can watch.'
      + ' You do NOT do the work and you do NOT wait for it: say that you have made a task,'
      + ' never that the thing is done.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['intent'],
      properties: {
        intent: {
          type: 'string', minLength: 1, maxLength: MAX_INTENT_LENGTH,
          description: 'What the person asked for, in their own terms — and NOTHING MORE.'
            + ' Do not add steps, places to search, or precautions they did not mention:'
            + ' a one-sentence request becomes a one-sentence task. The session that picks'
            + ' this up is fully tooled, so every extra clause you invent is work it will'
            + ' actually go and do.',
        },
        sourceSessionIds: {
          type: 'array',
          description: 'Sessions whose content this task should start from — how a'
            + ' consolidation is expressed. Omit for ordinary work.',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'task_status',
    description: 'Check a task you created. Read-only; you do not manage it, the user does.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId'],
      properties: {
        taskId: { type: 'string', minLength: 1, description: 'The id task_create returned.' },
      },
    },
    consequence: 'read',
  },
] as const satisfies readonly ToolDefinition[]

export interface HandoffAdapters {
  /** Creates a real Orchestrator task. Records origin so the card can show
   *  that the Agent made it and not the user (Law IV). */
  createTask(input: {
    intent: string
    agentRunId: string
    sourceSessionIds?: readonly string[]
  }): Promise<{ taskId: string }>
  taskStatus(taskId: string): Promise<{ state: string; intent: string } | null>
}

export type HandoffErrorCode = 'access-denied' | 'invalid-input' | 'handoff-failed' | 'not-found'

const MESSAGES: Record<HandoffErrorCode, string> = {
  'access-denied': 'Task creation is unavailable',
  'invalid-input': 'Task input is invalid',
  'handoff-failed': 'The task could not be created',
  'not-found': 'That task was not found',
}

function fail(code: HandoffErrorCode): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: MESSAGES[code] } }) }],
    isError: true,
  }
}

function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }
}

export class HandoffCapability implements CapabilityModule {
  readonly id = 'handoff'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  constructor(private readonly adapters: HandoffAdapters) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    // The same boundary as everything else the Agent does: a live interaction
    // the user started, matching the principal it was issued to. A background
    // run cannot create tasks in the user's name.
    if (
      ctx.principal.kind !== 'unmute-agent'
      || ctx.principal.expiresAt <= ctx.now
      || ctx.interaction?.active !== true
      || ctx.interaction.id !== ctx.principal.interactionId
    ) return fail('access-denied')

    const value = (input ?? {}) as Record<string, unknown>
    try {
      if (tool === 'task_create') {
        const intent = typeof value.intent === 'string' ? value.intent.trim() : ''
        if (!intent || intent.length > MAX_INTENT_LENGTH) return fail('invalid-input')
        const sources = value.sourceSessionIds
        if (sources !== undefined && (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string' || !s))) {
          return fail('invalid-input')
        }
        const created = await this.adapters.createTask({
          intent,
          agentRunId: ctx.principal.runId,
          ...(sources ? { sourceSessionIds: sources as string[] } : {}),
        })
        return ok({ taskId: created.taskId, status: 'created' })
      }

      if (tool === 'task_status') {
        const taskId = typeof value.taskId === 'string' ? value.taskId : ''
        if (!taskId) return fail('invalid-input')
        const status = await this.adapters.taskStatus(taskId)
        return status ? ok(status) : fail('not-found')
      }

      return fail('invalid-input')
    } catch {
      // Typed and detail-free, like every other capability failure: a driver
      // message could carry a path.
      return fail('handoff-failed')
    }
  }
}
