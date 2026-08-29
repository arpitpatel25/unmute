// Meeting detail — two top-level tabs (Notes / Transcript, 2026-08-25 spec
// §9), replacing the previous single flat transcript view.
//
// Transcript tab: Cleaned/Raw sub-tabs, Cleaned selected by default once
// cleanup has succeeded (else Raw, since Cleaned has nothing to show yet).
// Raw is always available regardless of cleanup status — unchanged from
// before this feature existed. Audio playback lives here as one normal
// meeting recording; capture's mic/system source files stay internal.
//
// Notes tab: title/date/time followed by a deliberately document-like Markdown
// view. It is not a stack of collapsible AI "key point" cards: the summary is
// a readable meeting note with clear sections and lists, like Granola's notes.
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
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
  // Only ever set by cleanup's language-recovery pass, when it suspected
  // mis-decoded speech from another language but wasn't confident enough
  // to correct `text` itself — see transcriptCleanup.ts.
  alt?: string
  note?: string
}

type NotetakerPipelineStatus = 'disabled' | 'pending' | 'success' | 'failed'

type NotetakerMeetingNotes = {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
  openQuestions: string[]
}

type API = {
  notetakerGetTranscript?: (id: string) => Promise<NotetakerTranscriptSegment[]>
  notetakerGetNotes?: (id: string) => Promise<NotetakerMeetingNotes | null>
  notetakerGetAudioUrl?: (id: string, channel: 'mic' | 'system' | 'mixed') => Promise<string | null>
  notetakerRenameMeeting?: (id: string, title: string) => Promise<void>
  notetakerDeleteMeeting?: (id: string) => Promise<void>
  notetakerRetryPipeline?: (id: string) => Promise<void>
  notetakerRetryTranscription?: (id: string) => Promise<void>
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
            {seg.channel === 'mic' ? 'You' : 'Them'}:{' '}
          </span>
          <span className="text-ink">{seg.text}</span>
          {seg.alt && (
            <div className="text-[11.5px] text-ink/50 italic mt-0.5">
              possible code-switch{seg.note ? ` (${seg.note})` : ''}: {seg.alt}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function transcriptAsPlainText(segments: NotetakerTranscriptSegment[]): string {
  return segments.map((seg) => {
    const speaker = seg.channel === 'mic' ? 'You' : 'Them'
    return `${speaker}: ${seg.text}`
  }).join('\n\n')
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
    return <p className="text-ink-60 text-sm">{kind === 'cleanup' ? 'No cleaned transcript is available.' : 'No notes could be generated because the recording contained no transcript.'}</p>
  }
  if (status === 'pending') {
    return <p className="text-ink-60 text-sm">{kind === 'cleanup' ? 'Cleaning up the transcript…' : 'Generating notes…'}</p>
  }
  return (
    <div className="flex items-center gap-2">
      <p className="text-error text-sm">{kind === 'cleanup' ? 'Cleanup failed.' : 'Notes could not be generated from clear speech.'}</p>
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

function legacyNotesAsMarkdown(notes: NotetakerMeetingNotes): string {
  const sections = [
    notes.summary,
    notes.keyPoints.length ? `## Key points\n${notes.keyPoints.map((item) => `- ${item}`).join('\n')}` : '',
    notes.decisions.length ? `## Decisions\n${notes.decisions.map((item) => `- ${item}`).join('\n')}` : '',
    notes.actionItems.length ? `## Action items\n${notes.actionItems.map((item) => `- ${item}`).join('\n')}` : '',
    notes.openQuestions.length ? `## Open questions\n${notes.openQuestions.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean)
  return sections.join('\n\n')
}

/**
 * Notes have to remain legible even when an agent returns only very simple
 * Markdown. Do not rely on Tailwind Typography's optional `prose` plugin for
 * this: this renderer supplies the hierarchy, list rhythm and visual grouping
 * itself, while ReactMarkdown continues to safely parse the agent output.
 */
function NotesDocument({ markdown, revealed }: { markdown: string; revealed: boolean }) {
  return (
    <article className={`notetaker-notes-document ${revealed ? 'notetaker-notes-revealed' : ''}`}>
      <div className="notetaker-notes-kicker">Meeting notes</div>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="notetaker-note-title">{children}</h1>,
          h2: ({ children }) => <h2 className="notetaker-note-heading">{children}</h2>,
          h3: ({ children }) => <h3 className="notetaker-note-subheading">{children}</h3>,
          p: ({ children }) => <p className="notetaker-note-paragraph">{children}</p>,
          ul: ({ children }) => <ul className="notetaker-note-list">{children}</ul>,
          ol: ({ children }) => <ol className="notetaker-note-list notetaker-note-ordered-list">{children}</ol>,
          li: ({ children }) => <li className="notetaker-note-list-item">{children}</li>,
          blockquote: ({ children }) => <blockquote className="notetaker-note-quote">{children}</blockquote>,
          strong: ({ children }) => <strong className="notetaker-note-strong">{children}</strong>,
          a: ({ children, href }) => <a className="notetaker-note-link" href={href}>{children}</a>,
        }}
      >
        {markdown}
      </ReactMarkdown>
      <style>{`
        @keyframes notetaker-note-reveal {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .notetaker-notes-document {
          --note-ink: #24211f;
          --note-muted: #746f69;
          --note-line: rgba(36, 33, 31, 0.11);
          --note-accent: #ed3937;
          background: #fcfbf8;
          border: 1px solid var(--note-line);
          border-radius: 18px;
          box-shadow: 0 1px 2px rgba(33, 28, 24, 0.03), 0 10px 30px rgba(33, 28, 24, 0.035);
          color: var(--note-ink);
          padding: 27px 30px 30px;
        }
        .notetaker-notes-kicker {
          color: var(--note-muted);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.11em;
          line-height: 1;
          margin-bottom: 23px;
          text-transform: uppercase;
        }
        .notetaker-note-title {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.035em;
          line-height: 1.18;
          margin: 0 0 24px;
        }
        .notetaker-note-heading {
          border-top: 1px solid var(--note-line);
          font-size: 17px;
          font-weight: 700;
          letter-spacing: -0.018em;
          line-height: 1.3;
          margin: 27px 0 13px;
          padding-top: 23px;
        }
        .notetaker-note-heading:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
        .notetaker-note-subheading {
          font-size: 14px;
          font-weight: 700;
          line-height: 1.4;
          margin: 20px 0 8px;
        }
        .notetaker-note-paragraph {
          font-size: 14px;
          line-height: 1.68;
          margin: 0 0 12px;
        }
        .notetaker-note-list {
          display: grid;
          gap: 9px;
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .notetaker-note-list-item {
          font-size: 14px;
          line-height: 1.58;
          padding-left: 19px;
          position: relative;
        }
        .notetaker-note-list-item::before {
          background: var(--note-accent);
          border-radius: 999px;
          content: '';
          height: 5px;
          left: 1px;
          position: absolute;
          top: 0.62em;
          width: 5px;
        }
        .notetaker-note-ordered-list { counter-reset: meeting-note; }
        .notetaker-note-ordered-list .notetaker-note-list-item { counter-increment: meeting-note; }
        .notetaker-note-ordered-list .notetaker-note-list-item::before {
          background: transparent;
          color: var(--note-accent);
          content: counter(meeting-note) '.';
          font-size: 12px;
          font-weight: 700;
          height: auto;
          top: 0.14em;
          width: auto;
        }
        .notetaker-note-quote {
          border-left: 2px solid var(--note-accent);
          color: var(--note-muted);
          font-size: 14px;
          line-height: 1.6;
          margin: 16px 0;
          padding: 1px 0 1px 14px;
        }
        .notetaker-note-strong { font-weight: 700; }
        .notetaker-note-link { color: #b92b2b; text-decoration: underline; text-underline-offset: 2px; }
        .notetaker-notes-revealed > :not(style) {
          animation: notetaker-note-reveal 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .notetaker-notes-revealed > :nth-child(2) { animation-delay: 35ms; }
        .notetaker-notes-revealed > :nth-child(3) { animation-delay: 115ms; }
        .notetaker-notes-revealed > :nth-child(4) { animation-delay: 190ms; }
        .notetaker-notes-revealed > :nth-child(5) { animation-delay: 265ms; }
        .notetaker-notes-revealed > :nth-child(6) { animation-delay: 340ms; }
        .notetaker-notes-revealed > :nth-child(n+7) { animation-delay: 415ms; }
        @media (prefers-reduced-motion: reduce) {
          .notetaker-notes-revealed > :not(style) { animation: none; }
        }
        @media (max-width: 520px) {
          .notetaker-notes-document { border-radius: 14px; padding: 22px 20px 24px; }
          .notetaker-note-title { font-size: 23px; }
        }
      `}</style>
    </article>
  )
}

export function MeetingDetail({
  id,
  initialTitle,
  startedAt,
  durationMs,
  initialSummaryStatus,
  onBack,
}: {
  id: string
  initialTitle: string
  startedAt: number
  durationMs: number
  initialSummaryStatus: NotetakerPipelineStatus
  onBack: () => void
}) {
  const [tab, setTab] = useState<'notes' | 'transcript'>('notes')
  const [rawSegments, setRawSegments] = useState<NotetakerTranscriptSegment[] | null>(null)
  const [notes, setNotes] = useState<NotetakerMeetingNotes | null>(null)
  const [summaryStatus, setSummaryStatus] = useState(initialSummaryStatus)
  const [retrying, setRetrying] = useState(false)
  const [retranscribing, setRetranscribing] = useState(false)

  const [meetingAudioUrl, setMeetingAudioUrl] = useState<string | null>(null)
  const [title, setTitle] = useState(initialTitle)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(initialTitle)
  const [deleting, setDeleting] = useState(false)
  const [notesRevealed, setNotesRevealed] = useState(false)
  const [notesCopied, setNotesCopied] = useState(false)
  const [transcriptCopied, setTranscriptCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setTab('notes')
    setRawSegments(null)
    setNotes(null)
    setSummaryStatus(initialSummaryStatus)
    setTitle(initialTitle)
    setDraftTitle(initialTitle)
    setNotesRevealed(false)
    setMeetingAudioUrl(null)
    setNotesCopied(false)
    setTranscriptCopied(false)

    api().notetakerGetTranscript?.(id)
      .then((data) => { if (!cancelled) setRawSegments(data ?? []) })
      .catch((err) => { console.error('Failed to load raw transcript:', err); if (!cancelled) setRawSegments([]) })

    api().notetakerGetNotes?.(id)
      .then((data) => { if (!cancelled) setNotes(data) })
      .catch((err) => { console.error('Failed to load notes:', err); if (!cancelled) setNotes(null) })

    api().notetakerGetAudioUrl?.(id, 'mixed')
      .then((url) => { if (!cancelled) setMeetingAudioUrl(url) })
      .catch(() => { if (!cancelled) setMeetingAudioUrl(null) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // A newly opened finished meeting should feel like the notes have arrived,
  // rather than like a static page jump. The same reveal also runs after a
  // pending detail view polls the completed notes in.
  useEffect(() => {
    if (tab !== 'notes' || summaryStatus !== 'success' || !notes) return
    // Reset first, then reveal on the following paint. This deliberately runs
    // every time the user comes back to Notes as well as when a new summary
    // arrives, so the Granola-style reveal cannot be skipped by navigation or
    // renderer hot reload preserving component state.
    setNotesRevealed(false)
    let revealFrame = 0
    const resetFrame = requestAnimationFrame(() => {
      revealFrame = requestAnimationFrame(() => setNotesRevealed(true))
    })
    return () => {
      cancelAnimationFrame(resetFrame)
      cancelAnimationFrame(revealFrame)
    }
  }, [tab, summaryStatus, notes])

  // Poll the note-generation status while it is pending — an in-flight run
  // (or a retry just kicked off below) needs
  // SOMETHING to notice when it settles, since nothing pushes that update
  // to an already-open detail view. Stops itself once both are settled.
  const pendingRef = useRef(false)
  pendingRef.current = summaryStatus === 'pending'
  useEffect(() => {
    if (!pendingRef.current) return
    let cancelled = false
    const interval = setInterval(() => {
      if (!pendingRef.current) { clearInterval(interval); return }
      api().notetakerGetPipelineStatus?.(id).then((result) => {
        if (cancelled || !result) return
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
  }, [id, summaryStatus === 'pending'])

  async function handleRetry() {
    if (retrying) return
    setRetrying(true)
    setSummaryStatus('pending')
    try {
      await api().notetakerRetryPipeline?.(id)
    } catch (err) {
      console.error('Failed to retry pipeline:', err)
    } finally {
      setRetrying(false)
    }
  }

  async function handleRetranscribe() {
    if (retranscribing) return
    setRetranscribing(true)
    setSummaryStatus('pending')
    setNotes(null)
    try {
      await api().notetakerRetryTranscription?.(id)
      const [segments, nextNotes, status, audioUrl] = await Promise.all([
        api().notetakerGetTranscript?.(id),
        api().notetakerGetNotes?.(id),
        api().notetakerGetPipelineStatus?.(id),
        api().notetakerGetAudioUrl?.(id, 'mixed'),
      ])
      setRawSegments(segments ?? [])
      setNotes(nextNotes ?? null)
      setSummaryStatus(status?.summary_status ?? 'failed')
      setMeetingAudioUrl(audioUrl ? `${audioUrl}?v=${Date.now()}` : null)
    } catch (err) {
      console.error('Failed to re-transcribe meeting:', err)
      setSummaryStatus('failed')
    } finally {
      setRetranscribing(false)
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

  async function copyTranscript() {
    if (!rawSegments?.length) return
    try {
      await navigator.clipboard.writeText(transcriptAsPlainText(rawSegments))
      setTranscriptCopied(true)
      window.setTimeout(() => setTranscriptCopied(false), 1800)
    } catch (err) {
      console.error('Failed to copy transcript:', err)
    }
  }

  async function copyNotes() {
    if (!notes) return
    try {
      await navigator.clipboard.writeText(legacyNotesAsMarkdown(notes))
      setNotesCopied(true)
      window.setTimeout(() => setNotesCopied(false), 1800)
    } catch (err) {
      console.error('Failed to copy notes:', err)
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
          <div className="flex flex-col gap-2">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void copyNotes()}
                className="text-[12px] px-2.5 py-1.5 rounded-md border border-black/10 text-ink-60 hover:text-ink hover:bg-black/[0.04] transition-colors"
              >
                {notesCopied ? 'Copied' : 'Copy notes'}
              </button>
            </div>
            <NotesDocument markdown={legacyNotesAsMarkdown(notes)} revealed={notesRevealed} />
          </div>
        ) : (
          <PipelineStatusNotice status={summaryStatus} onRetry={() => void handleRetry()} retrying={retrying} kind="summary" />
        )
      )}

      {tab === 'transcript' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleRetranscribe()}
              disabled={retranscribing || !meetingAudioUrl}
              className="text-[12px] px-2.5 py-1.5 rounded-md border border-black/10 text-ink-60 hover:text-ink hover:bg-black/[0.04] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Re-transcribe from retained audio and regenerate notes"
            >
              {retranscribing ? 'Re-transcribing…' : 'Re-transcribe'}
            </button>
            <button
              type="button"
              onClick={() => void copyTranscript()}
              disabled={!rawSegments?.length}
              className="text-[12px] px-2.5 py-1.5 rounded-md border border-black/10 text-ink-60 hover:text-ink hover:bg-black/[0.04] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {transcriptCopied ? 'Copied' : 'Copy transcript'}
            </button>
          </div>
          <div className="flex flex-col gap-2 rounded-lg bg-ink-07 p-3">
            <div className="text-[12px] font-semibold text-ink">Meeting recording</div>
            {meetingAudioUrl ? (
              <div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio controls src={meetingAudioUrl} className="w-full" />
              </div>
            ) : <p className="text-[11px] text-ink-60">The recording is unavailable. Audio is retained for 24 hours.</p>}
          </div>

          <TranscriptSegments segments={rawSegments} emptyLabel="No transcript available." />
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
