// Engine pillars — the production-grade replacement for the old
// 4-way radio (Auto / Managed / BYOK / Local) + separate Groq API Key
// section.
//
// Design:
//   * Single "Auto" toggle at the top — when on, the system picks the
//     best available pillar; cards become informational badges. When
//     off, cards become single-select.
//   * Three pillar cards stacked vertically. Each card surfaces:
//       - Cost badge (Free / per-dictation estimate)
//       - Setup state (Ready / Needs setup / Blocked)
//       - INLINE setup UI when needed — no hunting for a separate
//         section elsewhere in the page
//       - Live active indicator + "Verify" self-test
//       - Trade-off note + "Best for" line
//
// No backend / IPC changes — every IPC, settings key, and provider-
// router behavior reused as-is. Pure UX restructure.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from './AuthContext'
import { Billing } from './Billing'

type EngineMode = 'auto' | 'managed' | 'byok' | 'local'
type PillarId = 'managed' | 'byok' | 'local'

// Order matters — also drives the Auto preference display.
const PILLAR_ORDER: PillarId[] = ['managed', 'byok', 'local']

const ENGINE_TO_PILLAR: Record<Exclude<EngineMode, 'auto'>, PillarId> = {
  managed: 'managed',
  byok: 'byok',
  local: 'local',
}

