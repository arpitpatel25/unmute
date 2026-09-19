import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'

/**
 * THE POCKET, BY VOICE. The same four things the person can do to a card with
 * their hands — rename it, stop what it is doing, end its session, remove it
 * from the pocket — for the Agent, over the tasks in front of them and nothing
 * else. Every write calls the function the card's own button calls; none of
 * them deletes anything.
 *
 * The pocket is the only place these reach. A task that is not in it is
 * refused rather than looked up elsewhere, because "the one where I fixed the
 * mic" is a description of something the person can SEE, and acting on a card
 * they cannot see is how the wrong thing gets renamed.
 *
 * ONE EXCEPTION, AND IT IS THE ORCHESTRATOR'S: task_delete. Delete lives in the
 * orchestrator (its "Delete from Unmute…"), which holds every task, so it may
 * name any task Unmute has — and because it is the only thing here that cannot
 * be undone, it refuses unless called with `confirmed: true`, which the
 * constitution allows only after the person confirmed in a later turn.
 */

/** The Agent's own card sits in the pocket beside the tasks. It is not one. */
export const AGENT_SLOT_ID = 'unmute-agent'
export const MAX_TASK_NAME_LENGTH = 48
const NOT_IN_POCKET = 'No task with that id is in the pocket. Do not retry; tell the person.'
const NOT_HELD = 'Unmute is not holding a task with that id. Do not retry; tell the person.'
const POCKET_WRITES = ['task_rename', 'task_stop', 'task_end', 'task_remove_from_pocket'] as const

const taskIdSchema = { type: 'string', minLength: 1, maxLength: 128, description: 'The task id exactly as pocket_list reports it.' }

const tools = [
  {
    name: 'pocket_list',
    description: 'The tasks in the pocket right now — the cards in front of the person — and nothing'
      + ' else. Each carries enough to match a loose description in one call: its title, the'
      + ' original request (intent), state, whether it is working, the result summary if it has one,'
      + ' and the last few things the person said to it. Read this before task_rename, task_stop,'
      + ' task_end or task_remove_from_pocket, and match on all of it, not the title alone.',
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
    name: 'task_remove_from_pocket',
    description: 'Remove a task from the pocket — "remove it", "take it off the pocket", "close it",'
      + ' "clear these". It only leaves the pocket: it keeps running, it stays in the orchestrator'
      + ' like any other task, and nothing is deleted. It comes back to the pocket by itself when it'
      + ' needs the person, or when it is opened or sent something.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: taskIdSchema } },
    consequence: 'reversible-write',
  },
  {
    name: 'task_delete',
    description: 'Delete a task from Unmute — the orchestrator\'s "Delete from Unmute…". It stops the'
      + ' task and removes it everywhere in Unmute; the provider\'s own conversation history stays on'
      + ' disk. Only when the person explicitly says DELETE — never for remove, hide, close or clear.'
      + ' Any task Unmute holds, not only the pocket. Refused unless confirmed is true, and true only'
      + ' after the person confirmed, in a later turn, what you told them would be deleted.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId', 'confirmed'],
      properties: {
        taskId: { ...taskIdSchema, description: 'The task id, from pocket_list or sessions_open.' },
        confirmed: { type: 'boolean', description: 'True only after the person confirmed this delete in a later turn.' },
      },
    },
    // NOT 'destructive', though it is. A destructive consequence is refused for
    // every voice turn (policy.ts), which would make the orchestrator's delete
    // unreachable by voice at all. The gate is the explicit `confirmed: true`
    // below plus the constitution's ask-first rule — not the consequence class.
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
  removeFromPocket(input: { taskId: string }): Promise<{ taskId: string; removedFromPocket: boolean } | null>
  /** Null when Unmute holds no such task (any task, not only the pocket). */
  delete(input: { taskId: string }): Promise<{ taskId: string; deleted: boolean; name?: string } | null>
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
    if (!(POCKET_WRITES as readonly string[]).includes(tool) && tool !== 'task_delete') {
      return fail('unknown-tool', `Unknown tool: ${tool}`)
    }
    if (ctx.interaction?.active !== true || ctx.interaction.id !== ctx.principal.interactionId) {
      return fail('access-denied', 'Changing a pocket task requires an active interaction')
    }
    const value = (input ?? {}) as Record<string, unknown>
    const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : ''
    if (!taskId || taskId.length > 128) return fail('invalid-input', 'Task id is invalid')
    if (taskId === AGENT_SLOT_ID) return fail('not-a-task', 'That is your own card, not a task. Do not retry; tell the person.')
    if (tool === 'task_delete' && value.confirmed !== true) {
      return fail('confirmation-required', 'Deleting needs the person\'s confirmation first. Tell them which task'
        + ' will be deleted — it stops and is removed from Unmute everywhere — and ask them to confirm.'
        + ' Call again with confirmed: true only after they confirm in a later turn.')
    }
    try {
      let result: unknown
      if (tool === 'task_rename') {
        const name = typeof value.name === 'string' ? value.name.trim().slice(0, MAX_TASK_NAME_LENGTH).trim() : ''
        if (!name) return fail('invalid-input', 'A rename needs a name')
        result = await this.adapters.rename({ taskId, name })
      } else if (tool === 'task_stop') result = await this.adapters.stop({ taskId })
      else if (tool === 'task_end') result = await this.adapters.end({ taskId })
      else if (tool === 'task_remove_from_pocket') result = await this.adapters.removeFromPocket({ taskId })
      else {
        result = await this.adapters.delete({ taskId })
        if (result === null || result === undefined) return fail('not-found', NOT_HELD)
      }
      if (result === null || result === undefined) return fail('not-in-pocket', NOT_IN_POCKET)
      return ok(result)
    } catch (error) {
      return fail(`${tool.slice('task_'.length)}-failed`,
        `${(error as Error).message || 'That task could not be changed'}. Do not retry this in this interaction.`)
    }
  }
}
