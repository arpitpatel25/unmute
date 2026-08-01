// Managed-build WidgetApp override.
//
// Extends the OSS WidgetApp with the OfflineAwarenessCard — appears below
// the pill whenever the on-device engine is the one routing this dictation,
// telling the user *why* (not signed in / no balance / cloud unreachable /
// chose-on-device). Dismissible per app session; reappears on next launch.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { panelRows, hudHeight, contentOffset, HUD_BASE } from './hudSizing'
import Widget from './Widget'
import { useAudioRecorder } from './useAudioRecorder'
import {
  shouldShowAgentPicker, currentAgentLabel as agentLabelOf,
  currentAgentConnected as agentConnectedOf, nextAgentId, type AgentPickerState,
} from './agentPicker'
import type { WidgetState } from '../shared/types'
import OfflineAwarenessCard, { type OfflineReason } from './OfflineAwarenessCard'
import {
  findIphoneMic,
  resolveCaptureDeviceId,
  effectiveSource,
  type MicSource,
  type AudioInputDeviceInfo,
} from './micSource'
import { connectWarmMic, disconnectWarmMic, onWarmState, warmState, type WarmState } from './micWarm'
import {
  nativePillActive, toPhase, usePillState, usePillTicker, usePillEvents,
} from './pillBridge'

/** Dodo customer portal, for the payment-failed recovery on the pill. */
function portalApi() {
  return window.electronAPI as unknown as {
    paywallOpenPortal?: () => Promise<{ ok: boolean; portalUrl?: string }>
    paywallOpenExternal?: (url: string) => Promise<unknown>
  }
}

// ─── Sound Feedback (Web Audio API) ───
let soundEnabled = true

function playClickSound(type: 'start' | 'stop') {
  if (!soundEnabled) return
  try {
    const ctx = new AudioContext()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.frequency.setValueAtTime(type === 'start' ? 880 : 660, ctx.currentTime)
    oscillator.type = 'sine'
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.connect(lfoGain)
    lfoGain.connect(oscillator.frequency)
    lfo.type = 'sine'
    lfo.frequency.setValueAtTime(14, ctx.currentTime)
    lfoGain.gain.setValueAtTime(8, ctx.currentTime)
    lfo.start(ctx.currentTime)
    lfo.stop(ctx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.07, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08)
    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + 0.08)
    setTimeout(() => ctx.close(), 200)
  } catch {
    /* sound is non-critical */
  }
}

// Awareness widget is hidden once the user × it. Module-scoped so it
// persists across pill open/close within this app session — only an app
// restart resets it (which is what we want).
let sessionDismissed = false

// Remote capture marker — a dark chip shown to the LEFT of the pill (with a gap)
// ONLY during a Remote capture. Same dark fill (#0E0E10), whitish border, and
// drop shadow as the pill so they read as one family. Instead of an icon it
// shows the active DOER MODEL name in Claude's orange, so the user always knows
// which model the task will run on. Hovering expands an inline selector
// (Haiku · Sonnet · Opus) so they can switch ON THE FLY while speaking — the
// choice applies to THIS task on submit (and persists as the default).
const CLAUDE_ORANGE = '#D97757'

