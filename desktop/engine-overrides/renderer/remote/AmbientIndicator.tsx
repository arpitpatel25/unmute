// Unmute Remote — ambient indicator (PRD §13.2).
//
// The always-present, tiny, glanceable surface. Answers the 90% question:
// "is anything happening / did my thing finish?" Zero interaction; never
// covers anything. Reuses the existing pill aesthetic (companion dot).
//
// Shown only when there's something to show (active tasks, a needs-user, or a
// brief green flash on completion) — otherwise renders nothing so a user who
// never uses Remote sees no change (PRD §2.4.1 additive/opt-in).

import { useRemoteTasks } from './useRemoteTasks'

export function AmbientIndicator() {
  const { activeCount, anyNeedsUser } = useRemoteTasks()

  if (activeCount === 0 && !anyNeedsUser) return null

  // amber when a task is waiting on the user; otherwise "N running" with a spinner.
  const waiting = anyNeedsUser
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{
        background: waiting ? 'rgba(217,119,6,0.15)' : 'rgba(0,0,0,0.06)',
        color: waiting ? '#b45309' : 'rgba(0,0,0,0.7)',
      }}
      title={waiting ? 'A task needs your input' : `${activeCount} task${activeCount === 1 ? '' : 's'} running`}
    >
      <span
        className="inline-block w-[6px] h-[6px] rounded-full"
        style={{
          background: waiting ? '#d97706' : '#16a34a',
          animation: waiting ? undefined : 'pulse 1.2s ease-in-out infinite',
        }}
      />
      {waiting ? 'needs you' : `${activeCount} running`}
    </div>
  )
}
