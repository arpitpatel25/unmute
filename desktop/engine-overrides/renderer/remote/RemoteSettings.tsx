// Unmute Remote — settings panel (PRD §2.4.5, §10.1, §10.6, §11).
//
// Lives in the Remote tab. Exposes the user-facing knobs whose IPC already
// exists in remote/init.ts: permission mode (auto-approve), executor agent
// (claude/codex), and the path sandbox roots. Credentials are NEVER here
// (PRD §12.1) — MCP setup is done in the user's own Claude Code.

import { useEffect, useState } from 'react'

interface Settings {
  permissionMode: 'prompt' | 'auto-approve'
  remoteKey: 'fn' | 'right-option'
  agent: 'claude' | 'codex'
  sandboxRoots: string[]
  model: string
  browserEnabled: boolean
  overlayAutoPresent: boolean
  overlayDocked: boolean
  osNotifications: boolean
  logFile: string | null
}
type API = {
  remoteGetSettings?: () => Promise<Settings>
  remoteSetPermissionMode?: (m: 'prompt' | 'auto-approve') => Promise<boolean>
  remoteSetAgent?: (a: 'claude' | 'codex') => Promise<boolean>
  remoteSetSandboxRoots?: (r: string[]) => Promise<boolean>
  remoteSetBrowserEnabled?: (enabled: boolean) => Promise<boolean>
  remoteSetModel?: (m: string) => Promise<string>
  remoteOnModelChanged?: (cb: (model: string) => void) => () => void
  remoteSetOverlayAutoPresent?: (on: boolean) => Promise<boolean>
  remoteSetOverlayDocked?: (on: boolean) => Promise<boolean>
  remoteSetOsNotifications?: (on: boolean) => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

export function RemoteSettings() {
  const [s, setS] = useState<Settings | null>(null)
  const [newRoot, setNewRoot] = useState('')

  useEffect(() => {
    void api().remoteGetSettings?.().then((v) => v && setS(v))
    // Stay in sync when the model is changed from the capture-widget badge.
    const off = api().remoteOnModelChanged?.((model) => setS((prev) => (prev ? { ...prev, model } : prev)))
    return () => off?.()
  }, [])
  if (!s) return null

  const update = (patch: Partial<Settings>) => setS((prev) => (prev ? { ...prev, ...patch } : prev))

  return (
    <div className="rounded-lg border border-black/10 p-3 mb-3 bg-cream-mid/40 text-[12px]">
      <div className="font-semibold text-ink mb-2">Remote settings</div>

      <div className="text-[11px] text-ink/50 mb-2">
        Remote key: <b>{s.remoteKey === 'fn' ? 'Function key' : 'Right-option'}</b> (the key not used for dictation).
      </div>

      {/* Doer model — Remote tasks run on this. Applies to the next task. */}
      <div className="py-1.5 border-t border-black/5">
        <div className="mb-1.5">Model <span className="text-ink/40">(Remote tasks — applies to the next one)</span></div>
        <div className="flex gap-1.5">
          {(['haiku', 'sonnet', 'opus'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { update({ model: m }); void api().remoteSetModel?.(m) }}
              className={`flex-1 px-2 py-1.5 rounded-lg text-[12px] font-semibold capitalize border transition-colors ${
                s.model === m
                  ? 'bg-[#D97757] text-white border-[#D97757]'
                  : 'bg-white text-ink/70 border-border hover:bg-cream-mid'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="mt-1 text-[10.5px] text-ink/40">
          {s.model === 'haiku'
            ? 'Fastest — best for simple, quick tasks.'
            : s.model === 'opus'
              ? 'Most capable — best for complex, multi-step tasks.'
              : 'Balanced — fast and capable. Recommended default.'}
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

      {/* Overlay auto-present — the floating task window pops up on done/needs-you */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Pop up task overlay <span className="text-ink/40">(shows results/questions where you’re working)</span></span>
        <input
          type="checkbox"
          checked={s.overlayAutoPresent}
          onChange={(e) => {
            const on = e.target.checked
            update({ overlayAutoPresent: on })
            void api().remoteSetOverlayAutoPresent?.(on)
          }}
        />
      </label>

      {/* Docked overlay — a small bottom-right pill that expands on activity */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Dock the overlay <span className="text-ink/40">(small bottom-right pill with task counts; expands on done/needs-you, esc collapses)</span></span>
        <input
          type="checkbox"
          checked={s.overlayDocked}
          onChange={(e) => {
            const on = e.target.checked
            update({ overlayDocked: on })
            void api().remoteSetOverlayDocked?.(on)
          }}
        />
      </label>

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

      {/* Executor agent (§11) */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Executor</span>
        <select
          className="text-[12px] border border-black/15 rounded px-1 py-0.5 bg-white"
          // Codex is shown but not selectable yet — coerce a stale value to claude.
          value={s.agent === 'codex' ? 'claude' : s.agent}
          onChange={(e) => {
            const agent = e.target.value as 'claude' | 'codex'
            if (agent !== 'claude') return // Codex is coming soon — ignore
            update({ agent })
            void api().remoteSetAgent?.(agent)
          }}
        >
          <option value="claude">Claude Code</option>
          <option value="codex" disabled>Codex (coming soon)</option>
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
    </div>
  )
}
