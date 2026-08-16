export type McpPrincipal =
  | { kind: 'task'; taskId: string }
  | { kind: 'unmute-agent'; runId: string; interactionId: string; expiresAt: number }

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