// One selectable doer model — mirrors ModelChoice in remote/config.ts. The
// catalog is CONFIG-DRIVEN on the main side (getModelCatalog): new models arrive
// via runtime config with NO app build, so the widget must never hardcode the
// set. It reads the SAME catalog the Remote settings panel does — one source of
// truth for "which models exist", in Settings and here in the live switcher.
interface ModelChoice { id: string; label: string; description?: string }
// Fallback only if the catalog IPC is unavailable (older main) — classic tiers.
const FALLBACK_CATALOG: ModelChoice[] = [
  { id: 'haiku', label: 'Haiku', description: 'Fastest — best for simple, quick tasks.' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced speed and capability. Great default.' },
  { id: 'opus', label: 'Opus', description: 'Most capable — best for hard, multi-step tasks.' },
]

function remoteModelApi() {
  return window.electronAPI as unknown as {
    remoteGetModel?: () => Promise<string>
    remoteSetModel?: (m: string) => Promise<string>
    remoteOnModelChanged?: (cb: (model: string) => void) => () => void
    remoteGetModelCatalog?: () => Promise<ModelChoice[]>
    /** Models for ONE backend, in that backend's own vocabulary. */
    remoteModelOptions?: (agent: string) => Promise<{ agent: string; models: ModelChoice[] }>
    paywallSetHUDHeight?: (height: number, opts?: { upward?: boolean }) => Promise<boolean>
  }
}

function remoteCodexApi() {
  return window.electronAPI as unknown as {
    remoteAgentOptions?: () => Promise<{ current: string }>
    remoteCodexReasoning?: () => Promise<{
      label: string | null
      current: Partial<Record<'Model' | 'Effort' | 'Speed', string>>
      options: Partial<Record<'Model' | 'Effort' | 'Speed', string[]>>
    }>
    remoteCodexReasoningSet?: (axis: 'Model' | 'Effort' | 'Speed', value: string) => Promise<boolean>
  }
}

/**
 * THE CHIP MUST FOLLOW THE AGENT PICKER.
 *
 * It always read the Claude catalog and had no idea the picker existed, so
 * "Codex + Opus" was a reachable state: the task ran on Codex and the model
 * choice was written to unmute's Claude setting and silently discarded. Codex
 * has its own tiers — and its own effort and speed axes, which for that backend
 * are as much a part of "what am I running this on" as the model name.
 *
 * Names are never hardcoded; they come from the running Codex. When Codex is
 * closed we show the last list we truly saw rather than inventing one.
 */
interface AgentPickerLite {
  current: string
  options: Array<{ id: string; label: string; available: boolean; installed?: boolean }>
}

function RemoteBadge({ picker, onPickAgent }: {
  picker?: AgentPickerLite | null
  onPickAgent?: (id: string) => void
}) {
  const [catalog, setCatalog] = useState<ModelChoice[]>(FALLBACK_CATALOG)
  // The saved doer-model id — ANY catalog id, not limited to haiku/sonnet/opus.
  const [model, setModel] = useState<string>('sonnet')
  const [expanded, setExpanded] = useState(false)
  // Agent side of the joined control. `picker` is the same state the pill used
  // to own — only the rendering moved, so this reuses the SAME tested helpers
  // rather than re-deriving the rules. They exist because a hand-written
  // visibility guard hid this chip for four builds; duplicating that logic here
  // would be the same mistake with a new home.
  const showAgent = shouldShowAgentPicker({ isRemote: true, picker: picker as AgentPickerState | undefined })
  const agentLabel = showAgent ? agentLabelOf(picker as AgentPickerState | undefined) : null
  const agentConnected = agentConnectedOf(picker as AgentPickerState | undefined)
  const cycleAgent = () => {
    const next = nextAgentId(picker as AgentPickerState | undefined)
    if (onPickAgent && next) onPickAgent(next)
  }

  const [codex, setCodex] = useState<{
    label: string | null
    current: Partial<Record<'Model' | 'Effort' | 'Speed', string>>
    options: Partial<Record<'Model' | 'Effort' | 'Speed', string[]>>
  } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ONE SOURCE OF TRUTH for which agent is selected.
  //
  // This used to keep its own copy, refreshed by a 1500ms poll, while the chip's
  // LABEL came from `picker` — which WidgetApp updates optimistically the
  // instant you tap. Two clocks for one fact: the chip flipped immediately and
  // the list below it kept showing the other agent's models for up to a second
  // and a half before snapping over. `picker` is already kept fresh by
  // WidgetApp (loaded on capture, updated on tap, refreshed after connect), so
  // the second copy was redundant as well as wrong.
  const isCodex = (picker?.current ?? 'claude') === 'codex-desktop'
  // WHICH backend's models to ask for. The flat catalogue used to be Claude
  // Code's, unconditionally — so selecting any other flat-list backend showed
  // Claude Code's aliases ('opus', 'opusplan'), models that backend may not
  // have. Asking per-agent is what keeps the list honest.
  const agentId = picker?.current ?? 'claude'

  // Codex's own axes, served from cache so they are there IMMEDIATELY. Reading
  // them live walks Codex's menus (~3s) — a capture is often over before that
  // returns, which is exactly why this chip kept showing a Claude model.
  useEffect(() => {
    if (!isCodex) return
    let cancelled = false
    // Deliberately NOT clearing first. Blanking on the way in meant the panel
    // rendered its empty state — and asked for a near-collapsed window — for as
    // long as the fetch took, so switching to Codex flashed "connect Codex" and
    // the window snapped down and back up.
    void remoteCodexApi().remoteCodexReasoning?.().then((r) => {
      if (!cancelled && r) setCodex(r)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [isCodex])

  useEffect(() => {
    // DEPS MATTER HERE. With `[]` this read `isCodex` from the first render,
    // where it is always false — so the guard never fired, the Claude catalog
    // always loaded, and its model-changed listener kept overwriting the Codex
    // value. That is why the chip said "Opus" with Codex selected.
    if (isCodex) return
    const api = remoteModelApi()
    // Reflect whatever the saved model IS — never silently downgrade an id we
    // don't recognise. (The old guard forced any non-{haiku,sonnet,opus} value
    // to 'sonnet', so a pinned / opusplan / default pick showed the WRONG badge
    // while the task actually ran on the real model.)
    void api.remoteGetModel?.().then((m) => { if (typeof m === 'string' && m) setModel(m) })
    // Per-backend. An EMPTY list is a real answer meaning "we cannot know what
    // this app offers" — leave the catalogue empty and show nothing selectable
    // rather than falling back to another backend's models.
    void api.remoteModelOptions?.(agentId)
      .then((r) => setCatalog(r?.models?.length ? r.models as ModelChoice[] : []))
      .catch(() => setCatalog([]))
    const off = api.remoteOnModelChanged?.((m) => { if (typeof m === 'string' && m) setModel(m) })
    return () => off?.()
  }, [isCodex, agentId])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  /**
   * The rows the dropdown shows: one flat list for Claude, three axes for Codex.
   *
   * MEMOISED because it is a dependency of the resize effect below. Rebuilt
   * every render it had a fresh identity every render, so that effect — and its
   * CLEANUP, which collapses the window back to 72px — ran on every single
   * render. The window was shrinking and re-expanding continuously while the
   * list was open. That was the bulk of the stutter.
   */
  const axes = useMemo(
    () => (isCodex
      ? (['Model', 'Effort', 'Speed'] as const)
          .map((axis) => ({ axis, values: codex?.options[axis] ?? [], current: codex?.current[axis] }))
          .filter((a) => a.values.length)
      : []),
    [isCodex, codex],
  )

  // The selector opens DOWNWARD (a dropdown below the pill row) so it scales to
  // ANY number of catalog models — a horizontal reveal can't. Same seam the
  // staged-images dropdown uses: grow the HUD window while open so the list
  // isn't clipped, restore the 72px default on close/unmount.
  useEffect(() => {
    const api = remoteModelApi()
    const rows = panelRows(isCodex, axes, catalog.length)
    // UPWARD, WITH THE PILL PINNED.
    //
    // Growing the window upward alone is not enough — that is what shipped in
    // dev.43 and it dragged the pill up the screen with the window's top edge,
    // away from the cursor that opened it. The window's extra height appears
    // ABOVE the old top edge, so the content must be pushed down by exactly
    // that much to stay where it was. `--hud-extra` carries it to the root,
    // which divides by the 0.75 scale the whole pill family is drawn at.
    const BASE = HUD_BASE
    const height = hudHeight(expanded, rows)
    const pad = (h: number) =>
      document.documentElement.style.setProperty('--hud-extra', `${contentOffset(h)}px`)

    // ORDER MATTERS, because the resize is an IPC round-trip while the padding
    // lands on the next paint. Whichever is applied first must be the one that
    // cannot clip:
    //   growing  — resize first. Padding first would push content down inside a
    //              window that is still short, cutting it off at the bottom.
    //   shrinking — pad first. Content moves up while the window is still tall;
    //              shrinking first would strand it below the new top edge.
    let cancelled = false
    void (async () => {
      const grow = height > BASE
      if (!grow) pad(height)
      await api.paywallSetHUDHeight?.(height, { upward: true })
      if (!cancelled && grow) pad(height)
    })()

    return () => {
      cancelled = true
      pad(BASE)
      void remoteModelApi().paywallSetHUDHeight?.(BASE, { upward: true })
    }
  }, [expanded, catalog.length, isCodex, axes])   // `axes` is memoised above

  const open = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setExpanded(true)
  }
  // Small grace before collapsing so crossing the gap into the dropdown doesn't
  // flicker it shut.
  const scheduleClose = () => { closeTimer.current = setTimeout(() => setExpanded(false), 150) }

  const pick = (m: string) => {
    setModel(m) // optimistic — reflects instantly; the next task reads the setting
    if (isCodex) pickAxis('Model', m)
    else { void remoteModelApi().remoteSetModel?.(m); setExpanded(false) }
  }

  /** Codex has three axes, not one — model alone is half the setting. */
  const pickAxis = (axis: 'Model' | 'Effort' | 'Speed', value: string) => {
    setCodex((prev) => (prev ? { ...prev, current: { ...prev.current, [axis]: value } } : prev))
    void remoteCodexApi().remoteCodexReasoningSet?.(axis, value)
    setExpanded(false)
  }

  const active = catalog.find((c) => c.id === model)
  // If the saved id isn't in the catalog, still show its raw id rather than
  // masquerading as another model — the anti-downgrade rule, applied to display.
  // For Codex the chip carries model AND effort, the way Codex's own control
  // does ("5.6 Terra High") — effort is half of what the run will cost.
  const activeLabel = isCodex
    ? [codex?.current.Model, codex?.current.Effort].filter(Boolean).join(' ') || 'Codex'
    : (active?.label ?? model)


  return (
    <div
      style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', position: 'relative' }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      {/* AGENT + MODEL AS ONE CONTROL. The agent chip used to live on the
          recording side of the pill, beside the timer and the stop button —
          nothing there has anything to do with where the task runs. Joined to
          the model selector it reads as the single decision it is: the agent
          determines which models exist, so "Codex → 5.6 Terra High" is one
          sentence, left to right. */}
      {agentLabel && (
        <button
          onClick={cycleAgent}
          title={agentConnected ? 'Where this task runs — tap to switch' : 'Not connected — tap to connect'}
          style={{
            height: 44, borderRadius: '9999px 0 0 9999px', background: '#000',
            border: '1px solid rgba(255,255,255,0.55)', borderRight: 'none',
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '0 12px 0 15px', cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
            color: agentConnected ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.5)',
          }}
        >
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flex: 'none',
            background: agentConnected ? '#6fbf9a' : 'rgba(255,255,255,0.35)',
          }} />
          {agentLabel}{agentConnected ? '' : ' · connect'}
        </button>
      )}
      {agentLabel && (
        <div style={{ width: 1, height: 44, background: 'rgba(255,255,255,0.28)', flex: 'none' }} />
      )}
      {/* Collapsed: a single pill showing the active model. Same family as the
          RAW toggle / mic chip — dark fill, whitish border, NO shadow. */}
      <div
        style={{
          height: 44,
          // Square off the joined edge so the pair reads as one control.
          borderRadius: agentLabel ? '0 9999px 9999px 0' : 9999,
          background: '#000',
          border: '1px solid rgba(255, 255, 255, 0.55)',
          borderLeft: agentLabel ? 'none' : undefined,
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: agentLabel ? '0 14px 0 12px' : '0 14px',
          gap: 7,
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          color: CLAUDE_ORANGE,
        }}
      >
        <span>{activeLabel}</span>
        {/* chevron — rotates when the dropdown is open */}
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden
          style={{ opacity: 0.7, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Vertical dropdown: one row per catalog model, top → bottom. */}
      {expanded && (
        <div
          style={{
            // Anchored to the BOTTOM of the chip so it opens upward, matching
            // the window growth above.
            position: 'absolute', bottom: 48, left: 0, minWidth: 172, maxHeight: 360, overflowY: 'auto',
            background: '#000', border: '1px solid rgba(255,255,255,0.35)',
            // SIDE BY SIDE. Stacked, Codex's three axes are 13 rows — taller than
            // the space above a pill that already sits near the bottom edge, so
            // it scrolled. In columns everything is visible at once and the
            // panel is about a third the height.
            borderRadius: 13, padding: 7, display: 'flex',
            flexDirection: isCodex ? 'row' : 'column', gap: isCodex ? 14 : 2, zIndex: 10,
          }}
        >
          {/* Codex is not one axis. Model alone leaves effort and speed —
              which decide what a run costs and how long it takes — unreachable,
              and reaching them was the whole point of not being a restricted
              remote. */}
          {isCodex && axes.map(({ axis, values, current }) => (
            <div key={axis} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 116 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.35)', padding: '6px 10px 2px',
              }}>{axis}</div>
              {values.map((v) => {
                const on = v === current
                return (
                  <button
                    key={axis + v}
                    onClick={() => pickAxis(axis, v)}
                    style={{
                      textAlign: 'left', width: '100%', height: 32, padding: '0 10px',
                      borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                      fontSize: 12.5, fontWeight: 600,
                      background: on ? 'rgba(217,119,87,0.18)' : 'transparent',
                      color: on ? CLAUDE_ORANGE : 'rgba(255,255,255,0.7)',
                    }}
                    onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                    onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent' }}
                  >
                    {v}
                  </button>
                )
              })}
            </div>
          ))}
          {isCodex && axes.length === 0 && (
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)', padding: '8px 10px' }}>
              connect Codex to choose a model
            </div>
          )}
          {!isCodex && catalog.map((c) => {
            const isActive = c.id === model
            return (
              <button
                key={c.id}
                onClick={() => pick(c.id)}
                title={c.description ?? ''}
                style={{
                  textAlign: 'left', width: '100%', height: 34, padding: '0 10px',
                  borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                  fontSize: 12.5, fontWeight: 600,
                  background: isActive ? 'rgba(217,119,87,0.18)' : 'transparent',
                  color: isActive ? CLAUDE_ORANGE : 'rgba(255,255,255,0.7)',
                  transition: 'color 120ms ease, background 120ms ease',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                {c.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Staged-images chip (the attachment LEDGER, shown only during a Remote
// capture). Screenshots captured while addressing Unmute — or in the short
// window just before — stage automatically; this chip is the truth of what
// rides with the utterance: 🖼 n, hover → numbered ✕ buttons to prune. What
// you see is what sends. Same chip family as the model badge: dark fill,
// whitish border, NO shadow, horizontal glide (nothing pops outside the
// widget window).
function stagedApi() {
  return window.electronAPI as unknown as {
    remoteGetStaged?: () => Promise<string[]>
    remoteOnStagedChanged?: (cb: (d: { count: number; paths: string[]; pending?: number }) => void) => () => void
    remoteUnstageImage?: (path: string) => Promise<boolean>
    remoteGetStagedPreviews?: () => Promise<Array<{ path: string; dataUrl: string }>>
    paywallSetHUDHeight?: (height: number) => Promise<boolean>
  }
}

// Clean line-drawn image glyph (currentColor, no emoji).
function ImageGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}

function StagedImagesChip() {
  const [paths, setPaths] = useState<string[]>([])
  const [pending, setPending] = useState(0) // clipboard screenshot noticed mid-recording (readable only at key-lift)
  const [previews, setPreviews] = useState<Array<{ path: string; dataUrl: string }>>([])
  const [expanded, setExpanded] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const api = stagedApi()
    void api.remoteGetStaged?.().then((p) => { if (Array.isArray(p)) setPaths(p) })
    const off = api.remoteOnStagedChanged?.((d) => { setPaths(d.paths ?? []); setPending(d.pending ?? 0) })
    return () => off?.()
  }, [])
  // Refresh thumbnails whenever the dropdown is open and the set changes.
  useEffect(() => {
    if (!expanded) return
    void stagedApi().remoteGetStagedPreviews?.().then((p) => { if (Array.isArray(p)) setPreviews(p) })
  }, [expanded, paths])
  // The dropdown extends below the pill row — grow the (72px) HUD window while
  // open, restore on close/unmount. Same seam the awareness card uses.
  useEffect(() => {
    const api = stagedApi()
    const rows = paths.length + pending
    if (expanded && rows) void api.paywallSetHUDHeight?.(Math.min(220, 60 + rows * 42 + 16))
    else void api.paywallSetHUDHeight?.(72)
    return () => { void stagedApi().paywallSetHUDHeight?.(72) }
  }, [expanded, paths.length, pending])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const total = paths.length + pending
  if (total === 0) return null

  const open = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setExpanded(true)
  }
  const scheduleClose = () => { closeTimer.current = setTimeout(() => setExpanded(false), 200) }

  return (
    <div
      style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', position: 'relative' }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <div
        style={{
          height: 44,
          borderRadius: 9999,
          background: '#000',
          border: '1px solid rgba(255, 255, 255, 0.55)',
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          gap: 6,
          color: 'rgba(255,255,255,0.85)',
        }}
      >
        <ImageGlyph />
        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{total}</span>
      </div>

      {/* vertical dropdown: one row per image — thumbnail preview + remove */}
      {expanded && (
        <div
          style={{
            position: 'absolute', top: 48, left: 0, minWidth: 168,
            background: '#000', border: '1px solid rgba(255,255,255,0.35)',
            borderRadius: 12, padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
            zIndex: 10,
          }}
        >
          {pending > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 56, height: 34, borderRadius: 5, background: 'rgba(255,255,255,0.08)', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)' }}>
                <ImageGlyph />
              </div>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', flex: 1 }}>
                screenshot — attaches when you release
              </span>
            </div>
          )}
          {paths.map((p) => {
            const preview = previews.find((v) => v.path === p)?.dataUrl
            return (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {preview ? (
                  <img src={preview} alt="" style={{ width: 56, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid rgba(255,255,255,0.15)', flex: 'none' }} />
                ) : (
                  <div style={{ width: 56, height: 34, borderRadius: 5, background: 'rgba(255,255,255,0.08)', flex: 'none' }} />
                )}
                <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, maxWidth: 120 }}>
                  {p.split('/').pop()}
                </span>
                <button
                  title="Remove — won't be sent"
                  onClick={() => void stagedApi().remoteUnstageImage?.(p)}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 1, padding: '4px 6px', cursor: 'pointer', flex: 'none' }}
                >✕</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Per-SESSION raw toggle, shown next to the model badge during a Remote capture.
// RAW = no Unmute memory injection (a clean Claude Code session). Reflects the
// effective state (session override over the saved default); clicking sets a
// session-only override that resets on relaunch.
function rawApi() {
  return window.electronAPI as unknown as {
    remoteGetRawState?: () => Promise<{ effectiveRaw: boolean }>
    remoteSetSessionRaw?: (on: boolean | null) => Promise<boolean>
  }
}

function RawToggle() {
  const [raw, setRaw] = useState(false)
  useEffect(() => {
    void rawApi().remoteGetRawState?.().then((s) => { if (s) setRaw(!!s.effectiveRaw) })
  }, [])
  const toggle = () => {
    const next = !raw
    setRaw(next) // optimistic
    void rawApi().remoteSetSessionRaw?.(next)
  }
  return (
    <div style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center' }}>
      <button
        onClick={toggle}
        title={raw
          ? 'Raw mode ON — this Remote session runs with NO Unmute memory injection. Click to turn off.'
          : 'Raw mode OFF — Unmute injects relevant memory. Click for a clean Claude Code session.'}
        style={{
          height: 44,
          borderRadius: 9999,
          background: '#000',
          border: '1px solid rgba(255, 255, 255, 0.55)',
          // Match the shadowless pill (see RemoteBadge note above).
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          gap: 6,
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
          color: raw ? CLAUDE_ORANGE : 'rgba(255,255,255,0.45)',
          transition: 'color 140ms ease',
        }}
      >
        <span
          style={{
            width: 7, height: 7, borderRadius: 9999,
            background: raw ? CLAUDE_ORANGE : 'rgba(255,255,255,0.28)',
            boxShadow: raw ? `0 0 8px ${CLAUDE_ORANGE}` : 'none',
            transition: 'background 140ms ease, box-shadow 140ms ease',
          }}
        />
        RAW
      </button>
    </div>
  )
}

// ── Mic source: iPhone tap-to-switch ─────────────────────────────────────
// The iPhone (Continuity Camera mic — zero-install, a normal macOS input
// device) as an opt-in capture source. Design rules (settled, do not drift):
// MacBook mic is ALWAYS the default; we NEVER prompt/nudge/surface the
// feature — the glyph chip below is the entire UI, and it only exists while
// a phone mic is actually around. One tap flips the source; the choice is
// sticky (localStorage, survives restarts) and applies from the NEXT
// dictation — sources are never swapped mid-recording. Phone absent →
// silent resolution to the Mac mic; phone back → the user's last explicit
// choice is honored again.
const MIC_SOURCE_KEY = 'unmute.micSourcePreference'

function loadMicPreference(): MicSource {
  try {
    return localStorage.getItem(MIC_SOURCE_KEY) === 'iphone' ? 'iphone' : 'mac'
  } catch {
    return 'mac'
  }
}

function useMicSource() {
  const [preference, setPreference] = useState<MicSource>(loadMicPreference)
  const [devices, setDevices] = useState<AudioInputDeviceInfo[]>([])
  // Refs so the once-registered recording:start listener resolves against
  // CURRENT state, not the state captured when the listener mounted.
  const preferenceRef = useRef(preference)
  const devicesRef = useRef(devices)
  preferenceRef.current = preference
  devicesRef.current = devices

  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((list) =>
        setDevices(
          list.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }))
        )
      )
      .catch(() => { /* device list is best-effort — absence just means Mac mic */ })
  }, [])

  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () =>
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  const toggle = useCallback(() => {
    setPreference((prev) => {
      const next: MicSource = prev === 'iphone' ? 'mac' : 'iphone'
      try { localStorage.setItem(MIC_SOURCE_KEY, next) } catch { /* still applies this session */ }
      return next
    })
  }, [])

  // Per-recording resolution — called at capture start by the hotkey path.
  const resolveDeviceId = useCallback(
    () => resolveCaptureDeviceId(preferenceRef.current, devicesRef.current),
    []
  )

  // ── Session-mode keep-warm lifecycle ────────────────────────────────────
  // The glyph is a CONNECT/DISCONNECT switch now: iPhone selected + phone
  // present → hold the pipe open (one-time "connecting" beat, then every
  // dictation is instant); Mac selected → let it go. Auto-reconnect when the
  // phone returns while iPhone is still the preference — restoring the
  // user's explicit choice, not initiating anything.
  const [warm, setWarm] = useState<WarmState>(warmState())
  useEffect(() => onWarmState(setWarm), [])

  // Feature gate (Settings → "iPhone microphone", OFF by default): until the
  // user enables it, the chip never renders, no warm connection is ever made,
  // and capture always resolves to the Mac mic — the feature is invisible.
  const [featureEnabled, setFeatureEnabled] = useState(false)
  const featureEnabledRef = useRef(false)
  featureEnabledRef.current = featureEnabled
  useEffect(() => {
    const api = window.electronAPI as unknown as {
      getIphoneMicEnabled?: () => Promise<boolean>
      onIphoneMicChanged?: (cb: (on: boolean) => void) => void
    }
    api.getIphoneMicEnabled?.().then((on) => setFeatureEnabled(!!on)).catch(() => {})
    api.onIphoneMicChanged?.((on) => setFeatureEnabled(!!on))
  }, [])

  useEffect(() => {
    if (!featureEnabled) {
      if (warmState() !== 'off') disconnectWarmMic('feature-disabled')
      return
    }
    const phone = findIphoneMic(devices)
    if (preference === 'iphone' && phone && warmState() === 'off') {
      void connectWarmMic(phone.deviceId)
    } else if (preference === 'mac' && warmState() !== 'off') {
      disconnectWarmMic('user-selected-mac')
    }
  }, [preference, devices, featureEnabled])

  return { preference, devices, warm, featureEnabled, toggle, resolveDeviceId: useCallback(
    () => (featureEnabledRef.current ? resolveDeviceId() : undefined),
    [resolveDeviceId]
  ), refreshDevices }
}

function LaptopGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </svg>
  )
}

function PhoneGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  )
}

