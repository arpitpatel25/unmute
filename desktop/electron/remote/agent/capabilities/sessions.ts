import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types.ts'
import { requireAgentMetadata, requireWorkspaceLabel } from '../metadata'
import { emitOnboardingReceipt } from '../../../onboarding/receipts'

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
 * `sessions_search` came BACK after that and had to go again. It read 64 KB
 * from the head of a transcript and 64 KB from the tail and dropped the
 * middle — 0.369% of a real 33.9 MB session — then required every token of the
 * query to match, so "opened" or "wrong" discarded a session outright. It
 * returned a confident nothing, 22 times, for a session that was on disk the
 * whole time. What replaced it is a file: the user's own turns, verbatim, at
 * ~/.unmute/remote/session-index/. Grepping that file by hand then failed in
 * its own way (2026-09-18: a capped grep in file order never reached the
 * sessions that mattered), so it is now also searched whole by index_search
 * in index-search.ts — complete on every call, and never in place of Grep.
 *
 * Resume and fork are here because they are provider identity operations the
 * Agent cannot perform through filesystem tools. They remain separate so one
 * can never silently degrade into the other. `sessions_open` and
 * `session_close` are here for the same reason: only the app knows what is
 * open, and only the app can take a card back.
 */

const MAX_INTENT_LENGTH = 2_000
/** Carried context is sized like a handoff's, because it is the same thing
 *  arriving at a session that already exists rather than a new one. */
const MAX_RELAY_CONTEXT_LENGTH = 24_000
const MAX_RELAY_SOURCES = 12
const MAX_RELAY_ARTIFACTS = 32
const SOURCE_PROVIDERS = new Set(['claude', 'codex'])
const ARTIFACT_KINDS = new Set(['file', 'url', 'identifier'])

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
        title: { type: 'string', minLength: 3, maxLength: 160, description: 'Descriptive title; preserve the existing card title from sessions_open when present. Never sent as a message.' },
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
        title: { type: 'string', minLength: 3, maxLength: 160, description: 'Descriptive title; preserve the existing card title from sessions_open when present. Never sent as a message.' },
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
  {
    name: 'session_send',
    description: 'Say something in a session Unmute is ALREADY holding, in your own composed words.'
      + ' This is the tool for carrying work between conversations: the person names a card and'
      + ' wants what another session worked out brought into it — the approach that succeeded, the'
      + ' exact project or file it settled on, what was decided. Read the other sessions first,'
      + ' then write the message yourself. Takes the taskId of the destination card from'
      + ' sessions_open, never a provider session id. It speaks into that card and changes nothing'
      + ' else about it — no rename, no workspace change, and it never creates a card, so a taskId'
      + ' Unmute is not holding is refused rather than replaced with a new session. Use'
      + ' session_resume when the words are simply the person\'s own request to the session it'
      + ' reopens, and task_create when the work belongs in a NEW session.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId', 'intent'],
      properties: {
        taskId: {
          type: 'string', minLength: 1, maxLength: 128,
          description: 'The destination card, exactly as sessions_open reports it.',
        },
        intent: {
          type: 'string', minLength: 1, maxLength: MAX_INTENT_LENGTH,
          description: 'What the person wants done in that session now, in their own terms.',
        },
        context: {
          type: 'string', maxLength: MAX_RELAY_CONTEXT_LENGTH,
          description: 'What you read elsewhere that this session needs: decisions, the approach'
            + ' that worked, constraints, current state. Background, not instructions. Never put'
            + ' session ids in it — the receiving session cannot look them up.',
        },
        sourceSessions: {
          type: 'array', maxItems: MAX_RELAY_SOURCES,
          description: 'The exact sessions the context came from. Required whenever context is given.',
          items: {
            type: 'object', additionalProperties: false, required: ['sessionId', 'provider'],
            properties: {
              sessionId: { type: 'string', minLength: 36, maxLength: 36 },
              provider: { type: 'string', enum: ['claude', 'codex'] },
            },
          },
        },
        artifacts: {
          type: 'array', maxItems: MAX_RELAY_ARTIFACTS,
          description: 'Exact values to preserve: files, URLs, document or project identifiers.',
          items: {
            type: 'object', additionalProperties: false, required: ['kind', 'value'],
            properties: {
              kind: { type: 'string', enum: ['file', 'url', 'identifier'] },
              value: { type: 'string', minLength: 1, maxLength: 4096 },
              label: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'sessions_open',
    description: 'The sessions Unmute is holding right now, with two separate facts about each:'
      + ' `live` means its process is warm, so a follow-up needs no respawn; `inPocket` means it is'
      + ' in front of the person at this moment. They are independent — a sleeping session can be in'
      + ' the pocket and a warm one can have scrolled out of it — so say which you mean rather than'
      + ' "open". Nothing on disk records either. Titles and workspaces here are the existing ones;'
      + ' carry them through when you resume or fork.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    consequence: 'read',
  },
  {
    name: 'session_close',
    description: 'Remove a session card from the pocket — the undo for having opened the wrong'
      + ' one; the same act as task_remove_from_pocket. Takes the taskId of the card, not a provider'
      + ' session id. It deletes nothing: the task keeps running, stays in the orchestrator with its'
      + ' transcript, and comes back to the pocket when it needs the person or is opened, so never'
      + ' say the conversation was deleted. Closing one that is already gone succeeds quietly.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId'],
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 128 } },
    },
    consequence: 'reversible-write',
  },
] as const satisfies readonly ToolDefinition[]

