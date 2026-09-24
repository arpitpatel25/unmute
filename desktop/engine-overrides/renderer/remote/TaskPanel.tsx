// Unmute Orchestrator — the Tasks page in the main window.
//
// The in-app list of what your agents are doing: one ticket per task, the
// needs-you ones lifted to the top, each naming its agent, its model and its
// working directory. Its facts come from `taskFacts.ts` so they cannot drift
// from any other surface that shows a ticket.
//
// ONE SOURCE OF TRUTH FOR THE SELECTED PAGE. This panel used to carry its own
// `'tasks' | 'how' | 'setup'` state and its own buttons into those pages, from
// when it was a standalone panel that nothing imported. The Orchestrator tab now
// owns that selection with a segmented control above this component, so a second
// copy here would go stale the moment either one moved — enter How-it-works from
// inside this panel and the segment above still reads "Tasks". The state is gone;
// `page` is accepted as a prop and this renders only when it is the Tasks page.
// The prop is OPTIONAL so a caller that mounts this directly as the tasks page
// (passing nothing) is still correct.
//
// It also no longer says "Remote" anywhere. The surface is the Orchestrator, and
// this copy was written before it had that name.

import { useEffect, useState } from 'react'
import { useRemoteTasks, type RemoteTask } from './useRemoteTasks'
import { Markdown } from './Markdown'
import { ProviderMark } from './ProviderMark'
import { UIIcon } from '../app/UIIcon'
import {
  agentAndModel, canKill, canResume, dirLabel, isDesktopTask, openInLabel, vendorMark,
} from './taskFacts'

/** The Orchestrator tab's sub-pages. Mirrors the tab's own union; this panel
 *  only ever renders one of them and navigates to the others. */
type OrchestratorPage = 'tasks' | 'how' | 'setup' | 'settings'

const STATE_LABEL: Record<RemoteTask['state'], string> = {
  processing: 'Working',
  'needs-user': 'Needs you',
  ready: 'Ready for you',
  stuck: 'Possibly stuck',
  done: 'Done',
  failed: 'Failed',
}
const STATE_COLOR: Record<RemoteTask['state'], string> = {
  processing: '#2563eb',
  'needs-user': '#b45309',
  ready: '#0e7490',
  stuck: '#b45309',
  done: '#16a34a',
  failed: '#dc2626',
}

type SetupAPI = {
  remoteGetSetupStatus?: () => Promise<{ complete: boolean; blocker?: string | null }>
  remoteGetSettings?: () => Promise<{ permissionMode?: string }>
  remoteOpenInTerminal?: (id: string) => Promise<boolean>
  remoteOpenArtifact?: (t: 'url' | 'path', v: string) => Promise<boolean>
}
function api(): SetupAPI {
  return (window as unknown as { electronAPI?: SetupAPI }).electronAPI ?? {}
}

function nameOf(t: RemoteTask): string {
  if (t.name) return t.name
  const s = (t.intent || t.id.slice(0, 8)).trim()
  return s.length > 64 ? `${s.slice(0, 64).trimEnd()}…` : s
}

