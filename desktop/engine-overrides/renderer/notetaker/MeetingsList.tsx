// Meetings list — chronological (newest first, matching notetaker:list-meetings'
// own `ORDER BY started_at DESC`), each row title/date/time/duration, click
// through to the detail view. Loading/empty states follow History.tsx's
// established treatment (dot-bounce loader, centered empty-state copy) so this
// feels native rather than introducing a new visual language.

import { useEffect, useState } from 'react'
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
    api().notetakerListMeetings?.()
      .then((data) => { if (!cancelled) setMeetings(data ?? []) })
      .catch((err) => {
        console.error('Failed to load meetings:', err)
        if (!cancelled) setMeetings([])
      })
    return () => { cancelled = true }
  }, [])

  // Consume once: select it now (resolves once `meetings` has loaded, same
  // as any other selection) and tell App.tsx it's been picked up so the same
  // id doesn't re-select after the user navigates away and back.
  useEffect(() => {
    if (!pendingMeetingId) return
    setSelectedId(pendingMeetingId)
    onConsumedPendingMeetingId?.()
  }, [pendingMeetingId])

  const selected = selectedId ? meetings?.find((m) => m.id === selectedId) ?? null : null

  if (selected) {
    return (
      <MeetingDetail
        id={selected.id}
        initialTitle={selected.title}
        startedAt={selected.started_at}
        durationMs={selected.duration_ms}
        initialCleanupStatus={selected.cleanup_status}
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
          Double-tap Control + Option (left side) in a call to start a note-taking session.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {meetings.map((meeting) => {
        const date = new Date(meeting.started_at)
        return (
          <button
            key={meeting.id}
            onClick={() => setSelectedId(meeting.id)}
            className="text-left px-3 py-2.5 rounded-[10px] hover:bg-ink-07 transition-colors"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-[13px] font-medium text-ink truncate">{meeting.title}</div>
              {meeting.status !== 'ready' && (
                <span className="text-[10px] font-semibold text-ink-35 bg-ink-07 px-2 py-0.5 rounded-full shrink-0">
                  {STATUS_LABEL[meeting.status]}
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink-60">
              {date.toLocaleDateString()} · {date.toLocaleTimeString()} · {formatDuration(meeting.duration_ms)}
            </div>
          </button>
        )
      })}
    </div>
  )
}