// Live capture-coaching chip. Same visual family as the pill and the badges:
// dark glass, hairline border, full radius. The accent dot + icon carry the
// state; the copy is two-tier (bold condition, dim remedy) so it reads in one
// glance without shouting. Fades/slides in beside the pill; never a toast,
// never a resize.
function HintChip({ accent, label, detail, icon }: { accent: string; label: string; detail: string; icon: 'waves' | 'mic' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 14px 0 11px',
        background: 'rgba(0, 0, 0, 0.96)',
        border: '1px solid rgba(255, 255, 255, 0.13)',
        borderRadius: 9999,
        // No drop shadow — like every other chip in the row. Unmute occupies
        // only the widget; a shadow here bled outside it (glass blur stays put).
        boxShadow: 'none',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        whiteSpace: 'nowrap',
        animation: 'hint-chip-in 260ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
      }}
    >
      <span aria-hidden style={{ display: 'flex', alignItems: 'center', color: accent }}>
        {icon === 'waves' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M3 12h2M8 7v10M13 4v16M18 8v8M22 11v2" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        )}
      </span>
      <span style={{ fontSize: 12, lineHeight: 1 }}>
        <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.94)' }}>{label}</span>
        {detail && <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.55)' }}> — {detail}</span>}
      </span>
      <style>{`@keyframes hint-chip-in { from { opacity: 0; transform: translateX(8px) scale(0.97) } to { opacity: 1; transform: none } }`}</style>
    </div>
  )
}

