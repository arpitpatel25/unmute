export const UNMUTE_AGENT_ORIGIN = 'unmute-agent' as const

export type UnmuteAgentOrigin = typeof UNMUTE_AGENT_ORIGIN

export interface AgentOriginSource {
  origin?: string | null
  agentRunId?: string | null
}

export interface AgentOriginPresentation {
  origin: UnmuteAgentOrigin
  label: 'Unmute'
  agentRunId?: string
}

/** One renderer-side authority for Agent provenance and its user-facing label. */
export function agentOriginPresentation(source: AgentOriginSource): AgentOriginPresentation | null {
  if (source.origin !== UNMUTE_AGENT_ORIGIN) return null
  return {
    origin: UNMUTE_AGENT_ORIGIN,
    label: 'Unmute',
    ...(source.agentRunId ? { agentRunId: source.agentRunId } : {}),
  }
}
