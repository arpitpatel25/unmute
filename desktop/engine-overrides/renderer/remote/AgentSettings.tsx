import { useCallback, useEffect, useState } from 'react'

import { SectionHeader } from '../app/_shared'
import { ProviderGlyph } from './ProviderMark'

type AgentProvider = 'claude' | 'codex'

interface AgentSettingsSnapshot {
  agentProvider: AgentProvider
  unmuteAgentAvailable: boolean
  unmuteAgentMaxProcesses: number
}

interface AgentAvailabilitySnapshot {
  available: boolean
  reason?: 'disabled' | 'initializing' | 'keychain-unavailable' | 'storage-unavailable' | 'provider-unavailable'
  providers: Array<{
    id: AgentProvider
    label: string
    available: boolean
    reason?: 'not-installed'
  }>
}

type AgentSettingsAPI = {
  remoteGetAgentSettings?: () => Promise<AgentSettingsSnapshot>
  remoteSetUnmuteAgentProvider?: (provider: AgentProvider) => Promise<boolean>
  remoteGetAgentAvailability?: () => Promise<AgentAvailabilitySnapshot>
}

function api(): AgentSettingsAPI {
  return (window as unknown as { electronAPI?: AgentSettingsAPI }).electronAPI ?? {}
}

function AgentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v2M3.5 6.5A2.5 2.5 0 0 1 6 4h4a2.5 2.5 0 0 1 2.5 2.5v4A2.5 2.5 0 0 1 10 13H6a2.5 2.5 0 0 1-2.5-2.5z" />
      <path d="M6 8h.01M10 8h.01M6.5 10.5h3" />
    </svg>
  )
}

const AVAILABILITY_COPY: Record<NonNullable<AgentAvailabilitySnapshot['reason']>, string> = {
  disabled: 'Unmute Agent is not enabled in this build yet. Your existing task routing is unchanged.',
  initializing: 'Unmute Agent is preparing its encrypted memory and checking local providers.',
  'keychain-unavailable': 'Encrypted memory is unavailable because macOS Keychain protection could not be opened.',
  'storage-unavailable': 'Encrypted memory could not be opened. Existing memory was left untouched.',
  'provider-unavailable': 'The selected CLI is not available. Choose an installed provider below.',
}

export function AgentSettings() {
  const [settings, setSettings] = useState<AgentSettingsSnapshot | null>(null)
  const [availability, setAvailability] = useState<AgentAvailabilitySnapshot | null>(null)

  const load = useCallback(() => {
    void api().remoteGetAgentSettings?.().then((value) => value && setSettings(value)).catch(() => {})
    void api().remoteGetAgentAvailability?.().then((value) => value && setAvailability(value)).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const refresh = window.setInterval(load, 5_000)
    return () => window.clearInterval(refresh)
  }, [load])

  if (!settings) return null

  const providers = availability?.providers.length
    ? availability.providers
    : [
        { id: 'claude' as const, label: 'Claude Code CLI', available: false, reason: 'not-installed' as const },
        { id: 'codex' as const, label: 'Codex CLI', available: false, reason: 'not-installed' as const },
      ]

  const select = async (provider: AgentProvider) => {
    const accepted = await api().remoteSetUnmuteAgentProvider?.(provider)
    if (accepted !== false) setSettings((current) => current ? { ...current, agentProvider: provider } : current)
    load()
  }

  return (
    <div>
      <SectionHeader icon={<AgentIcon />} title="Unmute Agent" />
      <div className="bg-white border border-border rounded-[12px] overflow-hidden">
        <div className="px-5 py-4">
          <p className="text-[13px] font-medium text-ink">Provider for the Unmute Agent</p>
          {/* SAY EVERYTHING THIS PICKER GOVERNS. It used to read "Provider for
              Agent conversations" and then narrow the promise further — which
              stopped being true when the background session summariser started
              following it too. A control that under-describes itself is worse
              than one that is merely vague: the summariser ran on Codex because
              this said Codex, and nothing on screen connected the two. */}
          <p className="text-[11px] text-ink-35 mt-0.5 mb-3 leading-relaxed">
            Runs your Agent conversations, and the background job that keeps your session
            summaries up to date. It does not change which agent runs Orchestrator tasks —
            you pick that per task.
          </p>

          <div className="space-y-1.5">
            {providers.map((provider) => {
              const selected = provider.id === settings.agentProvider
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => { void select(provider.id) }}
                  className={`w-full text-left px-3.5 py-3 rounded-[10px] border transition-colors ${
                    selected ? 'border-ink bg-cream-mid' : 'border-border bg-white hover:bg-cream-mid'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <ProviderGlyph backend={provider.id} terminal title={provider.label} style={{ opacity: provider.available ? 1 : 0.4 }} />
                    <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${provider.available ? 'bg-success' : 'bg-ink-35'}`} />
                    <span className="text-[13px] font-medium text-ink">{provider.label}</span>
                    {!provider.available && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-ink-35">not installed</span>
                    )}
                  </span>
                  <span className="block text-[11px] text-ink-35 mt-1 leading-relaxed">
                    {provider.id === 'claude'
                      ? 'Uses the Claude Code command and your existing Claude login.'
                      : 'Uses the Codex command and your existing Codex login.'}
                  </span>
                </button>
              )
            })}
          </div>

          {availability?.reason && (
            <p className="text-[11px] text-ink-35 mt-3 leading-relaxed">
              {AVAILABILITY_COPY[availability.reason]}
            </p>
          )}
          {availability?.available && (
            <p className="text-[11px] text-success mt-3">Ready for new Agent conversations.</p>
          )}
        </div>
      </div>
    </div>
  )
}
