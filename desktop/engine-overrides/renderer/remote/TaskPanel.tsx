// Unmute Remote — task panel (PRD §13.3). The on-demand detail surface: the
// list of tasks with their rows. In the core build this lives as a tab in the
// main window (the simplest verifiable surface); the summon-near-the-pill
// translucent overlay is a follow-on refinement. NOT a persistent screen box.

import { useRemoteTasks } from './useRemoteTasks'
import { TaskRow } from './TaskRow'
import { RemoteSettings } from './RemoteSettings'

export function TaskPanel() {
  const { tasks, answer, kill, rerun } = useRemoteTasks()

  return (
    <div className="p-4">
      <div className="text-sm font-semibold text-ink mb-1">Remote tasks</div>
      <div className="text-[12px] text-ink/50 mb-3">
        Hold the Remote key and speak a command — it runs on your machine via Claude Code.
      </div>

      <RemoteSettings />

      {tasks.length === 0 ? (
        <div className="text-[12px] text-ink/40 italic py-6 text-center">
          No tasks yet. Try “extract the zip I just downloaded” or “find the contract PDF and open it”.
        </div>
      ) : (
        tasks.map((t) => (
          <TaskRow key={t.id} task={t} onAnswer={answer} onKill={kill} onRerun={rerun} />
        ))
      )}
    </div>
  )
}
