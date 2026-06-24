// Unmute Remote — task panel (PRD §13.3). The on-demand detail surface: the
// list of tasks with their rows. In the core build this lives as a tab in the
// main window (the simplest verifiable surface); the summon-near-the-pill
// translucent overlay is a follow-on refinement. NOT a persistent screen box.
//
// Two full-page sub-views hang off this panel: "How it works" (what Remote does
// + the permissions/safety story) and "Set up Remote" (the one-time extension
// setup). Both are reached from the header here.

import { useEffect, useState } from 'react'
import { useRemoteTasks } from './useRemoteTasks'
import { TaskRow } from './TaskRow'
import { RemoteSettings } from './RemoteSettings'
import { RemoteHowItWorks } from './RemoteHowItWorks'
import { RemoteSetup } from './RemoteSetup'

type Page = 'tasks' | 'how' | 'setup'

type SetupAPI = { remoteGetSetupStatus?: () => Promise<{ complete: boolean }> }
function setupApi(): SetupAPI {
  return (window as unknown as { electronAPI?: SetupAPI }).electronAPI ?? {}
}

export function TaskPanel() {
  const { tasks, activeCount, answer, kill, remove, killAll, rerun } = useRemoteTasks()
  const [page, setPage] = useState<Page>('tasks')
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)

  // Re-check setup state whenever we land back on the task list (so the nudge
  // clears as soon as the extension step is confirmed on the setup page).
  useEffect(() => {
    if (page !== 'tasks') return
    void setupApi().remoteGetSetupStatus?.().then((v) => v && setSetupComplete(v.complete))
  }, [page])

  if (page === 'how') return <RemoteHowItWorks onBack={() => setPage('tasks')} onOpenSetup={() => setPage('setup')} />
  if (page === 'setup') return <RemoteSetup onBack={() => setPage('tasks')} />

  return (
    <div className="p-4">
      <div className="text-sm font-semibold text-ink mb-1">Remote tasks</div>

      <div className="text-[12px] text-ink/50 mb-3">
        Hold the Remote key and speak a command — it runs on your machine via Claude Code.
      </div>

      {/* Page nav: the two explainer/setup surfaces, as proper outlined buttons. */}
      <div className="flex items-center gap-2 mb-3">
        <button
          className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-black/15 bg-white text-ink hover:bg-black/5"
          onClick={() => setPage('how')}
        >
          How it works
        </button>
        <button
          className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-black/15 bg-white text-ink hover:bg-black/5 flex items-center gap-1.5"
          onClick={() => setPage('setup')}
        >
          Set up Remote
          {setupComplete === false && <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />}
        </button>
      </div>

      {/* Nudge: only until the one required step (the extension) is confirmed. */}
      {setupComplete === false && (
        <button
          className="w-full text-left rounded-lg border border-accent/30 bg-accent/5 p-2.5 mb-3 text-[12px] text-ink/70 hover:bg-accent/10"
          onClick={() => setPage('setup')}
        >
          <b className="text-ink">Finish setting up Remote</b> — install the Claude for Chrome
          extension to enable browser tasks. Takes about 30 seconds →
        </button>
      )}

      <RemoteSettings />

      {tasks.length === 0 ? (
        <div className="text-[12px] text-ink/40 italic py-6 text-center">
          No tasks yet. Try “extract the zip I just downloaded” or “find the contract PDF and open it”.
        </div>
      ) : (
        <>
          {/* Tasks header — Kill all sits right above the list it acts on. */}
          <div className="flex items-center justify-between mt-1 mb-2">
            <div className="text-[12px] font-semibold text-ink/70">
              {tasks.length} task{tasks.length === 1 ? '' : 's'}
              {activeCount ? <span className="text-ink/40 font-normal"> · {activeCount} running</span> : null}
            </div>
            <button
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-red-300 text-red-700 hover:bg-red-50"
              title="Terminate every running session"
              onClick={() => {
                if (window.confirm('Kill ALL tasks? Every running Claude session is terminated immediately.')) killAll()
              }}
            >
              Kill all
            </button>
          </div>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} onAnswer={answer} onKill={kill} onRerun={rerun} onRemove={remove} />
          ))}
        </>
      )}
    </div>
  )
}
