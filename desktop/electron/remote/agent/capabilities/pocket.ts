import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'

/**
 * THE POCKET, BY VOICE. The same four things the person can do to a card with
 * their hands — rename it, stop what it is doing, end its session, take it out
 * of the pocket — for the Agent, over the tasks in front of them and nothing
 * else. Every write calls the function the card's own button calls; none of
 * them deletes anything.
 *
 * The pocket is the only place these reach. A task that is not in it is
 * refused rather than looked up elsewhere, because "the one where I fixed the
 * mic" is a description of something the person can SEE, and acting on a card
 * they cannot see is how the wrong thing gets renamed.
 */

/** The Agent's own card sits in the pocket beside the tasks. It is not one. */
export const AGENT_SLOT_ID = 'unmute-agent'
export const MAX_TASK_NAME_LENGTH = 48
const NOT_IN_POCKET = 'No task with that id is in the pocket. Do not retry; tell the person.'

const taskIdSchema = { type: 'string', minLength: 1, maxLength: 128, description: 'The task id exactly as pocket_list reports it.' }

const tools = [
  {
    name: 'pocket_list',
    description: 'The tasks in the pocket right now — the cards in front of the person — and nothing'
      + ' else. Each carries enough to match a loose description in one call: its title, the'
      + ' original request (intent), state, whether it is working, the result summary if it has one,'
      + ' and the last few things the person said to it. Read this before task_rename, task_stop,'
      + ' task_end or task_hide, and match on all of it, not the title alone.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    consequence: 'read',
  },
  {
    name: 'task_rename',
    description: 'Rename a task in the pocket, as if the person had renamed the card themselves.'
      + ` Names longer than ${MAX_TASK_NAME_LENGTH} characters are cut.`,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId', 'name'],
      properties: { taskId: taskIdSchema, name: { type: 'string', minLength: 1, maxLength: 160 } },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'task_stop',
    description: 'Stop the turn a task in the pocket is running — the card\'s Stop button. The card,'
      + ' its conversation and its session stay; the person can send it something new. A task that'
      + ' is not working is left alone and reported as not running.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: taskIdSchema } },
    consequence: 'reversible-write',
  },
  {
    name: 'task_end',
    description: 'End a pocket task\'s session: interrupt any turn and release its process. The'
      + ' conversation is KEPT and can be resumed; nothing is deleted.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: taskIdSchema } },
    consequence: 'reversible-write',
  },
  {
    name: 'task_hide',
    description: 'Take a task out of the pocket without deleting it — "remove it from the pocket",'
      + ' "get that off my screen". The task and its conversation stay, and a resume brings it back.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: taskIdSchema } },
    consequence: 'reversible-write',
  },
] as const satisfies readonly ToolDefinition[]

export interface PocketTaskEntry {
  taskId: string
  /** The card's name as it is, descriptive or not — it is what they see. */
  title?: string
  /** The original request, truncated. */
  intent: string
  state: string
  /** Mid-turn right now. */
  working: boolean
  /** The process is warm. */
  live: boolean
  provider?: 'claude' | 'codex'
  cwd?: string
  workspace?: string
  updatedAt: number
  /** The task's own result summary, when it reported one. */
  result?: string
  /** The last few things the person said to it, newest last. */
  recentUserTurns: string[]
}

/** Every write returns null when the task is not in the pocket. */
export interface PocketAdapters {
  list(): Promise<PocketTaskEntry[]>
  rename(input: { taskId: string; name: string }): Promise<{ taskId: string; name: string } | null>
  stop(input: { taskId: string }): Promise<{ taskId: string; stopped: boolean; message?: string } | null>
  end(input: { taskId: string }): Promise<{ taskId: string; ended: boolean } | null>
  hide(input: { taskId: string }): Promise<{ taskId: string; hidden: boolean } | null>
}

function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }
}
function fail(code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message, retryable: false } }) }],
    isError: true,
  }
}

export class PocketCapability implements CapabilityModule {
  readonly id = 'pocket'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  constructor(private readonly adapters: PocketAdapters) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    if (ctx.principal.kind !== 'unmute-agent' || ctx.principal.expiresAt <= ctx.now) {
      return fail('access-denied', 'The pocket is unavailable')
    }
    if (tool === 'pocket_list') {
      try { return ok(await this.adapters.list()) }
      catch { return fail('list-failed', 'The pocket could not be read') }
    }
    if (tool !== 'task_rename' && tool !== 'task_stop' && tool !== 'task_end' && tool !== 'task_hide') {
      return fail('unknown-tool', `Unknown tool: ${tool}`)
    }
    if (ctx.interaction?.active !== true || ctx.interaction.id !== ctx.principal.interactionId) {
      return fail('access-denied', 'Changing a pocket task requires an active interaction')
    }
    const value = (input ?? {}) as Record<string, unknown>
    const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : ''
    if (!taskId || taskId.length > 128) return fail('invalid-input', 'Task id is invalid')
    if (taskId === AGENT_SLOT_ID) return fail('not-a-task', 'That is your own card, not a task. Do not retry; tell the person.')
    try {
      let result: unknown
      if (tool === 'task_rename') {
        const name = typeof value.name === 'string' ? value.name.trim().slice(0, MAX_TASK_NAME_LENGTH).trim() : ''
        if (!name) return fail('invalid-input', 'A rename needs a name')
        result = await this.adapters.rename({ taskId, name })
      } else if (tool === 'task_stop') result = await this.adapters.stop({ taskId })
      else if (tool === 'task_end') result = await this.adapters.end({ taskId })
      else result = await this.adapters.hide({ taskId })
      if (result === null || result === undefined) return fail('not-in-pocket', NOT_IN_POCKET)
      return ok(result)
    } catch (error) {
      return fail(`${tool.slice('task_'.length)}-failed`,
        `${(error as Error).message || 'That task could not be changed'}. Do not retry this in this interaction.`)
    }
  }
}
