// Engine pillars — the production-grade replacement for the old
// radio (Auto / Managed / Local).
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

type EngineMode = 'auto' | 'managed' | 'local'
type PillarId = 'managed' | 'local'

// Order matters — also drives the Auto preference display.
const PILLAR_ORDER: PillarId[] = ['managed', 'local']

const ENGINE_TO_PILLAR: Record<Exclude<EngineMode, 'auto'>, PillarId> = {
  managed: 'managed',
  local: 'local',
}

export function EnginePillars() {
  const auth = useAuth()

  // Engine mode (persisted) — 'auto' or one of the three pillars
  const [mode, setMode] = useState<EngineMode>('auto')

  // Managed: subscription status, surfaced live
  const [subActive, setSubActive] = useState<boolean>(false)
  const [managedVerifying, setManagedVerifying] = useState(false)
  const [managedVerifyResult, setManagedVerifyResult] = useState<VerifyState>(null)

  // Local: whisper model availability + download
  const [whisperModelReady, setWhisperModelReady] = useState(false)
  const [whisperDownloading, setWhisperDownloading] = useState(false)
  const [whisperProgress, setWhisperProgress] = useState(0)

  // ─── Initial load ────────────────────────────────────────────
  useEffect(() => {
    window.electronAPI.paywallGetEngineMode?.().then((v) => {
      if (v === 'auto' || v === 'managed' || v === 'local') setMode(v)
    }).catch(() => {})

    window.electronAPI.getWhisperModelStatus().then(setWhisperModelReady).catch(() => {})
    window.electronAPI.onWhisperDownloadProgress?.((p: number) => setWhisperProgress(p))

    return () => {
      window.electronAPI.removeAllListeners?.('whisper:download-progress')
    }
  }, [])

  // Subscription status — fetched on mount AND re-fetched once the auth token
  // has propagated to the main process (auth.sessionEpoch). Without the epoch
  // dep, a cold-start mount fetch races ahead of the token and reads a false
  // "inactive" (Free) that only self-corrects on a tab switch / refresh.
  useEffect(() => {
    window.electronAPI.paywallGetSubscription?.().then((s) => {
      if (s) setSubActive(!!s.active)
    }).catch(() => {})
  }, [auth.sessionEpoch])

  // ─── Derived: pillar readiness (drives Active + Auto) ────────
  const ready: Record<PillarId, boolean> = {
    managed: auth.signedIn && subActive,
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
      const s = await window.electronAPI.paywallGetSubscription?.()
      const ms = Math.round(performance.now() - t0)
      if (s) {
        setSubActive(!!s.active)
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
          onSelect={() => handleModeChange('managed')}
          onSignIn={() => auth.openSignIn()}
          verifying={managedVerifying}
          verifyResult={managedVerifyResult}
          onVerify={handleVerifyManaged}
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
  return p === 'managed' ? 'Managed' : 'Local'
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
            sub-component (subscription plans + manage) inline. */}
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

  // When signed in, embed the full Billing UI (subscription plans +
  // manage) inside this card — billing IS the managed cloud
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
      tradeOff="Requires an active subscription. From $4.99/mo — cancel any time."
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
        Download model (~480 MB)
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
      valueProp="Parakeet v3 (multilingual, on-device). Runs on this Mac. Private and offline."
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

function LaptopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  )
}
