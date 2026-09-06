import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'
import type { SessionCatalogEntry } from '../sessions/catalog.ts'
import { requireAgentMetadata, requireWorkspaceLabel } from '../metadata'

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
    name: 'workspaces_create',
    description: 'Deliberately create a workspace when workspaces_list has no suitable existing workspace. Matching labels reuse the canonical existing workspace.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['group'], properties: { group: { type: 'string', minLength: 1, maxLength: 32 } } },
    consequence: 'reversible-write',
  },
  {
    name: 'workspaces_list',
    description: 'List existing canonical workspace ids and labels to use when creating, resuming, or forking a conversation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    consequence: 'read',
  },
  {
    name: 'sessions_search',
    description: 'Search a bounded on-demand projection of Claude and Codex transcripts by'
      + ' user-turn text and project. Returns full exact session ids, provider, cwd, time,'
      + ' matching user text, and artifact references. Use it to find likely work quickly;'
      + ' use Glob, Grep, and Read on raw transcripts when the query needs more precision.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
    consequence: 'read',
  },
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
      type: 'object', additionalProperties: false, required: ['sessionId', 'title', 'group'],
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 160, description: 'Descriptive title; preserve the source title from sessions_search when present. Never sent as a message.' },
        group: { type: 'string', minLength: 1, maxLength: 32, description: 'Exact existing workspace label from workspaces_list. Preserve the source workspace when present.' },
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
      type: 'object', additionalProperties: false, required: ['sessionId', 'title', 'group'],
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 160, description: 'Descriptive title; preserve the source title from sessions_search when present. Never sent as a message.' },
        group: { type: 'string', minLength: 1, maxLength: 32, description: 'Exact existing workspace label from workspaces_list. Preserve the source workspace when present.' },
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
  createWorkspace(group: string): Promise<{ id: string; label: string }>
  workspaces(): Promise<Array<{ id: string; label: string }>>
  search(input: { query: string; limit?: number }): Promise<SessionCatalogEntry[]>
  resume(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult>
  fork(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult>
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

export class SessionsCapability implements CapabilityModule {
  readonly id = 'sessions'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  constructor(private readonly adapters: SessionAdapters) {}
  private operations = new Map<string, { expiresAt: number; result: Promise<ToolResult> }>()

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    if (ctx.principal.kind !== 'unmute-agent' || ctx.principal.expiresAt <= ctx.now) {
      return fail('access-denied', 'Session history is unavailable')
    }
    if (tool === 'workspaces_create') {
      if (ctx.interaction?.active !== true || ctx.interaction.id !== ctx.principal.interactionId) return fail('access-denied', 'Workspace creation requires an active interaction')
      let group: string
      try { group = requireWorkspaceLabel((input as Record<string, unknown>)?.group) }
      catch (error) { return fail('invalid-input', (error as Error).message) }
      try { return ok(await this.adapters.createWorkspace(group)) }
      catch { return fail('workspace-failed', 'Workspace could not be created') }
    }
    if (tool === 'workspaces_list') {
      try { return ok(await this.adapters.workspaces()) }
      catch { return fail('search-failed', 'Workspaces could not be listed') }
    }
    if (tool === 'sessions_search') {
      const value = (input ?? {}) as Record<string, unknown>
      const query = typeof value.query === 'string' ? value.query.trim() : ''
      const limit = value.limit === undefined ? undefined : value.limit
      if (query.length < 2 || query.length > 500
        || limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 25)) {
        return fail('invalid-input', 'Session query is invalid')
      }
      try {
        return ok(await this.adapters.search({ query, ...(typeof limit === 'number' ? { limit } : {}) }))
      } catch (error) {
        return fail('search-failed', (error as Error).message || 'Sessions could not be searched')
      }
    }
    if (tool !== 'session_resume' && tool !== 'session_fork') {
      return fail('unknown-tool', `Unknown tool: ${tool}`)
    }

    const value = (input ?? {}) as Record<string, unknown>
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
    if (!sessionId) return fail('invalid-input', 'Session query is invalid')
    const intent = typeof value.intent === 'string' ? value.intent.trim() : ''
    if (intent.length > 2000) return fail('invalid-input', 'Session query is invalid')
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    const group = typeof value.group === 'string' ? value.group.trim() : ''
    for (const [key, entry] of this.operations) if (entry.expiresAt <= ctx.now) this.operations.delete(key)
    const key = JSON.stringify([ctx.principal.runId, ctx.principal.interactionId, tool, sessionId])
    const previous = this.operations.get(key)
    if (previous) return previous.result
    try { requireAgentMetadata({ title, group }) } catch (error) { return fail('invalid-input', (error as Error).message) }
    const pending = (async (): Promise<ToolResult> => {
    try {
      const operation = tool === 'session_resume' ? 'resume' : 'fork'
      const result = await this.adapters[operation]({
        sessionId,
        ...(intent ? { intent } : {}),
        ...(title ? { title } : {}),
        ...(group ? { group } : {}),
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
        `${(error as Error).message || 'Continuation failed'}. Do not retry this operation in this interaction or create a replacement task.`)
    }
    })()
    this.operations.set(key, { expiresAt: ctx.principal.expiresAt, result: pending })
    return pending
  }
}
