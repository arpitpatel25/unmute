// Meeting detail — two top-level tabs (Notes / Transcript, 2026-08-25 spec
// §9), replacing the previous single flat transcript view.
//
// Transcript tab: Cleaned/Raw sub-tabs, Cleaned selected by default once
// cleanup has succeeded (else Raw, since Cleaned has nothing to show yet).
// Raw is always available regardless of cleanup status — unchanged from
// before this feature existed. Audio playback (mic segments "You"; system
// segments show a real attributed speaker name when known — Zoom calls
// only, read from Zoom's own accessibility tree, see zoomSpeaker.ts —
// falling back to generic "Them" otherwise) lives here too, for whichever
// channel(s) still have audio (hidden once the 24h sweep has removed a
// channel's file).
//
// Notes tab: title/date/time, then Summary/Key Points/Decisions/Action
// Items as native <details> disclosures — real collapsible/expandable
// sections, not a scrolling block of markdown. A section is omitted
// entirely (not shown collapsed-empty) if notes.json returned it empty.
//
// Both tabs show a disabled/pending/failed-with-retry state instead of
// content when their stage hasn't succeeded — spec §6's failure/retry
// model. `startedAt`/`durationMs`/`initialCleanupStatus`/
// `initialSummaryStatus` come from MeetingsList's already-fetched row
// (same "caller already has it, no redundant round trip" reasoning
// `initialTitle` already followed) — only the two status fields are then
// polled independently while `pending`, since they're the only ones that
// can change while this view is open (an in-flight auto pipeline, or a
// user-triggered retry).

import { useEffect, useRef, useState } from 'react'

// Field-for-field mirrors of the preload-facing types (electron/remote-
// preload.ts) — not imported directly, same cross-tree precedent every
// other renderer file in this app already follows (see MeetingsList.tsx's
// own header comment).
type NotetakerTranscriptSegment = {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
  speakerName?: string | null
}

type NotetakerPipelineStatus = 'disabled' | 'pending' | 'success' | 'failed'

type NotetakerMeetingNotes = {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
}

type API = {
  notetakerGetTranscript?: (id: string) => Promise<NotetakerTranscriptSegment[]>
  notetakerGetCleanedTranscript?: (id: string) => Promise<NotetakerTranscriptSegment[]>
  notetakerGetNotes?: (id: string) => Promise<NotetakerMeetingNotes | null>
  notetakerGetAudioUrl?: (id: string, channel: 'mic' | 'system') => Promise<string | null>
  notetakerRenameMeeting?: (id: string, title: string) => Promise<void>
  notetakerDeleteMeeting?: (id: string) => Promise<void>
  notetakerRetryPipeline?: (id: string) => Promise<void>
  notetakerGetPipelineStatus?: (id: string) => Promise<{ cleanup_status: NotetakerPipelineStatus; summary_status: NotetakerPipelineStatus } | null>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

const STATUS_POLL_MS = 3000

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

// Same shape as MeetingsList.tsx's own formatDuration — duplicated rather
// than imported, matching this file's existing self-contained-per-file
// convention for small formatting helpers.
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function TranscriptSegments({ segments, emptyLabel }: { segments: NotetakerTranscriptSegment[] | null; emptyLabel: string }) {
  if (segments === null) return <p className="text-ink-60 text-sm">Loading…</p>
  if (segments.length === 0) return <p className="text-ink-60 text-sm">{emptyLabel}</p>
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) => (
        <div key={i} className="text-[13px] leading-relaxed">
          <span className="font-semibold text-ink">
            {seg.channel === 'mic' ? 'You' : (seg.speakerName || 'Them')}:{' '}
          </span>
          <span className="text-ink">{seg.text}</span>
        </div>
      ))}
    </div>
  )
}

/** disabled/pending/failed-with-retry — the one state view shared by both
 *  the Transcript tab's Cleaned sub-tab and the whole Notes tab (spec §6). */
function PipelineStatusNotice({ status, onRetry, retrying, kind }: {
  status: NotetakerPipelineStatus
  onRetry: () => void
  retrying: boolean
  kind: 'cleanup' | 'summary'
}) {
  if (status === 'disabled') {
    return <p className="text-ink-60 text-sm">Automatic {kind === 'cleanup' ? 'cleanup' : 'notes'} wasn&apos;t turned on for this meeting.</p>
  }
  if (status === 'pending') {
    return <p className="text-ink-60 text-sm">{kind === 'cleanup' ? 'Cleaning up the transcript…' : 'Generating notes…'}</p>
  }
  return (
    <div className="flex items-center gap-2">
      <p className="text-error text-sm">{kind === 'cleanup' ? 'Cleanup failed.' : 'Summary failed.'}</p>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="text-[12px] px-2 py-1 rounded border border-black/15 hover:bg-black/5 disabled:opacity-50"
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

function NotesSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <details open className="rounded border border-black/10 p-2.5">
      <summary className="text-[12.5px] font-semibold text-ink cursor-pointer select-none">{title}</summary>
      <ul className="mt-2 flex flex-col gap-1.5 list-disc pl-4">
        {items.map((item, i) => (
          <li key={i} className="text-[13px] leading-relaxed text-ink">{item}</li>
        ))}
      </ul>
    </details>
  )
}

