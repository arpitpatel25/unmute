import type { CapabilityCallContext, ToolDefinition } from './types'

function hasActiveExplicitInteraction(ctx: CapabilityCallContext): boolean {
  return ctx.principal.kind === 'unmute-agent'
    && ctx.principal.expiresAt > ctx.now
    && ctx.interaction?.active === true
    && ctx.interaction.id === ctx.principal.interactionId
}

/** Throws when a capability call exceeds its declared consequence policy. */
export function authorizeCapabilityCall(ctx: CapabilityCallContext, tool: ToolDefinition): void {
  if (tool.consequence === 'read') return

  if (!hasActiveExplicitInteraction(ctx)) {
    throw new Error(`Tool ${tool.name} requires an active explicit interaction`)
  }

  if (tool.consequence === 'reversible-write') return

  if (!tool.intent || !ctx.interaction?.intents?.includes(tool.intent)) {
    throw new Error(`Tool ${tool.name} requires an explicit matching intent flag`)
  }
}
