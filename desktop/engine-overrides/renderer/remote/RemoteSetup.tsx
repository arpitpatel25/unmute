// Unmute Remote — "Set up Remote" page.
//
// Full-page setup reached from the Remote tab. DECIDED posture: Remote needs
// exactly ONE thing — the Claude for Chrome extension. Everything else is
// optional and granted as-needed, so the required part stays a 30-second job and
// the optional integrations are clearly framed as "add as you go".
//
// Drives off the live setup-status IPC (same as the old Onboarding widget):
// chrome-extension is the one required step; tmux + MCPs are optional. Unmute is
// never in the credential path — the user authorizes each integration in their
// own Claude Code.

import { useEffect, useState } from 'react'
import installExtImg from '../assets/setup-install-extension.png'
import extActiveImg from '../assets/setup-extension-active.png'

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

export function RemoteSetup({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => api().remoteGetSetupStatus?.().then((v) => v && setStatus(v))
  useEffect(() => { void refresh() }, [])

  const ext = status?.steps.find((s) => s.key === 'chrome-extension')
  const optional = (status?.steps ?? []).filter((s) => s.key !== 'chrome-extension')

  const setConfirm = async (key: string, done: boolean) => {
    setBusy(true)
    const next = await api().remoteSetSetupConfirmation?.(key, done)
    if (next) setStatus(next)
    setBusy(false)
  }

  return (
    <div className="p-4 max-w-[640px]">
      <button
        className="text-[11px] text-ink/50 hover:text-ink mb-3 flex items-center gap-1"
        onClick={onBack}
      >
        ← Back to tasks
      </button>

      <div className="text-lg font-semibold text-ink mb-1">Set up Remote</div>
      <div className="text-[12px] text-ink/50 mb-5">
        Remote needs just one thing to work: the Claude for Chrome extension.
        Everything else is optional — add it whenever you like.
      </div>

      {/* ─── Required: the Chrome extension ─── */}
      <div className="rounded-lg border border-black/10 p-4 mb-4 bg-cream-mid/40">
        <div className="flex items-center gap-2 mb-2">
          <span className={ext?.status === 'done' ? 'text-green-700' : 'text-ink/30'}>
            {ext?.status === 'done' ? '✓' : '①'}
          </span>
          <span className="text-[13px] font-semibold text-ink">
            Install the Claude for Chrome extension
          </span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-accent font-semibold">
            required
          </span>
        </div>

        <div className="text-[12px] leading-relaxed text-ink/70 mb-2">
          Add the Claude for Chrome extension to your normal Chrome from the Chrome
          Web Store and enable it. Browser tasks drive your real, already-signed-in
          Chrome — no separate profile or login needed. If you already have it, just
          check it off below.
        </div>
        <img
          src={installExtImg}
          alt="Claude for Chrome extension on the Chrome Web Store"
          className="w-full rounded-md border border-black/10 mb-3"
        />

        <div className="text-[12px] leading-relaxed text-ink/70 mb-2">
          Then keep <b>one Chrome window open</b> with the extension active while you
          use Remote — that&rsquo;s the window your browser tasks run in.
        </div>
        <img
          src={extActiveImg}
          alt="A Chrome window with the Claude side panel active"
          className="w-full rounded-md border border-black/10 mb-3"
        />

        <label className="flex items-center gap-2 text-[12px] text-ink/70">
          <input
            type="checkbox"
            checked={ext?.status === 'done'}
            disabled={busy || !ext}
            onChange={(e) => void setConfirm('chrome-extension', e.target.checked)}
          />
          I&rsquo;ve installed the extension and have a Chrome window open
        </label>
      </div>

      {/* ─── Optional: add as you go ─── */}
      <div className="rounded-lg border border-black/10 p-4 mb-3 bg-cream-mid/20">
        <div className="text-[13px] font-semibold text-ink mb-1">
          Add more as you go <span className="text-ink/40 font-normal">(optional)</span>
        </div>
        <div className="text-[12px] leading-relaxed text-ink/60 mb-3">
          Remote already works. These just unlock more — connect them whenever you
          want, and Remote will ask for what it needs, when it needs it. Sign into
          your accounts (Gmail and the rest) in that same Chrome window so browser
          tasks can act for you. Unmute never sees your credentials — you authorize
          each one in your own Claude Code.
        </div>

        {optional.map((step) => (
          <div key={step.key} className="py-1.5 border-t border-black/5 first:border-t-0">
            <div className="flex items-start gap-2">
              <span className={step.status === 'done' ? 'text-green-700' : 'text-ink/30'}>
                {step.status === 'done' ? '✓' : '○'}
              </span>
              <div className="flex-1">
                <div className={`text-[12px] font-medium ${step.status === 'done' ? 'text-ink/50 line-through' : 'text-ink'}`}>
                  {step.title}
                </div>
                <div className="text-[11px] text-ink/50 mt-0.5">{step.detail}</div>
                {step.command && (
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 px-1.5 py-0.5 bg-black/5 rounded text-[11px] truncate">{step.command}</code>
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
                      onChange={(e) => void setConfirm(step.key, e.target.checked)}
                    />
                    I&rsquo;ve done this
                  </label>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        className="text-[11px] px-2 py-1 rounded border border-black/15 hover:bg-black/5"
        onClick={() => void refresh()}
      >
        Re-check
      </button>
    </div>
  )
}
