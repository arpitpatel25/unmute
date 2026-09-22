// Meetings list — chronological (newest first, matching notetaker:list-meetings'
// own `ORDER BY started_at DESC`), each row title/date/time/duration, click
// through to the detail view. Loading/empty states follow History.tsx's
// established treatment (dot-bounce loader, centered empty-state copy) so this
// feels native rather than introducing a new visual language.

import { useEffect, useState } from 'react'
import { SHOW_TRANSCRIPT_UI } from './notetakerUi'
import { MeetingDetail } from './MeetingDetail'

// Field-for-field mirror of NotetakerMeetingSnapshot (electron/remote-preload.ts).
// Not imported directly — that file documents its own cross-tree copy hazard
// (engine-overrides/ and electron/ are copied onto the built engine
// separately, so a relative import between them resolves differently
// pre-/post-copy); every other renderer file in this app (useRemoteTasks.ts,
// NotetakerWidget.tsx) redefines its preload-facing shape locally for the
// same reason, so this follows that precedent rather than the DBMeeting shape.
export type NotetakerPipelineStatus = 'disabled' | 'pending' | 'success' | 'failed'

export type NotetakerMeeting = {
  id: string
  title: string
  started_at: number
  ended_at: number
  duration_ms: number
  status: 'recording' | 'transcribing' | 'ready' | 'failed'
  transcript_path: string | null
  audio_mic_path: string | null
  audio_system_path: string | null
  cleanup_status: NotetakerPipelineStatus
  summary_status: NotetakerPipelineStatus
  cleaned_transcript_path: string | null
  notes_path: string | null
}

const STATUS_LABEL: Record<NotetakerMeeting['status'], string> = {
  recording: 'Recording…',
  transcribing: 'Transcribing…',
  ready: 'Ready',
  failed: 'Failed',
}

function progressLabel(meeting: NotetakerMeeting): string | null {
  if (meeting.summary_status === 'pending') return 'Writing notes'
  if (meeting.summary_status === 'failed') return 'Notes failed'
  if (meeting.summary_status === 'disabled' && meeting.status === 'ready') return 'No notes'
  return meeting.status === 'ready' ? null : STATUS_LABEL[meeting.status]
}