function elapsed(t: RemoteTask): string {
  const secs = Math.max(0, Math.round((t.updatedAt - t.createdAt) / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/* ─── One ticket ─────────────────────────────────────────────────────────────
 *
 * Its buttons ASK THE REGISTRY, never an agent id. Resume renders only where
 * `provider.canResume`; desktop integrations get a door into their own app.
 * Owned tasks use the native graphical conversation, never a terminal mirror.
 */
function Ticket({ task, permission, onAnswer, onKill, onRerun, onRemove, onResume }: {
  task: RemoteTask
  /** The CURRENT permission mode, read once by the page above. See the facts
   *  row below for why this one field cannot be historical like the others. */
  permission: string | null
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
  onRemove: (id: string) => void
  onResume: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [artifactError, setArtifactError] = useState(false)
  const active = task.state === 'processing' || task.state === 'needs-user' || task.state === 'stuck'
  const attention = task.state === 'needs-user'

  return (
    <div className={`ui-task-ticket border bg-white ${attention ? 'border-[#b45309]/45 shadow-[0_0_0_1px_rgba(180,83,9,0.10)]' : 'border-border'}`}>
      <div className="px-4 py-3.5">
        <p className="text-[14px] font-medium text-ink leading-snug">{nameOf(task)}</p>

        <div className="flex items-center gap-2 mt-1 text-[11px] font-medium" style={{ color: STATE_COLOR[task.state] }}>
          <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: STATE_COLOR[task.state] }} />
          {STATE_LABEL[task.state]} · {elapsed(task)}
        </div>

        {/* Structured tasks show their recorded session policy. Legacy records
            without it explicitly label the global default instead. */}
        <div className="ui-task-facts flex flex-wrap items-center mt-3 text-[11px] text-ink-35 min-w-0">
          <ProviderMark task={task} />
          {/* Only the MODEL survives as text — the mark says the rest, and the
              full "ran on …" sentence stays in its tooltip. */}
          {task.model && (
            <span className="shrink-0 truncate max-w-[45%]" title={`Ran on ${agentAndModel(task)}`}>{task.model}</span>
          )}
          {dirLabel(task) && (
            <span className="truncate" title={task.cwd}>{dirLabel(task)}</span>
          )}
          {(task.sessionPermission || permission) && (
            <span
              className="shrink-0 ml-auto"
              title={task.sessionPermission ? 'Recorded permission policy for this session' : 'Current global default; this legacy session did not record its policy'}
            >{task.sessionPermission || `Default: ${permission}`}</span>
          )}
        </div>

        {task.resumeError && !task.resuming && (
          <p className="mt-1.5 text-[11px] text-red-700/80" title={task.resumeError}>
            Couldn’t resume — {task.resumeError.startsWith('AGENT_SEPARATION_VIOLATION')
              ? 'this session belongs to a different agent'
              : task.resumeError}
          </p>
        )}

        {task.state === 'done' && task.result && (
          <div className="mt-2.5 text-[12.5px] text-ink-60">
            <p>{task.result.summary}</p>
            {task.result.detail && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] font-medium py-1">Result details</summary>
                <div className="mt-2 max-h-72 overflow-auto border-l border-border pl-3">
                  <Markdown text={task.result.detail} />
                </div>
              </details>
            )}
            {task.result.artifacts?.map((a, i) => (
              <button
                key={i}
                className="mt-2 text-[12px] text-ink-60 hover:text-ink inline-flex items-center gap-2 text-left border border-border rounded-lg px-3 py-2 max-w-full"
                title={`${a.type === 'path' ? 'Open local item' : 'Open link'}: ${a.value}`}
                onClick={async () => {
                  setArtifactError(false)
                  const open = api().remoteOpenArtifact
                  try {
                    if (!open || !await open(a.type, a.value)) setArtifactError(true)
                  } catch { setArtifactError(true) }
                }}
              >
                <UIIcon name={a.type === 'path' ? 'file' : 'link'} size={15} />
                <span className="truncate">{a.type === 'path' ? a.value.split(/[\\/]/).filter(Boolean).pop() || a.value : a.value}</span>
              </button>
            ))}
            {artifactError && <p role="alert" className="mt-1 text-red-700">Could not open link.</p>}
          </div>
        )}

        {task.state === 'failed' && !task.mcpGap && (
          <p className="mt-2.5 text-[12.5px] text-red-700">{task.error?.reason ?? 'Failed, with no reason reported.'}</p>
        )}
        {task.state === 'failed' && task.mcpGap && (
          <div className="mt-2.5 text-[12.5px] text-ink-60">
            <p>{task.mcpGap.message}</p>
            <code
              className="mt-1 inline-block px-2 py-0.5 rounded-md bg-cream-mid border border-border text-[11px] cursor-pointer"
              title="Copy"
              onClick={() => void navigator.clipboard?.writeText(task.mcpGap!.fixCommand)}
            >
              {task.mcpGap.fixCommand}
            </code>
          </div>
        )}

        {/* Needs you — answer by voice (hold your Orchestrator key) or by tap. */}
        {task.state === 'needs-user' && task.question && (
          <div className="mt-2.5 rounded-[10px] border border-[#b45309]/35 bg-[#b45309]/[0.06] p-2.5">
            {task.question.irreversible && (
              <p className="text-[10px] uppercase tracking-wider text-red-700 mb-1">⚠ irreversible — confirm carefully</p>
            )}
            <p className="text-[12.5px] text-ink font-medium mb-0.5">{task.question.text}</p>
            <p className="text-[11px] text-ink-35 mb-2">
              🎙 Hold your Orchestrator key and speak the answer — or {task.question.kind === 'choice' ? 'tap a choice' : 'type it'} below.
            </p>
            {task.question.kind === 'choice' && task.question.choices ? (
              <div className="flex flex-wrap gap-1.5">
                {task.question.choices.map((c) => (
                  <button
                    key={c}
                    className="text-[11px] px-2.5 py-1 rounded-md border border-border bg-white hover:bg-cream-mid"
                    onClick={() => onAnswer(task.id, c)}
                  >{c}</button>
                ))}
              </div>
            ) : (
              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (draft.trim()) { onAnswer(task.id, draft.trim()); setDraft('') }
                }}
              >
                <input
                  className="flex-1 text-[12.5px] px-2.5 py-1 rounded-md border border-border bg-white"
                  placeholder={task.question.kind === 'confirm' ? 'yes / no' : 'your answer…'}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
                <button className="text-[11px] px-3 py-1 rounded-md bg-ink text-white" type="submit">Send</button>
              </form>
            )}
          </div>
        )}

        {/* Actions. Every one of them is a registry answer. */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {active && canKill(task) && (
            <button className="text-[11px] px-2.5 py-1 rounded-md border border-border hover:bg-cream-mid" onClick={() => onKill(task.id)}>
              Stop
            </button>
          )}
          {!active && (
            <button className="text-[11px] px-2.5 py-1 rounded-md border border-border hover:bg-cream-mid" onClick={() => onRerun(task.intent)}>
              Run again
            </button>
          )}
          {!active && canResume(task) && (
            <button
              className="text-[11px] px-2.5 py-1 rounded-md border border-border hover:bg-cream-mid disabled:opacity-50 disabled:cursor-default"
              title={task.resuming ? 'Bringing the session back…' : 'Continue this exact session with its full prior context'}
              disabled={task.resuming}
              onClick={() => onResume(task.id)}
            >
              {task.resuming ? 'Resuming…' : 'Resume'}
            </button>
          )}
          {isDesktopTask(task) ? (
            <button
              // `first-letter`, not `capitalize`: the label is a sentence ("open
              // in Codex"), and `capitalize` would title-case every word of it.
              className="text-[11px] px-2.5 py-1 rounded-md border border-border hover:bg-cream-mid first-letter:uppercase"
              title="This task lives in its own app — there is no terminal here, and nothing to resume."
              onClick={() => void api().remoteOpenInTerminal?.(task.id)}
            >
              {openInLabel(task)}
            </button>
          ) : null}
          <button
            className="text-[11px] px-2.5 py-1 rounded-md border border-border text-ink-35 hover:text-ink hover:bg-cream-mid ml-auto"
            title="Erase this task and everything it wrote"
            onClick={() => {
              if (window.confirm('Remove this task entirely? Its session and scratch files are erased.')) onRemove(task.id)
            }}
          >
            Remove
          </button>
        </div>
      </div>

    </div>
  )
}

