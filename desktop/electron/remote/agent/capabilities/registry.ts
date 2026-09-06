import { authorizeCapabilityCall } from '../policy'
import type { CapabilityCallContext, CapabilityModule, McpPrincipal, ToolDefinition, ToolResult } from '../types'
import { randomUUID } from 'node:crypto'
import { diagnostic, diagnosticError, type DiagnosticSink } from '../../diagnostics'

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
      const result = await module.call(ctx, toolName, input)
      this.audit('agent-tool-completed', { ...fields, durationMs: Date.now() - start,
        outcome: result.isError ? 'error' : 'success', resultBlocks: result.content.length })
      return result
    } catch (error) {
      this.audit('agent-tool-completed', { ...fields, durationMs: Date.now() - start,
        outcome: invoked ? 'error' : 'rejected', ...diagnosticError(error) })
      throw error
    }
  }
}