/** A card that exists in Unmute right now. `live` is the process; `state` is
 *  what the card shows. Both are returned because "open" covers a session still
 *  running AND one parked waiting on the user. */
export interface OpenSessionEntry {
  taskId: string
  sessionId: string
  provider?: 'claude' | 'codex'
  cwd?: string
  title?: string
  workspace?: string
  state: string
  /** The process is warm — it can take a follow-up with no respawn. */
  live: boolean
  /** It is in the pocket right now, i.e. in front of them. Independent of
   *  `live`: a sleeping session can sit in the pocket, and a live one can have
   *  aged out of it. Saying "still open" when you mean "still warm" is the
   *  confusion this field exists to end. */
  inPocket: boolean
  updatedAt: number
}

export interface SessionActionResult {
  taskId: string
  operation: 'resume' | 'fork'
  sourceSessionId: string
  sessionId: string
  /** Present only when an intent was supplied. False means the session is open
   *  but the words are sitting in its composer, not sent. */
  delivered?: boolean
}

/** A relay's destination is a card, not a provider id, so it carries neither
 *  a source session nor a resulting one. `delivered:false` means the words are
 *  in that card's composer, unsent — the session is open either way. */
export interface SessionRelayResult {
  taskId: string
  operation: 'send'
  delivered: boolean
}

export interface SessionAdapters {
  createWorkspace(group: string): Promise<{ id: string; label: string }>
  workspaces(): Promise<Array<{ id: string; label: string }>>
  open(input: { limit?: number }): Promise<OpenSessionEntry[]>
  close(input: { taskId: string }): Promise<{ taskId: string; closed: boolean }>
  resume(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult>
  fork(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult>
  send(input: {
    taskId: string; intent: string; context?: string
    sourceSessions?: ReadonlyArray<{ sessionId: string; provider: 'claude' | 'codex' }>
    artifacts?: ReadonlyArray<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
  }): Promise<SessionRelayResult>
}

function relaySources(raw: unknown): Array<{ sessionId: string; provider: 'claude' | 'codex' }> | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_RELAY_SOURCES) throw new Error('Relay sources are invalid')
  return raw.map(entry => {
    const source = entry as { sessionId?: unknown; provider?: unknown }
    if (typeof source?.sessionId !== 'string' || source.sessionId.trim().length !== 36) throw new Error('A relay source needs a full exact session id')
    if (typeof source.provider !== 'string' || !SOURCE_PROVIDERS.has(source.provider)) throw new Error('A relay source needs its provider')
    return { sessionId: source.sessionId.trim(), provider: source.provider as 'claude' | 'codex' }
  })
}