export function EnginePillars() {
  const auth = useAuth()

  // Engine mode (persisted) — 'auto' or one of the three pillars
  const [mode, setMode] = useState<EngineMode>('auto')

  // Managed: balance, surfaced live
  const [balanceCents, setBalanceCents] = useState<number>(0)
  const [managedVerifying, setManagedVerifying] = useState(false)
  const [managedVerifyResult, setManagedVerifyResult] = useState<VerifyState>(null)

  // BYOK: key state + inline save/remove flow
  const [groqKeyInput, setGroqKeyInput] = useState('')
  const [groqKeyMasked, setGroqKeyMasked] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)

  // Local: whisper model availability + download
  const [whisperModelReady, setWhisperModelReady] = useState(false)
  const [whisperDownloading, setWhisperDownloading] = useState(false)
  const [whisperProgress, setWhisperProgress] = useState(0)

  // ─── Initial load ────────────────────────────────────────────
  useEffect(() => {
    window.electronAPI.paywallGetEngineMode?.().then((v) => {
      if (v === 'auto' || v === 'managed' || v === 'byok' || v === 'local') setMode(v)
    }).catch(() => {})

    window.electronAPI.getGroqKeyStatus().then((s) => {
      setGroqKeyMasked(s.hasKey ? s.masked : null)
    }).catch(() => {})

    window.electronAPI.getWhisperModelStatus().then(setWhisperModelReady).catch(() => {})
    window.electronAPI.onWhisperDownloadProgress?.((p: number) => setWhisperProgress(p))

    window.electronAPI.paywallGetBalance?.().then((s) => {
      if (s) setBalanceCents(s.balanceCents)
    }).catch(() => {})
    window.electronAPI.paywallOnBalanceUpdated?.((next) => {
      setBalanceCents(next.balanceCents)
    })

    return () => {
      window.electronAPI.removeAllListeners?.('whisper:download-progress')
      window.electronAPI.removeAllListeners?.('paywall:balance-updated')
    }
  }, [])

  // ─── Derived: pillar readiness (drives Active + Auto) ────────
  const ready: Record<PillarId, boolean> = {
    managed: auth.signedIn && balanceCents > 0,
    byok: !!groqKeyMasked,
    local: whisperModelReady,
  }

  /** What "auto" would actually pick right now, in priority order. */
  const autoPick: PillarId | null =
    PILLAR_ORDER.find((p) => ready[p]) ?? null

  /** Currently active pillar — what's actually serving dictations. */
  const activePillar: PillarId | null =
    mode === 'auto' ? autoPick : ENGINE_TO_PILLAR[mode]

  // ─── Handlers ────────────────────────────────────────────────

  const handleModeChange = useCallback((next: EngineMode) => {
    setMode(next)
    window.electronAPI.paywallSetEngineMode?.(next)
  }, [])

  const handleAutoToggle = useCallback((on: boolean) => {
    if (on) {
      handleModeChange('auto')
    } else {
      // Switching off auto — pick whatever auto WOULD have picked,
      // or fall back to managed (the recommended default).
      handleModeChange((autoPick ?? 'managed') as EngineMode)
    }
  }, [autoPick, handleModeChange])

  async function handleSaveKey() {
    const key = groqKeyInput.trim()
    if (!key || keyBusy) return
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const test = await window.electronAPI.testGroqKey(key)
      if (!test.ok) {
        setKeyMsg({ text: test.error || 'Invalid key', type: 'err' })
        return
      }
      const res = await window.electronAPI.setGroqKey(key)
      if (res.success) {
        setGroqKeyMasked(res.masked ?? null)
        setGroqKeyInput('')
        setKeyMsg({ text: 'Saved.', type: 'ok' })
        setTimeout(() => setKeyMsg(null), 2500)
      } else {
        setKeyMsg({ text: res.error || 'Failed to save key', type: 'err' })
      }
    } catch {
      setKeyMsg({ text: 'Something went wrong', type: 'err' })
    } finally {
      setKeyBusy(false)
    }
  }

  function handleRemoveKey() {
    window.electronAPI.clearGroqKey()
    setGroqKeyMasked(null)
    setGroqKeyInput('')
    setKeyMsg(null)
  }

  async function handleDownloadWhisper() {
    if (whisperDownloading) return
    setWhisperDownloading(true)
    setWhisperProgress(0)
    try {
      const res = await window.electronAPI.downloadWhisperModel()
      if (res.success) setWhisperModelReady(true)
    } catch { /* UI returns to idle */ }
    finally {
      setWhisperDownloading(false)
    }
  }

  async function handleVerifyManaged() {
    if (managedVerifying) return
    setManagedVerifying(true)
    setManagedVerifyResult(null)
    const t0 = performance.now()
    try {
      const s = await window.electronAPI.paywallRefreshBalance?.()
      const ms = Math.round(performance.now() - t0)
      if (s) {
        setBalanceCents(s.balanceCents)
        setManagedVerifyResult({ ok: true, text: `Works — ${ms}ms` })
      } else {
        setManagedVerifyResult({ ok: false, text: 'No response from server' })
      }
    } catch {
      setManagedVerifyResult({ ok: false, text: 'Network error' })
    } finally {
      setManagedVerifying(false)
      setTimeout(() => setManagedVerifyResult(null), 4000)
    }
  }

  // ─── Render ──────────────────────────────────────────────────

  const isAuto = mode === 'auto'
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`

  return (
    <div className="space-y-3">
      {/* ── Auto toggle ── */}
      <div className="px-4 py-3 bg-cream-mid border border-border rounded-2xl flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">Auto-pick best available</p>
          <p className="text-[11px] text-ink-60 mt-0.5 leading-snug">
            {isAuto
              ? autoPick
                ? <>Currently using <span className="font-semibold text-ink">{labelFor(autoPick)}</span>. Falls back to next available if it stops working.</>
                : <span className="text-warm">No engine is ready yet — set up at least one below.</span>
              : <>Off — you've selected <span className="font-semibold text-ink">{labelFor(activePillar ?? 'managed')}</span> manually.</>
            }
          </p>
        </div>
        <Switch checked={isAuto} onChange={handleAutoToggle} />
      </div>

      {/* ── Pillar cards ── */}
      <div className="space-y-2.5">
        <ManagedCard
          isActive={activePillar === 'managed'}
          isSelected={mode === 'managed'}
          isAuto={isAuto}
          ready={ready.managed}
          signedIn={auth.signedIn}
          email={auth.user?.email ?? null}
          balanceCents={balanceCents}
          onSelect={() => handleModeChange('managed')}
          onSignIn={() => auth.openSignIn()}
          verifying={managedVerifying}
          verifyResult={managedVerifyResult}
          onVerify={handleVerifyManaged}
        />

        <BYOKCard
          isActive={activePillar === 'byok'}
          isSelected={mode === 'byok'}
          isAuto={isAuto}
          ready={ready.byok}
          keyMasked={groqKeyMasked}
          keyInput={groqKeyInput}
          onKeyInputChange={setGroqKeyInput}
          onSave={handleSaveKey}
          onRemove={handleRemoveKey}
          busy={keyBusy}
          message={keyMsg}
          onSelect={() => handleModeChange('byok')}
        />

        <LocalCard
          isActive={activePillar === 'local'}
          isSelected={mode === 'local'}
          isAuto={isAuto}
          ready={ready.local}
          downloading={whisperDownloading}
          progress={whisperProgress}
          onDownload={handleDownloadWhisper}
          onSelect={() => handleModeChange('local')}
        />
      </div>

    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────

type VerifyState = { ok: boolean; text: string } | null

function labelFor(p: PillarId): string {
  return p === 'managed' ? 'Managed' : p === 'byok' ? 'BYOK' : 'Local'
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-[38px] h-[22px] rounded-full transition-all duration-200 relative shrink-0 ${
        checked ? 'bg-ink' : 'bg-cream-dark'
      }`}
    >
      <div
        className={`w-[18px] h-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.18)] absolute top-[2px] transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

// ── Card shells share the same outer chrome ────────────────────

interface CardShellProps {
  isActive: boolean
  isSelected: boolean
  isAuto: boolean
  ready: boolean
  icon: React.ReactNode
  title: string
  valueProp: string
  statusBlock: React.ReactNode
  setupBlock?: React.ReactNode
  expandedBlock?: React.ReactNode
  bestFor: string
  tradeOff: string
  onSelect: () => void
  verifyBlock?: React.ReactNode
}

function CardShell(p: CardShellProps) {
  const borderClass = p.isActive
    ? 'border-ink shadow-md'
    : p.isSelected
      ? 'border-ink/40'
      : 'border-border'

  return (
    <div className={`bg-surface-2 border-2 rounded-2xl overflow-hidden transition-all ${borderClass}`}>
      <div className="px-5 py-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-cream-mid border border-border flex items-center justify-center text-ink-60 shrink-0">
            {p.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-[14px] font-semibold text-ink">{p.title}</p>
              {p.isActive && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold uppercase tracking-wider">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
                  Active
                </span>
              )}
            </div>
            <p className="text-[12px] text-ink-60 mt-0.5 leading-snug">{p.valueProp}</p>
          </div>
        </div>

        {/* Status */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {p.statusBlock}
        </div>

        {/* Inline setup */}
        {p.setupBlock && <div className="mt-3">{p.setupBlock}</div>}

        {/* Expanded panel — used by Managed to render the full Billing
            sub-component (balance, top-up, recent activity) inline. */}
        {p.expandedBlock && <div className="mt-3">{p.expandedBlock}</div>}

        {/* Verify + manual select */}
        <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {!p.isAuto && p.isSelected && (
              <span className="text-[11px] font-medium text-ink-60">Currently selected</span>
            )}
            {!p.isAuto && !p.isSelected && p.ready && (
              <button
                onClick={p.onSelect}
                className="px-3 py-1.5 rounded-full bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity"
              >
                Use this
              </button>
            )}
            {p.isAuto && p.isActive && (
              <span className="text-[11px] font-medium text-ink-60">Auto-selected</span>
            )}
          </div>
          {p.verifyBlock}
        </div>

        {/* Best-for + trade-off */}
        <div className="mt-3 pt-3 border-t border-border text-[11px] text-ink-35 leading-relaxed">
          <span className="font-semibold text-ink-60">Best for:</span> {p.bestFor}
          <br />
          <span className="font-semibold text-ink-60">Note:</span> {p.tradeOff}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${
        ok ? 'bg-green-50 text-green-700' : 'bg-warm-soft text-warm'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-600' : 'bg-warm'}`} />
      {text}
    </span>
  )
}

