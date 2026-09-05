import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'

/**
 * `sessions_list`, `sessions_search` and `session_read` were MCP tools over
 * data the Agent can already open — `Read`, `Glob` and `Grep` are in its
 * allowlist, and a tool over readable data caps the Agent at the queries its
 * schema author imagined: `search(query: string)` cannot express "everything
 * in unmute-cloud from Tuesday that mentions the notch", which is one grep.
 * The transcripts on disk are the record, and the constitution names them.
 *
 * `session_continue_in` went for a different reason. It built a seed prompt in
 * TypeScript — `It began: … It last said: …` — a fixed template standing in for
 * a judgement call. The Agent composes context itself and passes it to
 * `task_create`, which is the general operation; resuming is the narrow case.
 *
 * Resume and fork are here because they are provider identity operations the
 * Agent cannot perform through filesystem tools. They remain separate so one
 * can never silently degrade into the other.
 */

const tools = [
  {
    name: 'session_resume',
    description: 'Pick a past session back up where it left off, keeping its entire history.'
      + ' Works for ANY session on this machine, including ones Unmute never started, and it'
      + ' appears as a card the user can watch. This is the right tool when they say "carry on'
      + ' with that", "add this to the doc we made", or name work they already did — find the'
      + ' session yourself in the transcripts on disk first, then resume it by id. Only for'
      + ' continuing in the SAME harness: to carry work into a different one, compose the'
      + ' context yourself and use task_create. Say you have reopened it only once this'
      + ' returns a task id.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string', minLength: 1,
          description: 'The id of a session you found on disk — a Claude transcript is named'
            + ' after it, and a Codex rollout filename ends with it. Give it in full: a'
            + ' truncated id is refused rather than matched to a neighbouring session.',
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
  {
    name: 'session_fork',
    description: 'Create an independent child of one exact past session using the provider\'s'
      + ' native fork operation. Use only when the user asks for an alternate path, branch, or'
      + ' wants the original preserved. Find the full source id in transcripts first. This is'
      + ' not a resume and never falls back to a blank task.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string', minLength: 1,
          description: 'The full exact provider session id to fork.',
        },
        intent: {
          type: 'string', maxLength: 2000,
          description: 'The user\'s current request for the child. Omit to fork without adding a turn.',
        },
      },
    },
    consequence: 'reversible-write',
  },
] as const satisfies readonly ToolDefinition[]

export interface SessionActionResult {
  taskId: string
  operation: 'resume' | 'fork'
  sourceSessionId: string
  sessionId: string
}

export interface SessionAdapters {
  resume(input: { sessionId: string; intent?: string }): Promise<SessionActionResult>
  fork(input: { sessionId: string; intent?: string }): Promise<SessionActionResult>
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
    if (tool !== 'session_resume' && tool !== 'session_fork') {
      return fail('unknown-tool', `Unknown tool: ${tool}`)
    }

    const value = (input ?? {}) as Record<string, unknown>
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
    if (!sessionId) return fail('invalid-input', 'Session query is invalid')
    const intent = typeof value.intent === 'string' ? value.intent.trim() : ''
    if (intent.length > 2000) return fail('invalid-input', 'Session query is invalid')

    try {
      const operation = tool === 'session_resume' ? 'resume' : 'fork'
      const result = await this.adapters[operation]({
        sessionId,
        ...(intent ? { intent } : {}),
      })
      if (result.operation !== operation || result.sourceSessionId !== sessionId) {
        throw new Error(`Provider returned inconsistent ${operation} identity`)
      }
      if (operation === 'resume' && result.sessionId !== sessionId) {
        throw new Error('Resume changed the provider session identity')
      }
      if (operation === 'fork' && result.sessionId === sessionId) {
        throw new Error('Fork reused the source provider session identity')
      }
      return ok(result)
    } catch (error) {
      return fail(`${tool === 'session_resume' ? 'resume' : 'fork'}-failed`,
        (error as Error).message || `That session could not be ${tool === 'session_resume' ? 'resumed' : 'forked'}`)
    }
  }
}
