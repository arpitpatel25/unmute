// Unmute Orchestrator — "Agents & setup" page.
//
// Full-page setup reached from the Orchestrator tab.
//
// WHAT IS ACTUALLY REQUIRED, said once. This page used to claim two different
// things at the same time: a header comment and a badge saying the Chrome
// extension was "exactly ONE thing" the product needs, and body copy saying you
// need an agent and that everything else is optional. Both cannot be true, and
// the second one is: without an agent there is no product at all, while the
// extension buys you exactly one lane — browser tasks. So the badge on the
// extension now says what it is required FOR, and the agents section is the only
// thing marked required.
//
// Drives off the live setup-status IPC. Unmute is never in the credential path —
// the user authorizes each integration in their own agent.

import { useEffect, useState } from 'react'
import { Toggle } from '../app/_shared'
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
  /** A fix Unmute can perform itself (see setup-status.ts). */
  action?: 'codex-connect'
}
interface SetupStatus {
  steps: SetupStep[]
  complete: boolean
}
type API = {
  remoteGetSetupStatus?: () => Promise<SetupStatus>
  remoteSetSetupConfirmation?: (key: string, done: boolean) => Promise<SetupStatus>
  remoteInstallTmux?: () => Promise<SetupStatus>
  remoteCodexConnect?: () => Promise<{ ok: boolean; reason?: string }>
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

/** Last known setup status, so the required section is never absent. */
const SETUP_CACHE_KEY = 'unmute.setupStatus.v1'

export function RemoteSetup({ onBack }: { onBack: () => void }) {
  // SEEDED FROM THE LAST ANSWER, NOT FROM NOTHING.
  //
  // remoteGetSetupStatus probes for real — it looks for the CLIs, and talks to
  // the Codex app over CDP — and that took ~30s on a cold start. The card below
  // is gated on `backends.length > 0`, so for that whole time the page rendered
  // its heading and then jumped straight to the Chrome extension: the ONE
  // section this page calls required was the one section missing.
  //
  // The previous result is almost always still true (agents do not uninstall
  // themselves), so it is shown immediately and corrected in place when the
  // probe returns. First run on a machine has nothing cached and falls through
  // to the checking state below.
  const [status, setStatus] = useState<SetupStatus | null>(() => {
    try {
      const cached = localStorage.getItem(SETUP_CACHE_KEY)
      return cached ? JSON.parse(cached) as SetupStatus : null
    } catch { return null }
  })
  const [busy, setBusy] = useState(false)

  const refresh = () => api().remoteGetSetupStatus?.().then((v) => {
    if (!v) return
    setStatus(v)
    try { localStorage.setItem(SETUP_CACHE_KEY, JSON.stringify(v)) } catch { /* private mode */ }
  })
  useEffect(() => { void refresh() }, [])

  // AGENTS FIRST. Everything below is an enhancement; without a backend there is
  // no product at all, so these get their own group at the top rather than
  // sitting in the same list as "connect Gmail".
  const backends = (status?.steps ?? []).filter((s) => s.key.startsWith('backend-'))
  const ext = status?.steps.find((s) => s.key === 'chrome-extension')
  const optional = (status?.steps ?? []).filter((s) => s.key !== 'chrome-extension' && !s.key.startsWith('backend-'))

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
        ← Back
      </button>

      <div className="text-[16px] font-semibold text-ink mb-1">Agents &amp; setup</div>
      <div className="text-[12.5px] text-ink/50 mb-5">
        The Orchestrator runs your work on an agent, so <b>you need at least one</b> —
        that is the only requirement on this page. The Claude for Chrome extension
        unlocks browser tasks; everything below it is optional and can be added
        whenever you like.
      </div>

      {/* ─── The agents that run the work ───
          First, because nothing else matters without one. Each row is
          auto-detected, and offers whatever fix is actually possible: a command
          when something must be installed, a button when Unmute can do it. */}
      {/* ALWAYS RENDERED. A section the page calls required must not vanish
          while it is being checked — its absence reads as "you have no agents",
          which is the opposite of what an unfinished probe means. */}
      {(backends.length > 0 || status === null) && (
        <div className="rounded-lg border border-black/10 p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[13px] font-semibold text-ink">Agents</span>
            <span className="ml-auto text-[10px] uppercase tracking-wider text-accent font-semibold">
              required
            </span>
          </div>
          <div className="text-[12.5px] text-ink/50 mb-3">
            Where your tasks actually run. You need at least one; nothing else on this
            page matters without it.
          </div>
          {backends.length === 0 && (
            <div className="py-2 text-[12.5px] text-ink/40">Checking your agents…</div>
          )}
          {backends.map((step) => (
            <div key={step.key} className="py-2 border-t border-black/5 first:border-t-0">
              <div className="flex items-start gap-2">
                <span className={step.status === 'done' ? 'text-green-700' : 'text-ink/30'}>
                  {step.status === 'done' ? '✓' : '○'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={`text-[12.5px] font-medium ${step.status === 'done' ? 'text-ink/50' : 'text-ink'}`}>
                    {step.title}
                  </div>
                  {step.status !== 'done' && (
                    <div className="text-[11px] text-ink/50 mt-0.5">{step.detail}</div>
                  )}
                  {step.command && step.status !== 'done' && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <code className="flex-1 px-1.5 py-0.5 bg-black/5 rounded text-[11px] truncate">{step.command}</code>
                      <CopyButton text={step.command} />
                    </div>
                  )}
                  {step.action === 'codex-connect' && step.status !== 'done' && (
                    <button
                      className="mt-2 text-[11px] px-2.5 py-1 rounded border border-black/15 hover:bg-black/5 disabled:opacity-50"
                      disabled={busy}
                      onClick={async () => {
                        // Arming QUITS AND RELAUNCHES the user's Codex app. The
                        // detail text above says so, and this says it again at
                        // the moment of the click — closing someone's app is not
                        // something to do on a single unconfirmed tap.
                        if (!window.confirm('Connect Codex?\n\nUnmute will quit the Codex app and reopen it in the background so it can drive it. Your threads are kept.')) return
                        setBusy(true)
                        try { await api().remoteCodexConnect?.() } catch { /* re-check tells the truth */ }
                        await refresh()
                        setBusy(false)
                      }}
                    >
                      {busy ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── The Chrome extension: needed for browser tasks, and only those ───
          NOT marked required. It buys exactly one lane; the agents section above
          is the only thing on this page without which there is no product. */}
      <div className="rounded-lg border border-black/10 p-4 mb-4 bg-cream-mid/40">
        <div className="flex items-center gap-2 mb-2">
          <span className={ext?.status === 'done' ? 'text-green-700' : 'text-ink/30'}>
            {ext?.status === 'done' ? '✓' : '①'}
          </span>
          <span className="text-[13px] font-semibold text-ink">
            Install the Claude for Chrome extension
          </span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-ink/40 font-semibold">
            for browser tasks
          </span>
        </div>

        <div className="text-[12.5px] leading-relaxed text-ink/70 mb-2">
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

        <div className="text-[12.5px] leading-relaxed text-ink/70 mb-2">
          Then keep <b>one Chrome window open</b> with the extension active while you
          work — that&rsquo;s the window your browser tasks run in.
        </div>
        <img
          src={extActiveImg}
          alt="A Chrome window with the Claude side panel active"
          className="w-full rounded-md border border-black/10 mb-3"
        />

        <div className="flex items-center gap-2.5 text-[12.5px] text-ink/70">
          <Toggle
            checked={ext?.status === 'done'}
            disabled={busy || !ext}
            onChange={(on) => void setConfirm('chrome-extension', on)}
          />
          <span>I&rsquo;ve installed the extension and have a Chrome window open</span>
        </div>
      </div>

      {/* ─── Optional: add as you go ─── */}
      <div className="rounded-lg border border-black/10 p-4 mb-3 bg-cream-mid/20">
        <div className="text-[13px] font-semibold text-ink mb-1">
          Add more as you go <span className="text-ink/40 font-normal">(optional)</span>
        </div>
        <div className="text-[12.5px] leading-relaxed text-ink/60 mb-3">
          With an agent set up you are already working. These just unlock more —
          connect them whenever you want, and a task will ask for what it needs, when
          it needs it. Sign into your accounts (Gmail and the rest) in that same Chrome
          window so browser tasks can act for you. Unmute never sees your credentials —
          you authorize each one in your own agent.
        </div>

        {optional.map((step) => (
          <div key={step.key} className="py-1.5 border-t border-black/5 first:border-t-0">
            <div className="flex items-start gap-2">
              <span className={step.status === 'done' ? 'text-green-700' : 'text-ink/30'}>
                {step.status === 'done' ? '✓' : '○'}
              </span>
              <div className="flex-1">
                <div className={`text-[12.5px] font-medium ${step.status === 'done' ? 'text-ink/50 line-through' : 'text-ink'}`}>
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
                  <div className="flex items-center gap-2 mt-1.5 text-[11px] text-ink/60">
                    <Toggle
                      checked={step.status === 'done'}
                      disabled={busy}
                      onChange={(on) => void setConfirm(step.key, on)}
                    />
                    <span>I&rsquo;ve done this</span>
                  </div>
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
