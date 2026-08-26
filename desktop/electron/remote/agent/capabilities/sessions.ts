import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'

/**
 * ONE TOOL, because only one of these ever needed the app.
 *
 * `sessions_list`, `sessions_search` and `session_read` were MCP tools over a
 * plaintext file the Agent can already open — `Read`, `Glob` and `Grep` are in
 * its allowlist. A tool over readable data caps the Agent at the queries its
 * schema author imagined: `search(query: string)` cannot express "everything in
 * unmute-cloud from Tuesday that mentions the notch", which is one grep. They
 * are replaced by the record at `sessions/recent-sessions.md` and an
 * instruction naming it.
 *
 * `session_continue_in` went for a different reason. It built a seed prompt in
 * TypeScript — `It began: … It last said: …` — a fixed template standing in for
 * a judgement call. The Agent composes context itself now and passes it to
 * `task_create`, which is the general operation; resuming is the narrow case.
 *
 * Resuming survives because it is the one thing here the Agent genuinely
 * cannot do: it needs a spawned process carrying `--resume`, and a card.
 */

const tools = [
  {
    name: 'session_resume',
    description: 'Pick a past session back up where it left off, keeping its entire history.'
      + ' Works for ANY session on this machine, including ones Unmute never started, and it'
      + ' appears as a card the user can watch. This is the right tool when they say "carry on'
      + ' with that", "add this to the doc we made", or name work they already did — find the'
      + ' session in the record first, then resume it by id. Only for continuing in the SAME'
      + ' harness: to carry work into a different one, compose the context yourself and use'
      + ' task_create. Say you have reopened it only once this returns a task id.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string', minLength: 1,
          description: 'An id from the session record, or from a transcript you read.',
        },
        intent: {
          type: 'string', maxLength: 2000,
          description: 'What to do next in that session, in the user\'s own terms and nothing'
            + ' more. Omit to reopen it without saying anything.',
        },
      },
    },
    consequence: 'reversible-write',
  },
] as const satisfies readonly ToolDefinition[]

export interface SessionAdapters {
  /** Wakes an existing card, or forks an unowned session into a new one. */
  resume(input: { sessionId: string; intent?: string }): Promise<{ taskId: string }>
}

function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }
}
function fail(code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }) }],
    isError: true,
  }
}

export class SessionsCapability implements CapabilityModule {
  readonly id = 'sessions'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  constructor(private readonly adapters: SessionAdapters) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    if (ctx.principal.kind !== 'unmute-agent' || ctx.principal.expiresAt <= ctx.now) {
      return fail('access-denied', 'Session history is unavailable')
    }
    if (tool !== 'session_resume') return fail('unknown-tool', `Unknown tool: ${tool}`)

    const value = (input ?? {}) as Record<string, unknown>
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
    if (!sessionId) return fail('invalid-input', 'Session query is invalid')
    const intent = typeof value.intent === 'string' ? value.intent.trim() : ''
    if (intent.length > 2000) return fail('invalid-input', 'Session query is invalid')

    try {
      const { taskId } = await this.adapters.resume({
        sessionId,
        ...(intent ? { intent } : {}),
      })
      return ok({ taskId, resumed: sessionId })
    } catch (error) {
      return fail('resume-failed', (error as Error).message || 'That session could not be resumed')
    }
  }
}
