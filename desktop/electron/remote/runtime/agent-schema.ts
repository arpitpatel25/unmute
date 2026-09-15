import { join } from 'node:path'

/** Bumped when a running Agent worker must not reuse the previous code bundle. */
export const AGENT_RUNTIME_SCHEMA = 'agent-metadata-v2'

export function agentRuntimeRoot(userData: string): string {
  return join(userData, `persistent-runtime-${AGENT_RUNTIME_SCHEMA}`)
}