export function MeetingDetail({
  id,
  initialTitle,
  startedAt,
  durationMs,
  initialCleanupStatus,
  initialSummaryStatus,
  onBack,
}: {
  id: string
  initialTitle: string
  startedAt: number
  durationMs: number
  initialCleanupStatus: NotetakerPipelineStatus
  initialSummaryStatus: NotetakerPipelineStatus
  onBack: () => void
}) {
  const [tab, setTab] = useState<'notes' | 'transcript'>('notes')
  const [transcriptSubTab, setTranscriptSubTab] = useState<'cleaned' | 'raw'>(
    initialCleanupStatus === 'success' ? 'cleaned' : 'raw',
  )

  const [rawSegments, setRawSegments] = useState<NotetakerTranscriptSegment[] | null>(null)
  const [cleanedSegments, setCleanedSegments] = useState<NotetakerTranscriptSegment[] | null>(null)
  const [notes, setNotes] = useState<NotetakerMeetingNotes | null>(null)
  const [cleanupStatus, setCleanupStatus] = useState(initialCleanupStatus)
  const [summaryStatus, setSummaryStatus] = useState(initialSummaryStatus)
  const [retrying, setRetrying] = useState(false)

  const [micAudioUrl, setMicAudioUrl] = useState<string | null>(null)
  const [systemAudioUrl, setSystemAudioUrl] = useState<string | null>(null)
  const [title, setTitle] = useState(initialTitle)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(initialTitle)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setTab('notes')
    setTranscriptSubTab(initialCleanupStatus === 'success' ? 'cleaned' : 'raw')
    setRawSegments(null)
    setCleanedSegments(null)
    setNotes(null)
    setCleanupStatus(initialCleanupStatus)
    setSummaryStatus(initialSummaryStatus)
    setTitle(initialTitle)
    setDraftTitle(initialTitle)

    api().notetakerGetTranscript?.(id)
      .then((data) => { if (!cancelled) setRawSegments(data ?? []) })
      .catch((err) => { console.error('Failed to load raw transcript:', err); if (!cancelled) setRawSegments([]) })

    api().notetakerGetCleanedTranscript?.(id)
      .then((data) => { if (!cancelled) setCleanedSegments(data ?? []) })
      .catch((err) => { console.error('Failed to load cleaned transcript:', err); if (!cancelled) setCleanedSegments([]) })

    api().notetakerGetNotes?.(id)
      .then((data) => { if (!cancelled) setNotes(data) })
      .catch((err) => { console.error('Failed to load notes:', err); if (!cancelled) setNotes(null) })

    api().notetakerGetAudioUrl?.(id, 'mic')
      .then((url) => { if (!cancelled) setMicAudioUrl(url) })
      .catch(() => { if (!cancelled) setMicAudioUrl(null) })

    api().notetakerGetAudioUrl?.(id, 'system')
      .then((url) => { if (!cancelled) setSystemAudioUrl(url) })
      .catch(() => { if (!cancelled) setSystemAudioUrl(null) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Poll the two status fields while either is still 'pending' — an
  // in-flight auto pipeline (or a retry just kicked off below) needs
  // SOMETHING to notice when it settles, since nothing pushes that update
  // to an already-open detail view. Stops itself once both are settled.
  const pendingRef = useRef(false)
  pendingRef.current = cleanupStatus === 'pending' || summaryStatus === 'pending'
  useEffect(() => {
    if (!pendingRef.current) return
    let cancelled = false
    const interval = setInterval(() => {
      if (!pendingRef.current) { clearInterval(interval); return }
      api().notetakerGetPipelineStatus?.(id).then((result) => {
        if (cancelled || !result) return
        setCleanupStatus((prev) => {
          if (prev === 'pending' && result.cleanup_status !== 'pending' && result.cleanup_status === 'success') {
            // Cleanup just finished — the cleaned transcript file now
            // exists where it didn't a moment ago.
            api().notetakerGetCleanedTranscript?.(id).then((data) => { if (!cancelled) setCleanedSegments(data ?? []) })
          }
          return result.cleanup_status
        })
        setSummaryStatus((prev) => {
          if (prev === 'pending' && result.summary_status === 'success') {
            api().notetakerGetNotes?.(id).then((data) => { if (!cancelled) setNotes(data) })
          }
          return result.summary_status
        })
      })
    }, STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cleanupStatus === 'pending', summaryStatus === 'pending'])

  async function handleRetry() {
    if (retrying) return
    setRetrying(true)
    if (cleanupStatus !== 'success') setCleanupStatus('pending')
    else setSummaryStatus('pending')
    try {
      await api().notetakerRetryPipeline?.(id)
    } catch (err) {
      console.error('Failed to retry pipeline:', err)
    } finally {
      setRetrying(false)
    }
  }

  async function saveTitle() {
    const next = draftTitle.trim()
    setEditingTitle(false)
    if (!next || next === title) {
      setDraftTitle(title)
      return
    }
    setTitle(next)
    try {
      await api().notetakerRenameMeeting?.(id, next)
    } catch (err) {
      console.error('Failed to rename meeting:', err)
    }
  }

  async function handleDelete() {
    if (deleting) return
    setDeleting(true)
    try {
      await api().notetakerDeleteMeeting?.(id)
      onBack()
    } catch (err) {
      console.error('Failed to delete meeting:', err)
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-[12px] text-ink-60 hover:text-ink transition-colors">
          &larr; Back
        </button>
      </div>

      {editingTitle ? (
        <input
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveTitle()
            if (e.key === 'Escape') { setDraftTitle(title); setEditingTitle(false) }
          }}
          className="text-[18px] font-bold text-ink bg-transparent border-b border-border outline-none w-full"
          autoFocus
        />
      ) : (
        <h2
          className="text-[18px] font-bold text-ink cursor-text"
          onClick={() => { setDraftTitle(title); setEditingTitle(true) }}
          title="Click to rename"
        >
          {title}
        </h2>
      )}

      <div className="text-[12px] text-ink-60">{formatDateTime(startedAt)} · {formatDuration(durationMs)}</div>

      <div className="flex gap-1 border-b border-black/10">
        {(['notes', 'transcript'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-[12.5px] px-3 py-1.5 -mb-px border-b-2 transition-colors ${
              tab === t ? 'border-accent text-ink font-medium' : 'border-transparent text-ink-60 hover:text-ink'
            }`}
          >
            {t === 'notes' ? 'Notes' : 'Transcript'}
          </button>
        ))}
      </div>

      {tab === 'notes' && (
        summaryStatus === 'success' && notes ? (
          <div className="flex flex-col gap-2.5">
            <p className="text-[13px] leading-relaxed text-ink">{notes.summary}</p>
            <NotesSection title="Key Points" items={notes.keyPoints} />
            <NotesSection title="Decisions" items={notes.decisions} />
            <NotesSection title="Action Items" items={notes.actionItems} />
          </div>
        ) : (
          <PipelineStatusNotice status={summaryStatus} onRetry={() => void handleRetry()} retrying={retrying} kind="summary" />
        )
      )}

      {tab === 'transcript' && (
        <div className="flex flex-col gap-3">
          {(micAudioUrl || systemAudioUrl) && (
            <div className="flex flex-col gap-2">
              {micAudioUrl && (
                <div>
                  <div className="text-[11px] text-ink-60 mb-1">You</div>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls src={micAudioUrl} className="w-full" />
                </div>
              )}
              {systemAudioUrl && (
                <div>
                  <div className="text-[11px] text-ink-60 mb-1">Them</div>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls src={systemAudioUrl} className="w-full" />
                </div>
              )}
            </div>
          )}

          <div className="flex gap-1">
            {(['cleaned', 'raw'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTranscriptSubTab(t)}
                className={`text-[11.5px] px-2.5 py-1 rounded-full border transition-colors ${
                  transcriptSubTab === t
                    ? 'border-accent text-ink bg-accent/10 font-medium'
                    : 'border-black/10 text-ink-60 hover:text-ink'
                }`}
              >
                {t === 'cleaned' ? 'Cleaned' : 'Raw'}
              </button>
            ))}
          </div>

          {transcriptSubTab === 'cleaned' ? (
            cleanupStatus === 'success'
              ? <TranscriptSegments segments={cleanedSegments} emptyLabel="No cleaned transcript available." />
              : <PipelineStatusNotice status={cleanupStatus} onRetry={() => void handleRetry()} retrying={retrying} kind="cleanup" />
          ) : (
            <TranscriptSegments segments={rawSegments} emptyLabel="No transcript available." />
          )}
        </div>
      )}

      <button
        onClick={() => void handleDelete()}
        disabled={deleting}
        className="text-[12px] text-error hover:text-error self-start mt-4 px-3 py-1.5 rounded-lg bg-error/[0.08] hover:bg-error/15 transition-colors disabled:opacity-50"
      >
        {deleting ? 'Deleting…' : 'Delete meeting'}
      </button>
    </div>
  )
}