function VerifyButton({ verifying, result, onVerify }: {
  verifying: boolean
  result: VerifyState
  onVerify: () => void
}) {
  if (result) {
    return (
      <span className={`text-[11px] font-medium ${result.ok ? 'text-green-700' : 'text-red-500'}`}>
        {result.ok ? '✓ ' : '✗ '}{result.text}
      </span>
    )
  }
  return (
    <button
      onClick={onVerify}
      disabled={verifying}
      className="text-[11px] text-ink-60 hover:text-ink underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
    >
      {verifying ? 'Verifying…' : 'Verify'}
    </button>
  )
}

// ── Managed card ──────────────────────────────────────────────

function ManagedCard(props: {
  isActive: boolean
  isSelected: boolean
  isAuto: boolean
  ready: boolean
  signedIn: boolean
  email: string | null
  balanceCents: number
  onSelect: () => void
  onSignIn: () => void
  verifying: boolean
  verifyResult: VerifyState
  onVerify: () => void
}) {
  // Status states
  let statusBlock: React.ReactNode
  let setupBlock: React.ReactNode = null
  if (!props.signedIn) {
    statusBlock = <StatusBadge ok={false} text="Sign in to use" />
    setupBlock = (
      <button
        onClick={props.onSignIn}
        className="px-4 py-2 rounded-[10px] bg-ink text-white text-[12px] font-semibold hover:opacity-90 transition-opacity"
      >
        Sign in
      </button>
    )
  } else {
    statusBlock = <StatusBadge ok={true} text={`Signed in as ${props.email ?? 'you'}`} />
  }

  // When signed in, embed the full Billing UI (balance, top-up tiers,
  // recent activity) inside this card — billing IS the managed cloud
  // flow, not a separate concept.
  const expandedBlock = props.signedIn ? (
    <div className="mt-1 rounded-2xl border border-border bg-cream-mid/40 overflow-hidden">
      <Billing />
    </div>
  ) : null

  return (
    <CardShell
      isActive={props.isActive}
      isSelected={props.isSelected}
      isAuto={props.isAuto}
      ready={props.ready}
      icon={<CloudIcon />}
      title="No key required"
      valueProp="Plug-and-play. We handle the key — and we store nothing about your dictations."
      statusBlock={statusBlock}
      setupBlock={setupBlock}
      expandedBlock={expandedBlock}
      bestFor="Anyone who wants it to just work. Faster than mainstream dictation tools — optimized end to end."
      tradeOff="Pay-per-use credits. Only deducted when this engine is used. Credits never expire."
      onSelect={props.onSelect}
      verifyBlock={
        props.ready ? (
          <VerifyButton
            verifying={props.verifying}
            result={props.verifyResult}
            onVerify={props.onVerify}
          />
        ) : null
      }
    />
  )
}