function relayArtifacts(raw: unknown): Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }> | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_RELAY_ARTIFACTS) throw new Error('Relay artifacts are invalid')
  return raw.map(entry => {
    const artifact = entry as { kind?: unknown; value?: unknown; label?: unknown }
    if (typeof artifact?.kind !== 'string' || !ARTIFACT_KINDS.has(artifact.kind)) throw new Error('A relay artifact needs a kind')
    if (typeof artifact.value !== 'string' || !artifact.value.trim() || artifact.value.length > 4096) throw new Error('A relay artifact needs a value')
    return {
      kind: artifact.kind as 'file' | 'url' | 'identifier', value: artifact.value.trim(),
      ...(typeof artifact.label === 'string' && artifact.label.trim() ? { label: artifact.label.trim().slice(0, 200) } : {}),
    }
  })
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
    if (tool === 'sessions_open') {
      const limit = (input as Record<string, unknown> | undefined)?.limit
      if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) {
        return fail('invalid-input', 'Session limit is invalid')
      }
      try { return ok(await this.adapters.open(typeof limit === 'number' ? { limit } : {})) }
      catch { return fail('open-failed', 'Open sessions could not be listed') }
    }
    if (tool === 'session_close') {
      const raw = (input as Record<string, unknown> | undefined)?.taskId
      const taskId = typeof raw === 'string' ? raw.trim() : ''
      if (!taskId || taskId.length > 128) return fail('invalid-input', 'Task id is invalid')
      try { return ok(await this.adapters.close({ taskId })) }
      catch (error) { return fail('close-failed', (error as Error).message || 'That card could not be closed') }
    }
    if (tool === 'session_send') {
      if (ctx.interaction?.active !== true || ctx.interaction.id !== ctx.principal.interactionId) {
        return fail('access-denied', 'Speaking into a session requires an active interaction')
      }
      const value = (input ?? {}) as Record<string, unknown>
      const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : ''
      const intent = typeof value.intent === 'string' ? value.intent.trim() : ''
      const context = typeof value.context === 'string' ? value.context.trim() : ''
      if (!taskId || taskId.length > 128) return fail('invalid-input', 'Task id is invalid')
      if (!intent || intent.length > MAX_INTENT_LENGTH) return fail('invalid-input', 'A relay needs a request to carry')
      if (context.length > MAX_RELAY_CONTEXT_LENGTH) return fail('invalid-input', 'Carried context is too long')
      let sourceSessions: Array<{ sessionId: string; provider: 'claude' | 'codex' }> | undefined
      let artifacts: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }> | undefined
      try {
        sourceSessions = relaySources(value.sourceSessions)
        artifacts = relayArtifacts(value.artifacts)
      } catch (error) { return fail('invalid-input', (error as Error).message) }
      // CONTEXT THE SESSION CANNOT TRACE IS WORSE THAN NONE. The same rule
      // task_create enforces: background is only worth carrying when the
      // sessions it came from are named exactly.
      if (context && !sourceSessions?.length) return fail('invalid-input', 'Carried context requires exact sourceSessions')
      for (const [key, entry] of this.operations) if (entry.expiresAt <= ctx.now) this.operations.delete(key)
      const key = JSON.stringify([ctx.principal.runId, ctx.principal.interactionId, tool, taskId, intent, context])
      const previous = this.operations.get(key)
      if (previous) return previous.result
      const pending = this.adapters.send({
        taskId, intent,
        ...(context ? { context } : {}),
        ...(sourceSessions ? { sourceSessions } : {}),
        ...(artifacts ? { artifacts } : {}),
      }).then(result => {
        emitOnboardingReceipt({ type: 'agent-task-linked', taskId: result.taskId, href: `unmute://task/${result.taskId}` })
        return ok(result)
      }, (error: unknown) => fail('send-failed',
        `${(error as Error).message || 'That session could not be spoken into'}. Do not retry this relay in this interaction.`))
      this.operations.set(key, { expiresAt: ctx.principal.expiresAt, result: pending })
      return pending
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
      emitOnboardingReceipt({ type: 'agent-task-linked', taskId: result.taskId, href: `unmute://task/${result.taskId}` })
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
