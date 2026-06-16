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
  logFile: string | null
}
type API = {
  remoteGetSettings?: () => Promise<Settings>
  remoteSetPermissionMode?: (m: 'prompt' | 'auto-approve') => Promise<boolean>
  remoteSetAgent?: (a: 'claude' | 'codex') => Promise<boolean>
  remoteSetSandboxRoots?: (r: string[]) => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

export function RemoteSettings() {
  const [s, setS] = useState<Settings | null>(null)
  const [newRoot, setNewRoot] = useState('')

  useEffect(() => { void api().remoteGetSettings?.().then((v) => v && setS(v)) }, [])
  if (!s) return null

  const update = (patch: Partial<Settings>) => setS((prev) => (prev ? { ...prev, ...patch } : prev))

  return (
    <div className="rounded-lg border border-black/10 p-3 mb-3 bg-cream-mid/40 text-[12px]">
      <div className="font-semibold text-ink mb-2">Remote settings</div>

      <div className="text-[11px] text-ink/50 mb-2">
        Remote key: <b>{s.remoteKey === 'fn' ? 'Function key' : 'Right-option'}</b> (the key not used for dictation).
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

      {/* Executor agent (§11) */}
      <label className="flex items-center justify-between py-1.5 border-t border-black/5">
        <span>Executor</span>
        <select
          className="text-[12px] border border-black/15 rounded px-1 py-0.5 bg-white"
          value={s.agent}
          onChange={(e) => {
            const agent = e.target.value as 'claude' | 'codex'
            update({ agent })
            void api().remoteSetAgent?.(agent)
          }}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
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
