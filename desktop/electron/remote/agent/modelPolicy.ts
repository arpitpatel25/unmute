import type { AgentProviderId } from './provider'

const MODEL_BY_PROVIDER: Readonly<Record<AgentProviderId, string>> = {
  codex: 'gpt-5.6-sol',
  claude: 'opus',
}

export function agentModel(provider: AgentProviderId): string {
  return MODEL_BY_PROVIDER[provider]
}

export function agentModelLabel(provider: AgentProviderId): string {
  return provider === 'claude' ? 'Opus 5' : 'GPT-5.6 Sol'
}
