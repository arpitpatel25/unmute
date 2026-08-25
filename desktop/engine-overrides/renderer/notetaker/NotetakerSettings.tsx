// Notetaker settings.
//
// Trigger section: reference display of the current hotkey (left Control,
// double-tap to start, single tap to stop — see keyboard.ts's
// feedNotesGesture; this copy previously described an older Control+Option
// chord design that shipped, then changed, without this text catching up).
//
// Pipeline section: transcript cleanup + auto-summarization (2026-08-25
// spec) — one toggle, a provider picker gated on real availability (same
// ✓/○ visual language as RemoteSetup.tsx's Agents checklist), and two
// independently editable prompts with reset-to-default.

import { useEffect, useState } from 'react'

type Provider = 'claude' | 'codex'

type PipelineSettings = {
  auto_pipeline_enabled: 0 | 1
  provider: Provider
  cleanup_prompt: string | null
  summary_prompt: string | null
  availability: { claude: boolean; codex: boolean }
  default_cleanup_prompt: string
  default_summary_prompt: string
}

type SettingsPatch = Partial<Pick<PipelineSettings, 'auto_pipeline_enabled' | 'provider' | 'cleanup_prompt' | 'summary_prompt'>>

type API = {
  notetakerGetPipelineSettings?: () => Promise<PipelineSettings>
  notetakerSavePipelineSettings?: (patch: SettingsPatch) => Promise<void>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude Code CLI', codex: 'Codex CLI' }

/** Small pill toggle — no existing Switch component in this codebase to
 *  reuse (checked; Settings.tsx's own toggles are click-to-cycle buttons,
 *  not a shared primitive), so this is self-contained rather than reaching
 *  for a raw unstyled checkbox in an otherwise visually considered app. */
function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        disabled ? 'bg-black/10 cursor-not-allowed' : on ? 'bg-green-700' : 'bg-black/20'
      }`}
    >
      <span
        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}

export function NotetakerSettings() {
  const [settings, setSettings] = useState<PipelineSettings | null>(null)
  const [cleanupDraft, setCleanupDraft] = useState('')
  const [summaryDraft, setSummaryDraft] = useState('')

  useEffect(() => {
    api().notetakerGetPipelineSettings?.().then((s) => {
      setSettings(s)
      // Seeded with the REAL default text when there's no override yet —
      // not an empty box with a placeholder — so the user sees exactly
      // what will run and can edit from there.
      setCleanupDraft(s.cleanup_prompt ?? s.default_cleanup_prompt)
      setSummaryDraft(s.summary_prompt ?? s.default_summary_prompt)
    })
  }, [])

  const save = (patch: SettingsPatch) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    api().notetakerSavePipelineSettings?.(patch)
  }

  const noProviderAvailable = !!settings && !settings.availability.claude && !settings.availability.codex

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-[13px] font-semibold text-ink mb-1">Trigger</h3>
        <p className="text-[12px] text-ink-60 leading-relaxed">
          Double-tap left Control to start recording a meeting; a single tap stops it (with a
          few seconds to tap again and keep recording if that was a mistake). Manual capture
          always works, whether or not a call is detected.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-1">Transcript cleanup &amp; notes</h3>
            <p className="text-[12px] text-ink-60 leading-relaxed max-w-md">
              Automatically corrects speech-to-text errors and generates a title, summary, key
              points, decisions, and action items for every meeting — using your own local
              Claude Code or Codex CLI, on your own usage, not Unmute&apos;s.
            </p>
          </div>
          {settings && (
            <Toggle
              on={!!settings.auto_pipeline_enabled}
              disabled={noProviderAvailable && !settings.auto_pipeline_enabled}
              onClick={() => save({ auto_pipeline_enabled: settings.auto_pipeline_enabled ? 0 : 1 })}
            />
          )}
        </div>

        {noProviderAvailable && (
          <p className="text-[11px] text-ink/50 mt-2">
            Neither Claude Code CLI nor Codex CLI is set up yet — install and sign in to one on
            the Orchestrator&apos;s Agents checklist to turn this on.
          </p>
        )}

        {settings && !!settings.auto_pipeline_enabled && (
          <div className="mt-3 flex flex-col gap-4">
            <div>
              <div className="text-[12px] font-medium text-ink mb-1.5">Provider</div>
              {(['claude', 'codex'] as const).map((id) => {
                const available = settings.availability[id]
                const selected = settings.provider === id
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={!available}
                    onClick={() => save({ provider: id })}
                    className="w-full flex items-center gap-2 py-1.5 text-left disabled:cursor-not-allowed"
                  >
                    <span className={available ? 'text-green-700' : 'text-ink/30'}>{available ? '✓' : '○'}</span>
                    <span className={`text-[12.5px] ${available ? 'text-ink' : 'text-ink/40'}`}>
                      {PROVIDER_LABEL[id]}
                    </span>
                    {selected && available && <span className="text-[11px] text-ink/50 ml-auto">Selected</span>}
                  </button>
                )
              })}
            </div>

            <PromptEditor
              label="Cleanup prompt"
              value={cleanupDraft}
              onChange={setCleanupDraft}
              onBlurSave={(text) => save({ cleanup_prompt: text.length > 0 ? text : null })}
              onReset={() => { setCleanupDraft(settings.default_cleanup_prompt); save({ cleanup_prompt: null }) }}
              isDefault={settings.cleanup_prompt === null}
            />
            <PromptEditor
              label="Summary prompt"
              value={summaryDraft}
              onChange={setSummaryDraft}
              onBlurSave={(text) => save({ summary_prompt: text.length > 0 ? text : null })}
              onReset={() => { setSummaryDraft(settings.default_summary_prompt); save({ summary_prompt: null }) }}
              isDefault={settings.summary_prompt === null}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** A prompt override is `null` (use the built-in default) until the user
 *  actually edits it — resetting clears the STORED value back to `null`
 *  rather than saving a copy of the default text, so a later change to the
 *  built-in default is inherited automatically instead of getting stuck at
 *  whatever text was in the box at reset time. The textarea's visible
 *  VALUE is always real text either way (the caller seeds `value` with the
 *  actual default, fetched from main, whenever there's no override) — this
 *  component only tracks whether that text is currently the inherited
 *  default or a saved override, to decide whether "Reset to default" makes
 *  sense to show. */
function PromptEditor({ label, value, onChange, onBlurSave, onReset, isDefault }: {
  label: string
  value: string
  onChange: (v: string) => void
  onBlurSave: (v: string) => void
  onReset: () => void
  isDefault: boolean
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-medium text-ink">{label}</span>
        {!isDefault && (
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-ink/50 hover:text-ink px-1.5 py-0.5 rounded hover:bg-black/5"
          >
            Reset to default
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlurSave(e.target.value)}
        rows={4}
        className="w-full text-[12px] leading-relaxed p-2 rounded border border-black/10 bg-white/50 resize-y"
      />
    </div>
  )
}
