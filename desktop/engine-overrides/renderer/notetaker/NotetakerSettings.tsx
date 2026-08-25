// Notetaker settings.
//
// Trigger section: reference display of the current hotkey (left Control,
// double-tap to start, single tap to stop — see keyboard.ts's
// feedNotesGesture; this copy previously described an older Control+Option
// chord design that shipped, then changed, without this text catching up).
//
// Pipeline section: transcript cleanup + auto-summarization (2026-08-25
// spec) — one toggle, a provider picker gated on real availability (same
// ✓/○ visual language as RemoteSetup.tsx's Agents checklist), and an
// editable "instructions" for summary only (2026-08-26: renamed from
// "prompt" in every user-facing string — the model-facing term isn't what
// a user is editing here, they're editing behavior guidance). Cleanup has
// no user-facing instructions at all — its correction rules (including
// language recovery and the hallucination-handling rule) are fixed for
// every meeting, see transcriptCleanup.ts's own header for why.
//
// Summary instructions are shown collapsed (label + one-line status), not
// inline — the full editable text only appears in InstructionsEditorModal,
// opened via the pencil icon, with its own Save/Cancel. What's edited
// there is only ever the MIDDLE, user-customizable third of the real
// prompt sent to the model — a fixed preamble and contract (output shape,
// language/garbled-content/decision rules) always bookend it and are never
// shown or editable, see notesSummary.ts.

import { useEffect, useState } from 'react'

type Provider = 'claude' | 'codex'

type PipelineSettings = {
  auto_pipeline_enabled: 0 | 1
  provider: Provider
  summary_prompt: string | null
  availability: { claude: boolean; codex: boolean }
  default_summary_instructions: string
}

type SettingsPatch = Partial<Pick<PipelineSettings, 'auto_pipeline_enabled' | 'provider' | 'summary_prompt'>>

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
  const [editingSummary, setEditingSummary] = useState(false)

  useEffect(() => {
    api().notetakerGetPipelineSettings?.().then(setSettings)
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

            <p className="text-[11px] text-ink/50 leading-relaxed">
              Transcript cleanup — including recovering misheard or code-switched speech — runs the
              same way for every meeting and isn&apos;t user-editable.
            </p>

            <InstructionsRow
              label="Summary instructions"
              isDefault={settings.summary_prompt === null}
              onEdit={() => setEditingSummary(true)}
            />
          </div>
        )}
      </div>

      {settings && editingSummary && (
        <InstructionsEditorModal
          title="Summary instructions"
          initialValue={settings.summary_prompt ?? settings.default_summary_instructions}
          defaultValue={settings.default_summary_instructions}
          onSave={(text) => {
            save({ summary_prompt: text.length > 0 ? text : null })
            setEditingSummary(false)
          }}
          onReset={() => {
            save({ summary_prompt: null })
            setEditingSummary(false)
          }}
          onCancel={() => setEditingSummary(false)}
        />
      )}
    </div>
  )
}

/** Collapsed reference to one set of instructions — a label, a one-line
 *  status (default vs. customized), and a pencil button that opens the
 *  modal. The full text never appears inline; Settings shouldn't read like
 *  a text editor. */
function InstructionsRow({ label, isDefault, onEdit }: { label: string; isDefault: boolean; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div>
        <div className="text-[12px] font-medium text-ink">{label}</div>
        <div className="text-[11px] text-ink/50">
          {isDefault ? 'Using the default instructions.' : 'Using your customized instructions.'}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${label.toLowerCase()}`}
        title={`Edit ${label.toLowerCase()}`}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-ink/50 hover:text-ink hover:bg-black/5 transition-colors"
      >
        <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4">
          <path
            d="M14.5 3.5a1.5 1.5 0 0 1 2 2.1L7 15.1l-3 .9.9-3L14.5 3.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}

/** Full-text editor, opened from InstructionsRow's pencil. `initialValue`
 *  is always real text (the stored override, or the fetched built-in
 *  default) — never an empty box with a placeholder. Reset clears the
 *  STORED value back to `null` rather than saving a copy of the default
 *  text, so a later change to the built-in default is inherited
 *  automatically instead of getting stuck at whatever text was here at
 *  reset time. Save/Cancel are explicit — nothing here saves on blur. */
function InstructionsEditorModal({ title, initialValue, defaultValue, onSave, onReset, onCancel }: {
  title: string
  initialValue: string
  defaultValue: string
  onSave: (v: string) => void
  onReset: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initialValue)
  const isDefaultText = draft === defaultValue

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2">
          <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
          <p className="text-[11.5px] text-ink-60 mt-1 leading-relaxed">
            This is the guidance that customizes how {title.toLowerCase()} behave. It always runs
            alongside Unmute&apos;s own required rules for input/output format and known
            transcription artifacts, which aren&apos;t shown here and can&apos;t be changed.
          </p>
        </div>
        <div className="px-4 flex-1 overflow-y-auto min-h-[160px]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            className="w-full h-full min-h-[160px] text-[12px] leading-relaxed p-2 rounded border border-black/10 bg-white/50 resize-none"
          />
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-black/10">
          {!isDefaultText ? (
            <button
              type="button"
              onClick={onReset}
              className="text-[11.5px] text-ink/50 hover:text-ink px-2 py-1 rounded hover:bg-black/5"
            >
              Reset to default
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="text-[12px] px-3 py-1.5 rounded border border-black/15 hover:bg-black/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              className="text-[12px] px-3 py-1.5 rounded bg-accent text-white hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
