// Unmute Remote — guided one-time setup (PRD §12, onboarding).
//
// DECIDED: absorb the one-time complexity here so per-task use is pure voice.
// Unmute is never in the credential path — this panel only makes the setup
// LEGIBLE: it auto-detects what it can (connected MCP servers, the dedicated
// Chrome profile) and hands the user the exact command/step for the rest. Each
// MCP step shows a copy-paste `claude mcp add …` the user runs in THEIR Claude
// Code; manual browser steps are self-confirmed checkboxes.
//
// Collapses to a one-line "Setup complete ✓" once every step is done, so it
// gets out of the way after first run but stays available.

import { useEffect, useState } from 'react'

interface SetupStep {
  key: string
  title: string
  detail: string
  command?: string
  status: 'done' | 'todo'
  auto: boolean
  optional?: boolean
}
interface SetupStatus {
  steps: SetupStep[]
  complete: boolean
}
type API = {
  remoteGetSetupStatus?: () => Promise<SetupStatus>
  remoteSetSetupConfirmation?: (key: string, done: boolean) => Promise<SetupStatus>
  remoteInstallTmux?: () => Promise<SetupStatus>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5 shrink-0"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

export function Onboarding() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = () => api().remoteGetSetupStatus?.().then((v) => v && setStatus(v))
  useEffect(() => { void refresh() }, [])
  if (!status) return null

  const todo = status.steps.filter((s) => s.status === 'todo').length

  // Collapsed header line — always visible, summarizes + toggles.
  const header = (
    <button
      className="w-full flex items-center justify-between text-left"
      onClick={() => { setOpen((o) => !o); void refresh() }}
    >
      <span className="font-semibold text-ink">
        {status.complete ? 'Setup complete ✓' : `Setup — ${todo} step${todo === 1 ? '' : 's'} left`}
      </span>
      <span className="text-[11px] text-ink/40">{open ? 'hide' : 'show'}</span>
    </button>
  )

  return (
    <div className="rounded-lg border border-black/10 p-3 mb-3 bg-cream-mid/40 text-[12px]">
      {header}

      {open && (
        <div className="mt-2">
          <div className="text-[11px] text-ink/50 mb-2">
            One-time setup. Unmute never sees your credentials — you run the commands in your own Claude Code and authorize each integration yourself.
          </div>
          {status.steps.map((step) => (
            <div key={step.key} className="py-1.5 border-t border-black/5">
              <div className="flex items-start gap-2">
                <span className={step.status === 'done' ? 'text-green-700' : 'text-ink/30'}>
                  {step.status === 'done' ? '✓' : '○'}
                </span>
                <div className="flex-1">
                  <div className={`font-medium ${step.status === 'done' ? 'text-ink/50 line-through' : 'text-ink'}`}>
                    {step.title}
                    {!step.auto && <span className="ml-1 text-[10px] uppercase tracking-wider text-ink/30">manual</span>}
                  </div>
                  <div className="text-[11px] text-ink/50 mt-0.5">{step.detail}</div>
                  {step.command && (
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 px-1.5 py-0.5 bg-black/5 rounded text-[11px] truncate">{step.command}</code>
                      {/* tmux is a known dep — Unmute installs it for you, no terminal needed. */}
                      {step.key === 'tmux' && step.status !== 'done' && (
                        <button
                          className="text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5 shrink-0"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true)
                            const next = await api().remoteInstallTmux?.()
                            if (next) setStatus(next)
                            setBusy(false)
                          }}
                        >
                          {busy ? 'installing…' : 'install'}
                        </button>
                      )}
                      <CopyButton text={step.command} />
                    </div>
                  )}
                  {!step.auto && (
                    <label className="flex items-center gap-1.5 mt-1 text-[11px] text-ink/60">
                      <input
                        type="checkbox"
                        checked={step.status === 'done'}
                        disabled={busy}
                        onChange={async (e) => {
                          setBusy(true)
                          const next = await api().remoteSetSetupConfirmation?.(step.key, e.target.checked)
                          if (next) setStatus(next)
                          setBusy(false)
                        }}
                      />
                      I&rsquo;ve done this
                    </label>
                  )}
                </div>
              </div>
            </div>
          ))}
          <button
            className="mt-2 text-[11px] px-2 py-1 rounded border border-black/15 hover:bg-black/5"
            onClick={() => void refresh()}
          >
            Re-check
          </button>
        </div>
      )}
    </div>
  )
}
