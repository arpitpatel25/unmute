import type { AgentProviderId } from './provider'

export type McpPrincipal =
  | { kind: 'task'; taskId: string }
  | {
    kind: 'unmute-agent'
    runId: string
    interactionId: string
    expiresAt: number
    /** Provider actually running this Agent turn. Present on authenticated MCP calls. */
    provider?: AgentProviderId
  }

export type ConsequenceClass =
  | 'read'
  | 'reversible-write'
  | 'sensitive-read'
  | 'destructive'
  | 'external-consequence'

/** The subset of the MCP tool JSON representation capability modules expose. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  consequence: ConsequenceClass
  /** Required user intent flag for sensitive or consequential tools. */
  intent?: string
}

/** The MCP tool-call JSON representation returned by capability modules. */
export interface ToolResult {
  content: Array<{ type: string; [key: string]: unknown }>
  isError?: boolean
  [key: string]: unknown
}

export interface ExplicitInteraction {
  id: string
  active: boolean
  intents?: readonly string[]
  /**
   * What the user actually said this interaction, verbatim. Capabilities that
   * record the user's own words take them from HERE, never from a model
   * argument: a model asked to retype a transcript can paraphrase, tidy or
   * truncate it, and one that cannot reach the field cannot get it wrong.
   */
  transcript?: string
}

export interface CapabilityCallContext {
  principal: McpPrincipal
  now: number
  interaction?: ExplicitInteraction
}

export interface CapabilityModule {
  id: string
  roles: readonly McpPrincipal['kind'][]
  tools: readonly ToolDefinition[]
  call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult>
}
