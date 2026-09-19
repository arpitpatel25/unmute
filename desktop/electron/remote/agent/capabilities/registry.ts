import { authorizeCapabilityCall } from '../policy'
import type { CapabilityCallContext, CapabilityModule, McpPrincipal, ToolDefinition, ToolResult } from '../types'
import { randomUUID } from 'node:crypto'
import { diagnostic, diagnosticError, type DiagnosticSink } from '../../diagnostics'
import { devLogEnabled } from '../../curator-devlog'
import { describeToolInput, devToolCall, devTrace } from '../devlog'

/** DEV-ONLY: the facts in a result that say what a decision was based on —
 *  never the payload itself. index_search is the one read whose OUTPUT is the
 *  evidence, so its counts and top sessions are kept. */
function resultFacts(tool: string, result: ToolResult): Record<string, unknown> {
  const text = result.content.find(block => block.type === 'text')?.text
  const facts: Record<string, unknown> = { resultChars: typeof text === 'string' ? text.length : 0 }
  if (typeof text !== 'string') return facts
  try {
    const parsed = JSON.parse(text)
    if (parsed?.ok === false) return { ...facts, errorCode: parsed.error?.code ?? null, errorMessage: parsed.error?.message ?? null }
    const value = parsed?.result
    if (tool === 'index_search' && value) {
      return {
        ...facts,
        matchedSessions: value.matchedSessions, matchedTurns: value.matchedTurns,
        returned: value.sessions?.length ?? 0, remaining: value.remaining, nextCursor: value.nextCursor ?? null,
        top: (value.sessions ?? []).slice(0, 5).map((s: any) => `${s.sessionId}:${s.match}`),
      }
    }
    if (Array.isArray(value)) return { ...facts, items: value.length }
    if (value?.taskId) return { ...facts, taskId: value.taskId }
    if (Array.isArray(value?.results)) return { ...facts, items: value.results.length }
  } catch { /* not JSON; the length is enough */ }
  return facts
}

export class CapabilityRegistry {
  private readonly owners = new Map<string, CapabilityModule>()

  constructor(private readonly modules: readonly CapabilityModule[], private readonly audit: DiagnosticSink = diagnostic) {
    for (const module of modules) {
      for (const tool of module.tools) {
        if (this.owners.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
        this.owners.set(tool.name, module)
      }
    }
  }

  tools(principal: McpPrincipal): readonly ToolDefinition[] {
    return this.modules.flatMap((module) => (
      module.roles.includes(principal.kind) ? module.tools : []
    ))
  }

  async call(
    principal: McpPrincipal,
    toolName: string,
    input: unknown,
    context: Omit<CapabilityCallContext, 'principal' | 'now'> & { now?: number } = {},
  ): Promise<ToolResult> {
    const start = Date.now()
    const fields = { callId: randomUUID(), tool: toolName, principal: principal.kind,
      ...(principal.kind === 'unmute-agent' ? { runId: principal.runId, interactionId: principal.interactionId } : { taskId: principal.taskId }) }
    this.audit('agent-tool-started', fields)
    let invoked = false
    try {
      const module = this.owners.get(toolName)
      if (!module || !module.roles.includes(principal.kind)) {
        throw new Error(`Tool ${toolName} is not available to ${principal.kind === 'task' ? 'task' : 'unmute-agent'} principals`)
      }
      const tool = module.tools.find((candidate) => candidate.name === toolName)
      if (!tool) throw new Error(`Tool ${toolName} has no owning definition`)

      const ctx: CapabilityCallContext = { principal, now: context.now ?? Date.now(), interaction: context.interaction }
      authorizeCapabilityCall(ctx, tool)
      invoked = true
      const devInput = devLogEnabled() ? describeToolInput(toolName, input) : undefined
      if (devInput) devTrace('tool.call', { ...fields, input: devInput })
      const result = await module.call(ctx, toolName, input)
      const outcome = result.isError ? 'error' : 'success'
      this.audit('agent-tool-completed', { ...fields, durationMs: Date.now() - start,
        outcome, resultBlocks: result.content.length })
      if (devInput) {
        const facts = { ...devInput, ...resultFacts(toolName, result) }
        devTrace('tool.result', { ...fields, outcome, durationMs: Date.now() - start, facts })
        devToolCall(principal.kind === 'unmute-agent' ? principal.interactionId : undefined, { at: start, tool: toolName, outcome, durationMs: Date.now() - start, facts })
      }
      return result
    } catch (error) {
      this.audit('agent-tool-completed', { ...fields, durationMs: Date.now() - start,
        outcome: invoked ? 'error' : 'rejected', ...diagnosticError(error) })
      devToolCall(principal.kind === 'unmute-agent' ? principal.interactionId : undefined, { at: start, tool: toolName, outcome: invoked ? 'threw' : 'rejected', durationMs: Date.now() - start })
      throw error
    }
  }
}
