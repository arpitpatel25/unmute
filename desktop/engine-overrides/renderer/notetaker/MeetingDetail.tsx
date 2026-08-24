// Meeting detail — transcript (mic segments "You"; system segments show a
// real attributed speaker name when known — Zoom calls only, read from
// Zoom's own accessibility tree, see zoomSpeaker.ts — falling back to
// generic "Them" otherwise, same as before that existed), audio playback
// for whichever channel(s) still have audio (hidden once the
// 24h sweep has removed a channel's file — notetaker:get-audio-url returns
// null in that case), an editable title, and delete. `initialTitle` comes
// from MeetingsList's already-fetched row rather than a redundant IPC round
// trip for a value the caller already has.

import { useEffect, useState } from 'react'

// Field-for-field mirror of NotetakerTranscriptSegment (electron/remote-preload.ts).
// Same cross-tree reasoning as MeetingsList.tsx's NotetakerMeeting — not
// imported directly, redefined locally to match this app's established
// preload-facing-type precedent.
type NotetakerTranscriptSegment = {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
  speakerName?: string | null
}

type API = {
  notetakerGetTranscript?: (id: string) => Promise<NotetakerTranscriptSegment[]>
  notetakerGetAudioUrl?: (id: string, channel: 'mic' | 'system') => Promise<string | null>
  notetakerRenameMeeting?: (id: string, title: string) => Promise<void>
  notetakerDeleteMeeting?: (id: string) => Promise<void>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

export function MeetingDetail({
  id,
  initialTitle,
  onBack,
}: {
  id: string
  initialTitle: string
  onBack: () => void
}) {
  const [segments, setSegments] = useState<NotetakerTranscriptSegment[] | null>(null)
  const [micAudioUrl, setMicAudioUrl] = useState<string | null>(null)
  const [systemAudioUrl, setSystemAudioUrl] = useState<string | null>(null)
  const [title, setTitle] = useState(initialTitle)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(initialTitle)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSegments(null)
    setTitle(initialTitle)
    setDraftTitle(initialTitle)

    api().notetakerGetTranscript?.(id)
      .then((data) => { if (!cancelled) setSegments(data ?? []) })
      .catch((err) => {
        console.error('Failed to load meeting transcript:', err)
        if (!cancelled) setSegments([])
      })

    api().notetakerGetAudioUrl?.(id, 'mic')
      .then((url) => { if (!cancelled) setMicAudioUrl(url) })
      .catch(() => { if (!cancelled) setMicAudioUrl(null) })

    api().notetakerGetAudioUrl?.(id, 'system')
      .then((url) => { if (!cancelled) setSystemAudioUrl(url) })
      .catch(() => { if (!cancelled) setSystemAudioUrl(null) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

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

      <div className="flex flex-col gap-2">
        {segments === null && <p className="text-ink-60 text-sm">Loading…</p>}
        {segments?.length === 0 && <p className="text-ink-60 text-sm">No transcript available.</p>}
        {segments?.map((seg, i) => (
          <div key={i} className="text-[13px] leading-relaxed">
            <span className="font-semibold text-ink">
              {seg.channel === 'mic' ? 'You' : (seg.speakerName || 'Them')}:{' '}
            </span>
            <span className="text-ink">{seg.text}</span>
          </div>
        ))}
      </div>

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