type API = {
  notetakerListMeetings?: () => Promise<NotetakerMeeting[]>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function formatMeetingTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function MeetingWaveform() {
  return (
    <div className="flex items-center gap-[2px] h-[28px] opacity-[0.07] shrink-0 mr-1" aria-hidden="true">
      {[6, 14, 10, 18, 8, 16, 12, 20].map((height, index) => (
        <div key={index} className="w-[2.5px] rounded-sm bg-ink" style={{ height: `${height}px` }} />
      ))}
    </div>
  )
}

/** Calendar-day key in the viewer's own local timezone — two meetings late
 *  one night and early the next morning must land in different groups, so
 *  this can't just floor by 24h-since-epoch. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatDayHeader(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (dayKey(ms) === dayKey(today.getTime())) return 'Today'
  if (dayKey(ms) === dayKey(yesterday.getTime())) return 'Yesterday'
  const sameYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString(undefined, sameYear
    ? { weekday: 'long', month: 'long', day: 'numeric' }
    : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

/** `meetings` arrives newest-first (notetaker:list-meetings' own
 *  ORDER BY started_at DESC) — grouping is a straight run-length split on
 *  dayKey, no re-sort needed. */
function groupMeetingsByDay(meetings: NotetakerMeeting[]): { key: string; day: NotetakerMeeting[] }[] {
  const groups: { key: string; day: NotetakerMeeting[] }[] = []
  for (const meeting of meetings) {
    const key = dayKey(meeting.started_at)
    const current = groups[groups.length - 1]
    if (current && current.key === key) current.day.push(meeting)
    else groups.push({ key, day: [meeting] })
  }
  return groups
}

export function MeetingsList({
  pendingMeetingId,
  onConsumedPendingMeetingId,
}: {
  /** Set by App.tsx when the Agent's notetaker_open tool fires. */
  pendingMeetingId?: string | null
  onConsumedPendingMeetingId?: () => void
} = {}) {
  const [meetings, setMeetings] = useState<NotetakerMeeting[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => api().notetakerListMeetings?.()
      .then((data) => { if (!cancelled) setMeetings(data ?? []) })
      .catch((err) => {
        console.error('Failed to load meetings:', err)
        if (!cancelled) setMeetings((current) => current ?? [])
      })
    void load()
    // Capture and note generation happen in the main process. Polling the
    // local SQLite-backed list keeps an already-open Meetings page current,
    // including the durable "Preparing notes…" row created at stop time.
    const interval = window.setInterval(() => { void load() }, 2000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  // A meeting can finish while this list is already mounted. Refresh before
  // selecting it: otherwise the old in-memory list has no new row to find,
  // making a real "Preparing notes" meeting look like nothing happened.
  useEffect(() => {
    if (!pendingMeetingId) return
    let cancelled = false
    api().notetakerListMeetings?.()
      .then((data) => {
        if (cancelled) return
        setMeetings(data ?? [])
        setSelectedId(pendingMeetingId)
        onConsumedPendingMeetingId?.()
      })
      .catch((err) => {
        console.error('Failed to refresh meetings:', err)
        if (!cancelled) onConsumedPendingMeetingId?.()
      })
    return () => { cancelled = true }
  }, [pendingMeetingId])

  const selected = selectedId ? meetings?.find((m) => m.id === selectedId) ?? null : null

  if (selected) {
    return (
      <MeetingDetail
        id={selected.id}
        initialTitle={selected.title}
        startedAt={selected.started_at}
        durationMs={selected.duration_ms}
        initialSummaryStatus={selected.summary_status}
        onBack={() => setSelectedId(null)}
      />
    )
  }

  if (meetings === null) {
    return (
      <div className="flex items-center gap-3 py-20 justify-center">
        <div className="w-[5px] h-[5px] rounded-full bg-accent animate-dot-bounce" />
        <div className="w-[5px] h-[5px] rounded-full bg-accent animate-dot-bounce" style={{ animationDelay: '0.15s' }} />
        <div className="w-[5px] h-[5px] rounded-full bg-accent animate-dot-bounce" style={{ animationDelay: '0.3s' }} />
      </div>
    )
  }

  if (meetings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-20 h-20 rounded-2xl bg-ink-07 flex items-center justify-center mb-5">
          <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-35">
            <rect x="3" y="2" width="10" height="12" rx="1.5" />
            <line x1="5.5" y1="6" x2="10.5" y2="6" />
            <line x1="5.5" y1="9" x2="10.5" y2="9" />
          </svg>
        </div>
        <p className="font-display font-bold text-ink text-lg mb-1">No meetings recorded yet</p>
        <p className="text-ink-35 text-sm max-w-[280px] leading-relaxed">
          Double-tap the left Control key in a call to start a note-taking session.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="font-display text-[20px] font-bold text-ink tracking-tight">Meeting notes</h3>
        <p className="text-[11px] text-ink-35 mt-1">
          {SHOW_TRANSCRIPT_UI ? 'Your recordings, transcripts, and notes.' : 'Your recordings and notes.'}
        </p>
      </div>
      {groupMeetingsByDay(meetings).map(({ key, day }) => (
        <div key={key} className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold text-ink-35 uppercase tracking-wide px-1">
            {formatDayHeader(day[0].started_at)}
          </div>
          {day.map((meeting) => {
            const progress = progressLabel(meeting)
            const failed = meeting.status === 'failed' || meeting.summary_status === 'failed'
            return (
              <button
                key={meeting.id}
                onClick={() => setSelectedId(meeting.id)}
                className={`group text-left relative px-5 py-4 rounded-xl border transition-colors duration-150 ${
                  failed
                    ? 'border-error/15 bg-error-soft hover:border-error/25'
                    : meeting.summary_status === 'pending'
                      ? 'border-accent/20 bg-accent/[0.025] hover:border-accent/30'
                      : 'border-border bg-surface-2 hover:border-border-md'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[11px] text-ink-35 font-medium">{formatMeetingTime(meeting.started_at)}</span>
                      {progress ? (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1.5 ${
                          failed
                            ? 'text-error bg-error/[0.08]'
                            : meeting.summary_status === 'pending'
                              ? 'text-accent bg-accent/[0.08]'
                              : 'text-ink-35 bg-ink-07'
                        }`}>
                          {meeting.summary_status === 'pending' && !failed && (
                            <span className="flex items-center gap-[3px]" aria-hidden="true">
                              <span className="w-[3px] h-[3px] rounded-full bg-accent animate-dot-bounce" />
                              <span className="w-[3px] h-[3px] rounded-full bg-accent animate-dot-bounce" style={{ animationDelay: '0.15s' }} />
                              <span className="w-[3px] h-[3px] rounded-full bg-accent animate-dot-bounce" style={{ animationDelay: '0.3s' }} />
                            </span>
                          )}
                          {progress}
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">Notes ready</span>
                      )}
                    </div>
                    <div className="text-[14px] font-medium text-ink leading-snug line-clamp-2">{meeting.title}</div>
                    <div className="text-[11px] text-ink-60 mt-1.5">
                      {formatDuration(meeting.duration_ms)} recording
                      {meeting.summary_status === 'pending' && !failed && (
                        // The list polls every 2s, so this row updates itself —
                        // say so, rather than leaving the user watching it.
                        <span className="text-accent"> · Summarising your meeting — check back in a moment</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <MeetingWaveform />
                    <svg className="text-ink-35 group-hover:text-accent transition-colors" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