// ── BYOK card ──────────────────────────────────────────────────

function BYOKCard(props: {
  isActive: boolean
  isSelected: boolean
  isAuto: boolean
  ready: boolean
  keyMasked: string | null
  keyInput: string
  onKeyInputChange: (v: string) => void
  onSave: () => void
  onRemove: () => void
  busy: boolean
  message: { text: string; type: 'ok' | 'err' } | null
  onSelect: () => void
}) {
  let statusBlock: React.ReactNode
  if (props.keyMasked) {
    statusBlock = <StatusBadge ok={true} text={`Connected · ${props.keyMasked}`} />
  } else {
    statusBlock = <StatusBadge ok={false} text="No key saved" />
  }

  const setupBlock = (
    <div>
      {props.keyMasked ? (
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-ink-60">Paste a new key to replace, or remove the saved one.</p>
          <button
            onClick={props.onRemove}
            className="text-[11px] font-medium text-ink-60 hover:text-red-500 transition-colors px-2 py-1"
          >
            Remove
          </button>
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          value={props.keyInput}
          onChange={(e) => props.onKeyInputChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') props.onSave() }}
          placeholder={props.keyMasked ? 'Paste a new key to replace' : 'gsk_...'}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-cream-mid border border-border-md rounded-[10px] px-3.5 py-2 text-[12px] font-mono text-ink outline-none focus:border-ink/30 transition-colors"
        />
        <button
          onClick={props.onSave}
          disabled={!props.keyInput.trim() || props.busy}
          className="px-4 py-2 rounded-[10px] text-[12px] font-semibold bg-ink text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity whitespace-nowrap"
        >
          {props.busy ? 'Checking…' : 'Save'}
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={() => window.electronAPI.openExternal('https://console.groq.com/keys')}
          className="text-[11px] text-ink-35 hover:text-ink transition-colors underline underline-offset-2"
        >
          Get a free key →
        </button>
        {props.message && (
          <span className={`text-[11px] font-medium ${props.message.type === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
            {props.message.text}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <CardShell
      isActive={props.isActive}
      isSelected={props.isSelected}
      isAuto={props.isAuto}
      ready={props.ready}
      icon={<KeyIcon />}
      title="Your Groq key"
      valueProp="Fast and accurate. As good as the best dictation tools — or better."
      statusBlock={statusBlock}
      setupBlock={setupBlock}
      bestFor="Power users with their own Groq account."
      tradeOff="Get your key at console.groq.com and recharge it there when it runs out."
      onSelect={props.onSelect}
    />
  )
}

// ── Local card ─────────────────────────────────────────────────

function LocalCard(props: {
  isActive: boolean
  isSelected: boolean
  isAuto: boolean
  ready: boolean
  downloading: boolean
  progress: number
  onDownload: () => void
  onSelect: () => void
}) {
  let statusBlock: React.ReactNode
  let setupBlock: React.ReactNode = null
  if (props.ready) {
    statusBlock = <StatusBadge ok={true} text="Model installed" />
  } else if (props.downloading) {
    statusBlock = <StatusBadge ok={false} text={`Downloading${props.progress > 0 ? ` — ${Math.round(props.progress)}%` : '…'}`} />
  } else {
    statusBlock = <StatusBadge ok={false} text="Model not installed" />
    setupBlock = (
      <button
        onClick={props.onDownload}
        className="px-4 py-2 rounded-[10px] bg-ink text-white text-[12px] font-semibold hover:opacity-90 transition-opacity"
      >
        Download model (~75 MB)
      </button>
    )
  }

  return (
    <CardShell
      isActive={props.isActive}
      isSelected={props.isSelected}
      isAuto={props.isAuto}
      ready={props.ready}
      icon={<LaptopIcon />}
      title="On-device"
      valueProp="Runs on this Mac. Private and offline."
      statusBlock={statusBlock}
      setupBlock={setupBlock}
      bestFor="Reliable fallback when internet is flaky — kicks in automatically when cloud is slow."
      tradeOff="Slightly less accurate than the other two engines."
      onSelect={props.onSelect}
    />
  )
}

// ── Icons ──────────────────────────────────────────────────────

function CloudIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
    </svg>
  )
}

function LaptopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  )
}