// The source glyph chip. Same family as the model badge / RAW toggle: dark
// fill, whitish border, no shadow. Laptop = MacBook mic, phone = iPhone mic
// (orange, like other "non-default state" accents). A tap toggles — and in
// session mode the toggle IS connect/disconnect: while the warm pipe is
// establishing, the phone glyph pulses ("connecting…"); steady orange means
// connected — every dictation from here is instant.
function MicSourceChip({ source, warm, onTap }: { source: MicSource; warm: WarmState; onTap: () => void }) {
  return (
    <div style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center' }}>
      <button
        onClick={onTap}
        style={{
          height: 44,
          width: 44,
          borderRadius: 9999,
          background: '#000',
          border: '1px solid rgba(255, 255, 255, 0.55)',
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: source === 'iphone' ? CLAUDE_ORANGE : 'rgba(255,255,255,0.85)',
          transition: 'color 140ms ease',
          animation: warm === 'connecting' ? 'mic-connecting 900ms ease-in-out infinite' : 'none',
        }}
        title={
          warm === 'connecting' ? 'Connecting your iPhone microphone…'
            : warm === 'connected' ? 'iPhone mic connected — dictations are instant. Tap to disconnect.'
              : source === 'iphone' ? 'Capturing from your iPhone microphone. Tap to use the MacBook mic.'
                : 'Capturing from the MacBook microphone. Tap to connect your iPhone mic.'
        }
      >
        {source === 'iphone' ? <PhoneGlyph /> : <LaptopGlyph />}
        <style>{`@keyframes mic-connecting { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
      </button>
    </div>
  )
}

export default function WidgetApp() {
  const [state, setState] = useState<WidgetState>('hidden')
  const [outputPreview, setOutputPreview] = useState('')
  const [fallbackMessage, setFallbackMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [showDiscardHint, setShowDiscardHint] = useState(false)
  const [engineNotice, setEngineNotice] = useState<string | null>(null)
  const [draftOffer, setDraftOffer] = useState(false)
  const [mutedText, setMutedText] = useState<string | null>(null)
  const [offlineReason, setOfflineReason] = useState<OfflineReason | null>(null)
  const [dismissedTick, setDismissedTick] = useState(0)
  // Is the CURRENT capture a Remote one (dispatches a task) vs a dictation
  // (types text)? Drives the Remote badge next to the pill. Set on every
  // recording:start from its kind, so it's always fresh for this capture.
  const [isRemote, setIsRemote] = useState(false)
  // Is the CURRENT capture the AI FORMATTER (Caps Lock) rather than plain
  // dictation (Fn)? Latched at recording:start like isRemote, because `state`
  // only says 'instruction-active' while the mic is open — by `processing` the
  // distinction is gone, and the pill must keep its identity for the whole
  // capture rather than reverting halfway through.
  const [isInstruction, setIsInstruction] = useState(false)
  // Backend picker for Remote captures. Refreshed when a Remote capture STARTS
  // rather than polled: availability changes rarely (Codex opened/closed), and
  // the answer is only ever needed at the moment the pill appears.
  const [agentPicker, setAgentPicker] = useState<{ current: string; options: Array<{ id: string; label: string; available: boolean }> } | null>(null)
  const stateRef = useRef<WidgetState>('hidden')

  const { analyserNode, maxDurationSeconds, noisyEnvironment, tooQuiet, startRecording, stopRecording } = useAudioRecorder()
  const mic = useMicSource()

  // ── Mic-status narration (text, per the settled position: chip colors are
  // ambience, WORDS are communication). One line per transition, shown in the
  // HintChip family beside the pill, auto-dismissed. Also tracks the mic that
  // ACTUALLY captured the current recording, so the glyph shows fact, not
  // aspiration. ──
  const [micStatus, setMicStatus] = useState<string | null>(null)
  const [captureSource, setCaptureSource] = useState<'iphone' | 'mac' | null>(null)
  const micStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onStatus = (e: Event) => {
      const d = (e as CustomEvent<{ text: string | null; source?: 'iphone' | 'mac' }>).detail
      if (d.source) setCaptureSource(d.source)
      if (d.text) {
        setMicStatus(d.text)
        if (micStatusTimer.current) clearTimeout(micStatusTimer.current)
        micStatusTimer.current = setTimeout(() => setMicStatus(null), 4000)
      }
    }
    window.addEventListener('unmute:mic-status', onStatus)
    return () => {
      window.removeEventListener('unmute:mic-status', onStatus)
      if (micStatusTimer.current) clearTimeout(micStatusTimer.current)
    }
  }, [])

  const autoHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // ── UX-journey log ([widget:ux]) ─────────────────────────────────────────
  // One line per state transition describing EXACTLY what the user sees at
  // that moment: which elements are on screen and why. When 'the pill is
  // gone' or 'it started by itself' happens again, this trail is the answer.
  const prevUxRef = useRef<string>('')
  useEffect(() => {
    const pillVisible = state === 'dictation-active' || state === 'instruction-active' || state === 'processing'
    const phonePresent = findIphoneMic(mic.devices) !== null
    const chipVisible = pillVisible && mic.featureEnabled && phonePresent
    const snapshot = JSON.stringify({
      state,
      sees: {
        pill: pillVisible ? (state === 'processing' ? 'processing' : 'recording') : (state === 'hidden' ? 'nothing' : state),
        micChip: chipVisible ? `${effectiveSource(mic.preference, mic.devices)} (${mic.warm})` : 'hidden',
        remoteBadge: isRemote && pillVisible,
      },
      why: { featureEnabled: mic.featureEnabled, phonePresent, warm: mic.warm, isRemote },
    })
    if (snapshot !== prevUxRef.current) {
      prevUxRef.current = snapshot
      console.log(`[widget:ux] ${snapshot}`)
    }
  }, [state, mic.devices, mic.featureEnabled, mic.preference, mic.warm, isRemote])

  // The HUD window is click-through by default (so the empty area around the
  // pill never blocks the apps behind it). Hit-test the cursor on every move and
  // flip the window interactive ONLY while it's over actual content (anything
  // that isn't the bare transparent root). Change-tracked so we don't spam IPC.
  useEffect(() => {
    const hud = window.electronAPI as unknown as { hudSetInteractive?: (on: boolean) => void }
    let last = false
    const onMove = (e: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const interactive = !!el && el !== root && root.contains(el)
      if (interactive !== last) { last = interactive; hud.hudSetInteractive?.(interactive) }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  stateRef.current = state

  const clearAutoHide = useCallback(() => {
    if (autoHideRef.current) {
      clearTimeout(autoHideRef.current)
      autoHideRef.current = null
    }
  }, [])

  const scheduleAutoHide = useCallback((delayMs: number) => {
    clearAutoHide()
    autoHideRef.current = setTimeout(() => {
      autoHideRef.current = null
      setState('hidden')
    }, delayMs)
  }, [clearAutoHide])

  useEffect(() => {
    document.body.classList.add('widget-body')
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.classList.remove('widget-body')
    }
  }, [])

  // Keep the Remote badge coupled to the pill. The badge and the pill are two
  // separate elements gated by different conditions (badge: isRemote; pill:
  // state), so a latched isRemote could let the badge appear/linger without the
  // pill. The moment the pill leaves an ACTIVE state (→ output/hidden/error/…),
  // drop isRemote so the badge can never outlive the pill. A new Remote capture
  // re-sets isRemote via remoteOnCaptureKind on the next recording:start.
  useEffect(() => {
    const active =
      state === 'dictation-active' ||
      state === 'instruction-active' ||
      state === 'processing'
    if (!active) { setIsRemote(false); setIsInstruction(false) }
  }, [state])

  // ─── Peek the current engine each time a dictation starts ───
  // We don't block the recording on this; we just enrich the awareness
  // card asynchronously. Clearing offlineReason on 'hidden' makes the
  // card auto-dismiss when the pill goes away.
  useEffect(() => {
    const isActive =
      state === 'dictation-active' ||
      state === 'instruction-active' ||
      state === 'processing'
    if (!isActive) {
      setOfflineReason(null)
      return
    }
    // Already populated mid-session? Don't re-peek (avoids flicker when
    // moving from active → processing).
    if (offlineReason !== null) return
    window.electronAPI.paywallEnginePeekStatus?.().then((r) => {
      if (r && r.provider === 'local' && r.reason) {
        setOfflineReason(r.reason as OfflineReason)
      }
    }).catch(() => { /* ignore */ })
  }, [state, offlineReason])

  // ─── Listen for runtime fallback (managed → local mid-call) ───
  useEffect(() => {
    window.electronAPI.paywallOnEngineFellBack?.((info) => {
      setOfflineReason(info.reason)
    })
  }, [])

  useEffect(() => {
    const api = window.electronAPI

    api.getSoundFeedback().then((enabled: boolean) => {
      soundEnabled = enabled
    }).catch(() => { /* default true */ })

    // Additive Remote-kind listener (also fires on recording:start, reading its
    // 4th arg). Tells us whether this capture is Remote so the pill can badge it.
    const remoteApi = api as unknown as {
      remoteOnCaptureKind?: (cb: (kind: 'dictation' | 'remote') => void) => void
      remoteAgentOptions?: () => Promise<{ current: string; options: Array<{ id: string; label: string; available: boolean }> }>
    }
    // Warm the picker at mount. The capture-start refresh below keeps it honest,
    // but this guarantees the chip has data the first time a Remote capture
    // opens, instead of depending on one event arriving before first paint.
    void remoteApi.remoteAgentOptions?.()
      .then((o) => { if (o) setAgentPicker(o) })
      .catch(() => {})
    remoteApi.remoteOnCaptureKind?.((kind) => {
      const remote = kind === 'remote'
      setIsRemote(remote)
      // Only Remote captures dispatch a task, so only they need the picker.
      // Refresh on every start: whether Codex can take work is live state, and
      // a stale "Codex" chip would offer a backend that has since gone away.
      if (!remote) { setAgentPicker(null); return }
      void remoteApi.remoteAgentOptions?.()
        .then((o) => setAgentPicker(o ?? null))
        .catch(() => setAgentPicker(null))
    })

    // Zombie phone detected by the recorder (acquirable device, dead pipe):
    // re-enumerate so the chip stops advertising a corpse and flips back to
    // the laptop glyph as soon as macOS drops the stale entry.
    const onZombie = () => mic.refreshDevices()
    window.addEventListener('unmute:phone-mic-zombie', onZombie)

    api.onRecordingStart(async (mode, sessionId) => {
      console.log(`[widget:ux] EVENT recording:start mode=${mode} session=${sessionId ?? 'none'} (state was ${stateRef.current})`)
      clearAutoHide()
      // Resolve the capture device for THIS recording: the iPhone mic when
      // the user opted in and the phone is around, otherwise the system
      // default. The recorder itself retries on the default device if the
      // resolved one vanished in the meantime — a missing phone can never
      // error a dictation.
      const resolvedDeviceId = mic.resolveDeviceId()
      // HONEST START-CLICK: the click is the user's "mic is live, speak now"
      // cue. On the Mac mic that's true immediately (~100ms), so click now —
      // unchanged behavior. The Continuity phone mic takes 300ms-1s to open;
      // clicking early is what ate opening words (and fed Whisper clipped
      // heads it hallucinated over). Phone path: click when the mic is OPEN.
      if (!resolvedDeviceId) playClickSound('start')
      setEngineNotice(null)
      setDraftOffer(false)
      setMutedText(null)
      setIsInstruction(mode !== 'dictation')
      setState(mode === 'dictation' ? 'dictation-active' : 'instruction-active')
      try {
        await startRecording(resolvedDeviceId, mode, sessionId)
        if (resolvedDeviceId) playClickSound('start') // phone mic is live NOW
        // Labels are permission-gated: before the first capture the device
        // list may carry empty labels (iPhone undetectable). Now that a
        // capture is live, re-enumerate so the glyph chip reflects reality.
        mic.refreshDevices()
      } catch {
        setErrorMessage('Mic error. Check settings.')
        setState('error')
        scheduleAutoHide(3000)
      }
    })

    api.onRecordingStop(async () => {
      console.log(`[widget:ux] EVENT recording:stop (state was ${stateRef.current})`)
      setState('processing')
      setShowDiscardHint(false)
      await stopRecording()
    })

    api.onOutputReady(() => {
      console.log(`[widget:ux] EVENT output:ready (state was ${stateRef.current})`)
      playClickSound('stop')
      setState('output')
      setShowDiscardHint(false)
      scheduleAutoHide(1200)
    })

    api.onOutputFallback((text, _sessionId, message) => {
      playClickSound('stop')
      const preview = text.length > 50 ? text.slice(0, 50) + '...' : text
      setOutputPreview(preview)
      setFallbackMessage(message || 'Formatting unavailable — pasted raw')
      setState('output-fallback')
      setShowDiscardHint(false)
      scheduleAutoHide(4000)
    })

    api.onOutputError((error) => {
      playClickSound('stop')
      setErrorMessage(error)
      setState('error')
      setShowDiscardHint(false)
      scheduleAutoHide(5000)
    })

    api.onSessionCancelled(() => {
      console.log(`[widget:ux] EVENT session:cancelled (state was ${stateRef.current})`)
      setState('cancelled')
      setShowDiscardHint(false)
      // THE ONLY TERMINAL STATE THAT NEVER SCHEDULED ITS OWN DISMISSAL.
      // error gets 5000, too-short 2500, output 3000 — cancelled got nothing,
      // and got away with it because the HUD window was hidden out from under
      // it by main. The native pill is a separate window with no such rescue,
      // so a cancelled capture left its pill on screen forever. Same 2500 as
      // the rest of the family, and the Undo lives for exactly that long.
      scheduleAutoHide(2500)
    })

    api.onProcessingDiscardHint(() => {
      setShowDiscardHint(true)
    })

    api.onSessionTooShort(() => {
      console.log(`[widget:ux] EVENT session:too-short (state was ${stateRef.current})`)
      setState('too-short')
      setShowDiscardHint(false)
      // THE SIBLING OF THE `cancelled` BUG. Both "nothing happened" states
      // relied on main hiding the HUD window out from under them; the native
      // pill is its own window with no such rescue, so "Didn't catch that" sat
      // on screen forever. I fixed cancelled and did not check the handler
      // directly beneath it.
      scheduleAutoHide(2500)
    })

    api.onEngineNotice((reason) => {
      setEngineNotice(reason)
    })

    // Draft-offer lifecycle: cloud STT is slow but a local quick draft is
    // ready. The pill grows a one-tap "use quick draft" affordance; it
    // retracts when either side resolves the session.
    const draftApi = api as unknown as {
      paywallOnDraftOffer?: (cb: () => void) => void
      paywallOnDraftResolved?: (cb: (how: string) => void) => void
    }
    draftApi.paywallOnDraftOffer?.(() => setDraftOffer(true))
    draftApi.paywallOnDraftResolved?.(() => setDraftOffer(false))

    // Quiet-capture gate: faint audio + tiny transcript — the paste was
    // suppressed rather than injecting Whisper fiction. Reuse the
    // 'too-short' pill with a more specific message.
    const quietApi = api as unknown as { paywallOnQuietMiss?: (cb: () => void) => void }
    quietApi.paywallOnQuietMiss?.(() => {
      setMutedText('Mic was too quiet — didn\'t catch that')
      setState('too-short')
      scheduleAutoHide(2500)
    })

    api.widgetReady()

    return () => {
      window.removeEventListener('unmute:phone-mic-zombie', onZombie)
      api.removeAllListeners('recording:start')
      api.removeAllListeners('recording:stop')
      api.removeAllListeners('output:ready')
      api.removeAllListeners('output:fallback')
      api.removeAllListeners('output:error')
      api.removeAllListeners('session:cancelled')
      api.removeAllListeners('processing:show-discard-hint')
      api.removeAllListeners('session:too-short')
      api.removeAllListeners('session:engine-notice')
      api.removeAllListeners('session:draft-offer')
      api.removeAllListeners('session:draft-resolved')
      api.removeAllListeners('session:quiet-miss')
    }
  }, [startRecording, stopRecording, clearAutoHide, scheduleAutoHide, mic.resolveDeviceId, mic.refreshDevices])

  const handleCancel = useCallback(async () => {
    await stopRecording()
    window.electronAPI.cancelSession()
    setState('hidden')
  }, [stopRecording])

  const handleStop = useCallback(async () => {
    setState('processing')
    await stopRecording()
  }, [stopRecording])

  /** Switch the backend the NEXT task runs on. No task exists yet — the user is
   *  mid-utterance — so this only persists the default that dispatch reads when
   *  the utterance is submitted. Optimistic locally so the chip flips instantly. */
  const handlePickAgent = useCallback((id: string) => {
    setAgentPicker((prev) => (prev ? { ...prev, current: id } : prev))
    const api = (window as any).electronAPI as {
      remoteSetAgent?: (a: string) => Promise<boolean>
      remoteCodexConnect?: () => Promise<{ ok: boolean }>
      remoteAgentOptions?: () => Promise<any>
    } | undefined
    void api?.remoteSetAgent?.(id)
    // If the chosen backend is installed but not connected, connect it now. This
    // is the only place the arming relaunch is triggered — always a deliberate
    // user tap, never mid-utterance on our own initiative.
    setAgentPicker((prev) => {
      const opt = prev?.options.find((o) => o.id === id)
      if (prev && opt && !opt.available && id === 'codex-desktop') {
        void api?.remoteCodexConnect?.()
          .then(() => api?.remoteAgentOptions?.())
          .then((fresh) => { if (fresh) setAgentPicker(fresh) })
          .catch(() => {})
      }
      return prev
    })
  }, [])

  const handleUndo = useCallback(() => {
    setState('processing')
    window.electronAPI.undoCancel()
  }, [])

  const handleAcceptDraft = useCallback(() => {
    setDraftOffer(false)
    const api = window.electronAPI as unknown as { paywallAcceptDraft?: () => void }
    api.paywallAcceptDraft?.()
  }, [])

  // ── The native input surface ──
  //
  // When the Swift helper is drawing the pill, this renderer stops drawing one
  // and becomes a pure source of state + a sink for gestures. It keeps the
  // audio, the recorder, the mic devices and the VAD — everything that must not
  // move — and its window stays exactly as it was, so nothing about the capture
  // path's lifecycle or throttling changes.
  const nativePill = nativePillActive()
  const recordingNow =
    state === 'dictation-active' || state === 'instruction-active' || state === 'chained'
  const startedAt = useRef(0)
  useEffect(() => { if (recordingNow && !startedAt.current) startedAt.current = Date.now() }, [recordingNow])
  useEffect(() => { if (!recordingNow) startedAt.current = 0 }, [recordingNow])
  const elapsedSec = useCallback(
    () => (startedAt.current ? Math.floor((Date.now() - startedAt.current) / 1000) : 0),
    [],
  )

  // NOTE: the model and agent chips are NOT pushed from here. Main already owns
  // the settings and the config-driven catalog, and PillController merges
  // partial pushes — so it supplies them directly rather than this renderer
  // keeping a second copy that could disagree.
  const pillState = useMemo(() => ({
    phase: toPhase(state),
    kind: isRemote ? 'remote' : isInstruction ? 'instruction' : 'dictation',
    maxSeconds: maxDurationSeconds,
    // Each state's own copy, kept distinct — the first build funnelled all of
    // these through one `message` and lost the differences.
    message: errorMessage || undefined,
    fallbackMessage: fallbackMessage || undefined,
    outputPreview: outputPreview || undefined,
    mutedText: mutedText || undefined,
    draftOffer,
    engineNotice: !!engineNotice,
    showDiscardHint,
    // THE MIC CHIP. It was simply never pushed, so it could never render.
    // Same rule as the original: the chip exists ONLY while an iPhone mic is
    // actually around — no phone, no chip, no greyed-out icon begging for
    // attention. And it shows what is ACTUALLY capturing during a recording,
    // not what is merely preferred.
    mic: recordingNow && captureSource
      ? captureSource
      : effectiveSource(mic.preference, mic.devices),
    micOptions: mic.featureEnabled && findIphoneMic(mic.devices) !== null
      ? [
          { id: 'mac', label: 'MacBook Microphone' },
          { id: 'iphone', label: findIphoneMic(mic.devices)?.label || 'iPhone' },
        ]
      : undefined,
    // MIC NARRATION — the line that was missing entirely, so the user had no
    // way to know a source switch had been deferred to the next dictation.
    // It already auto-clears after 4s via micStatusTimer, so the surface
    // inherits that lifetime for free.
    micStatus: micStatus || null,
    // Coaching is SECOND in precedence, and its level distinguishes the two so
    // each keeps its own accent and glyph rather than collapsing to one warn
    // colour. "noise wins: it's the condition the user can't hear themselves."
    coaching: recordingNow && noisyEnvironment
      ? { condition: 'Noisy spot', remedy: captureSource === 'iphone' ? 'speak up' : 'lean in & speak up', level: 'noisy' as const }
      : recordingNow && tooQuiet
        ? { condition: 'Too quiet', remedy: captureSource === 'iphone' ? 'speak up a little' : 'bring the mic closer', level: 'quiet' as const }
        : null,
    // The awareness card's own visibility rule, evaluated here rather than
    // recomputed on the Swift side: offlineReason is only meaningful while the
    // pill is up and the user hasn't dismissed it this session.
    offline: (recordingNow || state === 'processing') && offlineReason !== null && !sessionDismissed
      ? offlineReason
      : null,
  }), [state, draftOffer, isRemote, maxDurationSeconds, errorMessage, fallbackMessage,
       outputPreview, mutedText, engineNotice, showDiscardHint,
       recordingNow, noisyEnvironment, tooQuiet, captureSource, offlineReason,
       dismissedTick, mic.preference, mic.devices, mic.featureEnabled, micStatus])

  usePillState(pillState, nativePill)
  usePillTicker(recordingNow, elapsedSec, nativePill)
  usePillEvents({
    stop: () => { void handleStop() },
    cancel: () => { void handleCancel() },
    undo: handleUndo,
    acceptDraft: handleAcceptDraft,
    // The mic chip has always been a one-tap flip between the Mac and the
    // phone, never a picker — keep that exactly.
    pickMic: () => mic.toggle(),
    // Session-scoped override, same call the DOM toggle makes.
    toggleRaw: (v) => { void rawApi().remoteSetSessionRaw?.(v === true) },
    dismissOffline: () => { sessionDismissed = true; setDismissedTick((t) => t + 1) },
    openBillingPortal: () => {
      void portalApi().paywallOpenPortal?.().then((r) => {
        if (r?.ok && r.portalUrl) void portalApi().paywallOpenExternal?.(r.portalUrl)
      })
    },
  }, nativePill)

  const handleAwarenessDismiss = useCallback(() => {
    sessionDismissed = true
    setDismissedTick((n) => n + 1)
  }, [])

  // Card visibility: pill is showing AND we know we're on local AND user
  // hasn't × it this session AND the pill state isn't terminal (output/
  // error/cancelled — at those points the pill is collapsing anyway).
  const pillShowing =
    state === 'dictation-active' ||
    state === 'instruction-active' ||
    state === 'processing'
  const showAwareness =
    pillShowing && offlineReason !== null && !sessionDismissed
  // `dismissedTick` is read here just to trigger re-render on dismiss
  void dismissedTick

  // THE NATIVE SURFACE DRAWS THE PILL — this renderer draws nothing.
  //
  // The window itself is untouched: same size, same position, same lifecycle,
  // so nothing about background throttling or the audio graph changes. Only the
  // pixels move. Every hook above still runs, which is the point — this
  // renderer remains the source of capture state and the sink for gestures.
  if (nativePill) return <div ref={rootRef} style={{ background: 'transparent' }} />

  return (
    <div
      ref={rootRef}
      className="w-full h-full flex flex-col items-center"
      // scale(0.75): the pill family shrunk wholesale (field feedback
      // 2026-07-24 — 0.62 proved too small; 0.75 is the settled size). One
      // transform keeps every element/gap in proportion; hit-testing follows
      // the scaled rects automatically. Label/timer fonts are bumped in
      // Widget.tsx so the text stays legible at this scale.
      // paddingTop absorbs the window's upward growth (see --hud-extra in
      // RemoteBadge) so the pill row does not move when a list opens above it.
      style={{
        background: 'transparent',
        paddingTop: 'calc(8px + var(--hud-extra, 0px))',
        transform: 'scale(0.75)',
        transformOrigin: 'top center',
      }}
    >
      {/* Remote capture → circular badge to the LEFT of the pill, with a gap.
          Dictation → pill only. */}
      <div className="flex items-center justify-center" style={{ gap: '16px' }}>
        {isRemote && pillShowing && <RemoteBadge picker={agentPicker} onPickAgent={handlePickAgent} />}
        {isRemote && pillShowing && <RawToggle />}
        {/* the screenshot ledger shows for BOTH capture kinds — dictation pastes
            the images into the target app after the text; Remote attaches them
            to the task. Self-hides at zero. */}
        {/* Live capture coaching — a signal, not a fix. One chip at a time
            (noise wins: it's the condition the user can't hear themselves).
            Pill-family styling: dark glass, hairline border, SVG icon with a
            state accent — reads as part of the instrument, not a toast. */}
        {micStatus && state !== 'hidden' && (
          <HintChip accent="#f97316" label={micStatus.includes(' — ') ? micStatus.split(' — ')[0] : micStatus} detail={micStatus.includes(' — ') ? micStatus.split(' — ').slice(1).join(' — ') : ''} icon="mic" />
        )}
        {/* Coaching copy is SOURCE-AWARE: "lean in" is Mac advice (move toward
            the machine); a phone is already at the mouth — there, the only
            useful remedy is volume. */}
        {(state === 'dictation-active' || state === 'instruction-active') && !micStatus && noisyEnvironment && (
          <HintChip accent="#fbbf24" label="Noisy spot" detail={captureSource === 'iphone' ? 'speak up' : 'lean in & speak up'} icon="waves" />
        )}
        {(state === 'dictation-active' || state === 'instruction-active') && !micStatus && !noisyEnvironment && tooQuiet && (
          <HintChip accent="#38bdf8" label="Too quiet" detail={captureSource === 'iphone' ? 'speak up a little' : 'bring the mic closer'} icon="mic" />
        )}
        {pillShowing && <StagedImagesChip />}
        {/* mic-source glyph: exists ONLY while an iPhone mic is actually
            around — no phone, no chip, no greyed-out icon begging attention.
            Laptop vs phone tells the truth about what's listening; a tap
            flips the (sticky) choice for the next dictation. */}
        {pillShowing && mic.featureEnabled && findIphoneMic(mic.devices) !== null && (
          <MicSourceChip
            source={(state === 'dictation-active' || state === 'instruction-active') && captureSource
              ? captureSource
              : effectiveSource(mic.preference, mic.devices)}
            warm={mic.warm}
            onTap={mic.toggle}
          />
        )}
        <Widget
          state={state}
          analyserNode={analyserNode}
          maxDurationSeconds={maxDurationSeconds}
          outputPreview={outputPreview}
          fallbackMessage={fallbackMessage}
          errorMessage={errorMessage}
          showDiscardHint={showDiscardHint}
          engineNotice={engineNotice}
          draftOffer={draftOffer}
          mutedText={mutedText}
          onAcceptDraft={handleAcceptDraft}
          onCancel={handleCancel}
          onStop={handleStop}
          onUndo={handleUndo}
          agentPicker={agentPicker ?? undefined}
          isRemote={isRemote}
          onPickAgent={handlePickAgent}
        />
      </div>
      {showAwareness && (
        <OfflineAwarenessCard
          reason={offlineReason}
          onDismiss={handleAwarenessDismiss}
        />
      )}
    </div>
  )
}
