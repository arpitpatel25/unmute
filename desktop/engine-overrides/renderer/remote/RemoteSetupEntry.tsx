// Unmute Orchestrator — the permanent way into agent setup.
//
// WHY THIS EXISTS. The setup page had no entry point at all: it hung off a task
// panel that nothing imported, so the entire checklist — agents, the Chrome
// extension, MCPs — was unreachable in the shipped app. The tab rendered only
// the settings panel. This component is now the ONLY route to `RemoteSetup`;
// deleting it strands the checklist again.
//
// WHY IT IS ALWAYS VISIBLE. Setup is not a one-time gate. A user may run Codex
// first and add Claude Code months later, and a connected Codex REGRESSES on its
// own — arming is a live debug port, so reopening the Codex app normally silently
// disconnects it. An entrance that disappears once "complete" would strand
// exactly the people who need it most. Only the urgency (the banner) is
// conditional; the door never is.

import { useEffect, useState } from 'react'

interface SetupStatus {
  complete: boolean
  /** The single thing most worth fixing, decided in main (setup-status.ts) so no
   *  surface hardcodes a step. Null when nothing is wrong. */
  blocker?: string | null
}
type API = { remoteGetSetupStatus?: () => Promise<SetupStatus> }
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

export function RemoteSetupEntry({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)

  useEffect(() => {
    let alive = true
    void api().remoteGetSetupStatus?.().then((v) => { if (alive && v) setStatus(v) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const blocker = status?.blocker ?? null

  return (
    <div className="mb-3">
      <button
        className="w-full text-left rounded-lg border border-black/10 bg-cream-mid/40 p-3 hover:bg-black/5 flex items-center gap-3"
        onClick={onOpen}
      >
        <span className="text-[16px] leading-none">⚙</span>
        <span className="flex-1">
          <span className="block text-[13px] font-semibold text-ink flex items-center gap-1.5">
            Agents &amp; setup
            {blocker && <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />}
          </span>
          <span className="block text-[11px] text-ink/50">
            {/* Never "you are done" — a working setup can stop working without
                anyone touching it, so this reads as a place to go, not a receipt. */}
            {blocker ?? 'Claude Code, Codex desktop, browser and integrations'}
          </span>
        </span>
        <span className="text-[11px] text-ink/30">→</span>
      </button>
    </div>
  )
}
