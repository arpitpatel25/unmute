// Unmute Remote — settings panel (PRD §2.4.5, §10.1, §10.6, §11).
//
// Lives in the Remote tab. Exposes the user-facing knobs whose IPC already
// exists in remote/init.ts: permission mode (auto-approve), executor agent
// (claude/codex), and the path sandbox roots. Credentials are NEVER here
// (PRD §12.1) — MCP setup is done in the user's own Claude Code.

import { useEffect, useState } from 'react'
import { ComputerUseSettings } from './ComputerUseSettings'

interface Settings {
  permissionMode: 'prompt' | 'auto-approve'
  remoteKey: 'fn' | 'right-option'
  /** 'codex' is the legacy CLI adapter, kept only so a stored value still
   *  parses; it is migrated to 'claude' at startup and never offered. */
  agent: 'claude' | 'codex' | 'codex-desktop'
  sandboxRoots: string[]
  model: string
  browserEnabled: boolean
  overlayAutoPresent: boolean
  overlayDocked: boolean
  osNotifications: boolean
  forceRawMode: boolean
  /** Capture during dictation — copies AND screenshots, not images alone. The
   *  key predates text capture; main reads it from `captureEnabled`. */
  screenshotCapture: boolean
  agentTasksEnabled?: boolean
  logFile: string | null
}
interface ModelChoice { id: string; label: string; description?: string }
// Fallback if the catalog IPC is unavailable (older main) — the classic tiers.
const FALLBACK_CATALOG: ModelChoice[] = [
  { id: 'haiku', label: 'Haiku', description: 'Fastest — best for simple, quick tasks.' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced speed and capability. Great default.' },
  { id: 'opus', label: 'Opus', description: 'Most capable — best for hard, multi-step tasks.' },
]
type API = {
  remoteGetSettings?: () => Promise<Settings>
  remoteSetPermissionMode?: (m: 'prompt' | 'auto-approve') => Promise<boolean>
  remoteSetAgent?: (a: 'claude' | 'codex-desktop') => Promise<boolean>
  remoteSetSandboxRoots?: (r: string[]) => Promise<boolean>
  remoteSetBrowserEnabled?: (enabled: boolean) => Promise<boolean>
  remoteSetModel?: (m: string) => Promise<string>
  remoteGetModelCatalog?: () => Promise<ModelChoice[]>
  remoteOnModelChanged?: (cb: (model: string) => void) => () => void
  remoteSetOverlayAutoPresent?: (on: boolean) => Promise<boolean>
  remoteSetOverlayDocked?: (on: boolean) => Promise<boolean>
  remoteSetOsNotifications?: (on: boolean) => Promise<boolean>
  remoteSetForceRaw?: (on: boolean) => Promise<boolean>
  remoteSetScreenshotCapture?: (on: boolean) => Promise<boolean>
  remoteGetMemoryUsage?: () => Promise<MemoryUsage>
  remoteCleanupMemory?: () => Promise<CleanupResult | null>
  // Remote trigger gate (paywall layer): `locked` = the plan doesn't include
  // Remote; `enabled` = the key is live right now. Per app session, not saved.
  paywallGetRemoteTrigger?: () => Promise<RemoteTriggerState>
  paywallSetRemoteTriggerEnabled?: (enabled: boolean) => Promise<RemoteTriggerState>
  paywallOnRemoteTriggerChanged?: (cb: (s: RemoteTriggerState) => void) => () => void
}
interface RemoteTriggerState { enabled: boolean; locked: boolean }
interface MemoryUsage { bytes: number; recipeCount: number; skillCount: number }
interface CleanupResult { pruned: string[]; evicted: string[]; demoted: string[]; deduped: string[] }

// Soft, informational thresholds — NOT a limit. Past either, the UI gently
// suggests a cleanup; the user is always free to ignore it.
const SOFT_BYTES = 2 * 1024 * 1024
const SOFT_COUNT = 150
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

export function RemoteSettings() {
  const [s, setS] = useState<Settings | null>(null)
  const [newRoot, setNewRoot] = useState('')
  const [usage, setUsage] = useState<MemoryUsage | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [cleanupNote, setCleanupNote] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ModelChoice[]>(FALLBACK_CATALOG)
  // Locked until main says otherwise — never flash an unlocked switch at a
  // user whose plan doesn't include Remote.
  const [trigger, setTrigger] = useState<RemoteTriggerState>({ enabled: false, locked: true })

  const refreshUsage = () => void api().remoteGetMemoryUsage?.().then((u) => u && setUsage(u))

  useEffect(() => {
    void api().remoteGetSettings?.().then((v) => v && setS(v))
    // Config-driven model catalog (falls back to the classic tiers if absent).
    void api().remoteGetModelCatalog?.().then((c) => { if (c && c.length) setCatalog(c) })
    refreshUsage()
    void api().paywallGetRemoteTrigger?.().then((t) => t && setTrigger(t)).catch(() => {})
    // Stay in sync when the model is changed from the capture-widget badge.
    const off = api().remoteOnModelChanged?.((model) => setS((prev) => (prev ? { ...prev, model } : prev)))
    // …and when the trigger is toggled elsewhere (Settings tab) or the plan changes.
    const offTrigger = api().paywallOnRemoteTriggerChanged?.((t) => setTrigger(t))
    return () => { off?.(); offTrigger?.() }
  }, [])
  if (!s) return null

  const update = (patch: Partial<Settings>) => setS((prev) => (prev ? { ...prev, ...patch } : prev))

  const runCleanup = async () => {
    setCleaning(true); setCleanupNote(null)
    try {
      const r = await api().remoteCleanupMemory?.()
      const removed = (r?.evicted.length ?? 0) + (r?.pruned.length ?? 0) + (r?.deduped.length ?? 0)
      const demoted = r?.demoted.length ?? 0
      setCleanupNote(removed === 0 && demoted === 0 ? 'Nothing to clean — your memory is tidy.' : `Removed ${removed}, retired ${demoted}.`)
      refreshUsage()
    } finally { setCleaning(false) }
  }

  return (
    <div className="rounded-lg border border-black/10 p-3 mb-3 bg-cream-mid/40 text-[12px]">
      <div className="font-semibold text-ink mb-2">Remote settings</div>

      {/* The trigger itself — the master switch for Remote activation. Mirrors
          Settings → Your triggers; both read the same main-process gate. Locked
          (off, inert) without the Unmute plan; for Pro it's on at every launch
          and any off you set here lasts until you quit Unmute. */}
      <label className="flex items-center justify-between py-1.5 mb-1">
        <span>
          Remote trigger{' '}
          <span className="text-ink/40">
            ({s.remoteKey === 'fn' ? 'Function key' : 'Right-option'} — the key not used for
            dictation
            {trigger.locked
              ? '; part of the Unmute plan)'
              : trigger.enabled
                ? ')'
                : '; back on when you reopen Unmute)'}
          </span>
        </span>
        <input
          type="checkbox"
          checked={trigger.enabled}
          disabled={trigger.locked}
          title={trigger.locked ? 'Unmute Remote is part of the Unmute plan' : undefined}
          onChange={(e) => {
            const on = e.target.checked
            setTrigger((prev) => ({ ...prev, enabled: on })) // optimistic
            void api().paywallSetRemoteTriggerEnabled?.(on)
              .then((next) => next && setTrigger(next)) // main owns the plan gate
              .catch(() => {})
          }}
        />
      </label>

      {/* Doer model — Remote tasks run on this. Applies to the next task. */}
      <div className="py-1.5 border-t border-black/5">
        <div className="mb-1.5">Model <span className="text-ink/40">(Remote tasks — applies to the next one)</span></div>
        <div className="flex flex-wrap gap-1.5">
          {catalog.map((m) => (
            <button
              key={m.id}
              onClick={() => { update({ model: m.id }); void api().remoteSetModel?.(m.id) }}
              className={`px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${
                s.model === m.id
                  ? 'bg-[#D97757] text-white border-[#D97757]'
                  : 'bg-white text-ink/70 border-border hover:bg-cream-mid'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="mt-1 text-[10.5px] text-ink/40">
          {catalog.find((m) => m.id === s.model)?.description ?? s.model}
        </div>
      </div>

      {/* Permission mode (§10.1) */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Auto-approve actions <span className="text-ink/40">(frictionless; no per-action prompts)</span></span>
        <input
          type="checkbox"
          checked={s.permissionMode === 'auto-approve'}
          onChange={(e) => {
            const mode = e.target.checked ? 'auto-approve' : 'prompt'
            update({ permissionMode: mode })
            void api().remoteSetPermissionMode?.(mode)
          }}
        />
      </label>

      {/* The two overlay toggles that used to sit here (auto-present, dock) are
          gone on purpose: the floating overlay was retired when the notch became
          the attention surface (ede9966). Leaving switches that drive a window
          which is never created would be worse than not offering them — the IPC
          still exists for older builds, we simply no longer surface it. */}

      {/* macOS notifications — off by default (the overlay is the surface) */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>macOS notifications <span className="text-ink/40">(off — overlay replaces them; often dropped anyway)</span></span>
        <input
          type="checkbox"
          checked={s.osNotifications}
          onChange={(e) => {
            const on = e.target.checked
            update({ osNotifications: on })
            void api().remoteSetOsNotifications?.(on)
          }}
        />
      </label>

      {/* Agent-created tasks — the Unmute MCP master switch. Sessions may ADD
          tasks to the wall (with provenance + depth/rate guardrails), never
          touch existing work. Off = the intercom rejects all creations. */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Agent-created tasks <span className="text-ink/40">(let a running task spawn new tasks onto the wall — always labeled, rate-limited, never able to touch existing work)</span></span>
        <input
          type="checkbox"
          checked={s.agentTasksEnabled ?? true}
          onChange={(e) => {
            const on = e.target.checked
            update({ agentTasksEnabled: on })
            void (api() as { remoteSetAgentTasks?: (v: boolean) => Promise<boolean> }).remoteSetAgentTasks?.(on)
          }}
        />
      </label>

      {/* Raw mode — run Claude Code clean, with NO Unmute memory injection. The
          pill widget can flip this per-session; this is the saved default. */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Raw mode <span className="text-ink/40">(no Unmute memory injection — a clean Claude Code session; toggle per-session from the pill)</span></span>
        <input
          type="checkbox"
          checked={s.forceRawMode}
          onChange={(e) => {
            const on = e.target.checked
            update({ forceRawMode: on })
            void api().remoteSetForceRaw?.(on)
          }}
        />
      </label>

      {/* Browser lane — drives your real Chrome via the extension (DECIDED) */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Browser tasks <span className="text-ink/40">(drives your real Chrome via the extension)</span></span>
        <input
          type="checkbox"
          checked={s.browserEnabled}
          onChange={(e) => {
            const browserEnabled = e.target.checked
            update({ browserEnabled })
            void api().remoteSetBrowserEnabled?.(browserEnabled)
          }}
        />
      </label>

      {/* Computer Use — background macOS app control via the Accessibility API.
          Self-contained (owns its own IPC). Sits alongside the Browser lane:
          browser drives Chrome, this drives every other desktop app. */}
      <ComputerUseSettings />

      {/* Executor agent (§11) */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Executor</span>
        <select
          className="text-[12px] border border-black/15 rounded px-1 py-0.5 bg-white"
          // 'codex' is the UNWIRED CLI adapter; startup migrates a stored one
          // back to claude, so it is never offered. 'codex-desktop' is real and
          // has shipped since v1.4.8 — this control still said "coming soon" and
          // refused the selection, which is where users concluded Codex did not
          // exist. It also rendered blank for anyone already on codex-desktop,
          // and wrote 'claude' over their choice if they touched it.
          value={s.agent === 'codex' ? 'claude' : s.agent}
          onChange={(e) => {
            const agent = e.target.value as 'claude' | 'codex-desktop'
            update({ agent })
            void api().remoteSetAgent?.(agent)
          }}
        >
          <option value="claude">Claude Code</option>
          <option value="codex-desktop">Codex desktop</option>
        </select>
      </label>

      {/* Sandbox roots (§10.6) */}
      <div className="py-1.5 border-t border-black/5">
        <div className="mb-1">
          Sandbox <span className="text-ink/40">(empty = no fence; add folders to limit reach)</span>
        </div>
        {s.sandboxRoots.length === 0 && <div className="text-ink/40 italic mb-1">No sandbox — tasks can reach anywhere.</div>}
        {s.sandboxRoots.map((r) => (
          <div key={r} className="flex items-center gap-2 mb-1">
            <code className="flex-1 px-1 py-0.5 bg-black/5 rounded text-[11px] truncate">{r}</code>
            <button
              className="text-[11px] text-red-700"
              onClick={() => {
                const roots = s.sandboxRoots.filter((x) => x !== r)
                update({ sandboxRoots: roots })
                void api().remoteSetSandboxRoots?.(roots)
              }}
            >remove</button>
          </div>
        ))}
        <form
          className="flex gap-1 mt-1"
          onSubmit={(e) => {
            e.preventDefault()
            const r = newRoot.trim()
            if (!r) return
            const roots = [...s.sandboxRoots, r]
            update({ sandboxRoots: roots })
            void api().remoteSetSandboxRoots?.(roots)
            setNewRoot('')
          }}
        >
          <input
            className="flex-1 text-[12px] px-2 py-1 rounded border border-black/15"
            placeholder="/Users/you/Downloads"
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
          />
          <button className="text-[11px] px-2 py-1 rounded border border-black/15 hover:bg-black/5" type="submit">Add</button>
        </form>
      </div>

      {/* Memory footprint + on-demand cleanup. Informational, never a hard limit —
          storage is tiny; this is a courtesy so the user stays in control. */}
      {usage && (
        <div className="py-1.5 border-t border-black/5">
          <div className="flex items-center justify-between">
            <span>
              Unmute memory <span className="text-ink/40">({usage.recipeCount} recipes · {usage.skillCount} skills · {fmtBytes(usage.bytes)})</span>
            </span>
            <button
              className="text-[11px] px-2 py-1 rounded border border-black/15 hover:bg-black/5 disabled:opacity-50"
              disabled={cleaning}
              onClick={() => void runCleanup()}
            >{cleaning ? 'Cleaning…' : 'Clean up'}</button>
          </div>
          {(usage.bytes > SOFT_BYTES || usage.recipeCount + usage.skillCount > SOFT_COUNT) && (
            <div className="mt-1 text-[10.5px] text-ink/50">
              Unmute is holding a fair bit of learned memory. Nothing's wrong — clear unused leads anytime to keep it lean.
            </div>
          )}
          {cleanupNote && <div className="mt-1 text-[10.5px] text-ink/50">{cleanupNote}</div>}
        </div>
      )}
    </div>
  )
}