/* ─── The page ─── */

export function TaskPanel({ page = 'tasks', onPageChange }: {
  /** Which Orchestrator sub-page is selected. Owned by the tab above; this
   *  component keeps no copy of it. */
  page?: OrchestratorPage
  /** Navigate the tab. Absent ⇒ this panel offers no cross-page links rather
   *  than rendering buttons that would do nothing. */
  onPageChange?: (page: OrchestratorPage) => void
} = {}) {
  const { tasks, activeCount, answer, kill, remove, killAll, rerun, resume } = useRemoteTasks()
  const [blocker, setBlocker] = useState<string | null>(null)
  // Read ONCE for the page, not once per ticket: it is one global setting, and
  // every ticket showing a different answer to the same question is impossible.
  const [permission, setPermission] = useState<string | null>(null)
  useEffect(() => {
    void api().remoteGetSettings?.()
      .then((v) => setPermission(v?.permissionMode ? (v.permissionMode === 'auto-approve' ? 'auto-approve' : 'ask before acting') : null))
      .catch(() => {})
  }, [])

  // Re-checked whenever this page is shown, so the nudge clears as soon as the
  // setup page confirms the missing piece.
  useEffect(() => {
    if (page !== 'tasks') return
    void api().remoteGetSetupStatus?.()
      .then((v) => setBlocker(v && !v.complete ? (v.blocker ?? 'Finish setting up your agent') : null))
      .catch(() => {})
  }, [page])

  if (page !== 'tasks') return null

  // NEEDS YOU FIRST (launch spec pack-c §3.1). One task waiting on an answer
  // outranks eleven that finished. Lifted, not copied — one ticket, one place.
  const needsYou = tasks.filter((t) => t.state === 'needs-user')
  const rest = tasks.filter((t) => t.state !== 'needs-user')

  return (
    <div>
      {blocker && onPageChange && (
        <button
          className="w-full text-left rounded-[12px] border border-accent/30 bg-accent/5 px-4 py-3 mb-3 text-[12.5px] text-ink-60 hover:bg-accent/10"
          onClick={() => onPageChange('setup')}
        >
          <b className="text-ink">{blocker}</b> — open Agents to finish. →
        </button>
      )}

      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-[13px] font-medium text-ink">
          {tasks.length === 0 ? 'Nothing running' : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
          {activeCount ? <span className="text-ink-35 font-normal"> · {activeCount} working</span> : null}
        </p>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <button
              className="text-[11px] font-medium px-3 py-1.5 rounded-full border border-border text-ink-60 hover:bg-cream-mid"
              title="Stop every running session"
              onClick={() => {
                if (window.confirm('Stop ALL tasks? Every running session is terminated immediately.')) killAll()
              }}
            >
              Stop all
            </button>
          )}
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-[12px] border border-border bg-white px-4 py-6">
          <p className="text-[14px] text-ink">Press your Orchestrator key and say what you want done.</p>
          <p className="text-[12.5px] text-ink-35 mt-1.5 leading-relaxed">
            Every task you start appears here while it works, and stays until you have read it.
          </p>
        </div>
      ) : (
        <>
          {needsYou.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-[#b45309] mb-2">
                Needs you · {needsYou.length}
              </p>
              {needsYou.map((t) => (
                <Ticket key={t.id} task={t} permission={permission} onAnswer={answer} onKill={kill} onRerun={rerun} onRemove={remove} onResume={resume} />
              ))}
            </div>
          )}
          {rest.map((t) => (
            <Ticket key={t.id} task={t} permission={permission} onAnswer={answer} onKill={kill} onRerun={rerun} onRemove={remove} onResume={resume} />
          ))}
        </>
      )}
    </div>
  )
}
