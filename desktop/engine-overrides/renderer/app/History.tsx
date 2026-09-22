import { useState, useEffect } from 'react'
import { SegmentedControl } from './_shared'
import type { Session } from '../shared/types'

interface CaptureHistoryEntry {
  id: string
  kind: 'dictation' | 'scratchpad'
  createdAt: number
  finalizedAt: number
  text: string
  destination: 'cursor' | 'task'
  taskId?: string
  attachments: string[]
  saved: boolean
}

function captureHistoryApi() {
  return window.electronAPI as unknown as {
    remoteListCaptureHistory?: (kind?: 'dictation' | 'scratchpad') => Promise<CaptureHistoryEntry[]>
    remoteSetCaptureHistorySaved?: (id: string, saved: boolean) => Promise<boolean>
    remoteDeleteCaptureHistory?: (id: string) => Promise<boolean>
    remoteCopyCaptureHistory?: (id: string) => Promise<boolean>
  }
}

const FLOW_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  dictation: { label: 'Dictation', color: 'text-ink', bg: 'bg-ink-07' },
  transform: { label: 'Instruction', color: 'text-accent', bg: 'bg-accent/[0.08]' },
  quote: { label: 'Quote', color: 'text-success', bg: 'bg-success/[0.08]' },
  context: { label: 'Context', color: 'text-gold', bg: 'bg-gold/[0.08]' }
}

// Engine chip — tells the user *which path actually ran* for this row.
// Vendor-agnostic labels: "Cloud" = managed pipeline, "Your key" = BYOK Groq,
// "Offline" = on-device whisper. Rows with no engine value (legacy or
// pre-tagging) render no chip at all.
const ENGINE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  cloud: { label: 'Cloud', color: 'text-accent', bg: 'bg-accent/[0.08]' },
  byok: { label: 'Your key', color: 'text-gold', bg: 'bg-gold/[0.08]' },
  local: { label: 'Offline', color: 'text-ink-60', bg: 'bg-ink-07' },
}

export default function History() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set())
  const [scratchpads, setScratchpads] = useState<CaptureHistoryEntry[]>([])
  const [dictationCaptures, setDictationCaptures] = useState<CaptureHistoryEntry[]>([])
  const [tab, setTab] = useState<'dictations' | 'scratchpads'>('dictations')

  useEffect(() => {
    loadSessions()
    loadScratchpads()
    loadDictationCaptures()

    // Listen for retry status updates from main process
    window.electronAPI.onRetryStatus((sessionId, status, data) => {
      if (status === 'processing') {
        setRetryingIds(prev => new Set(prev).add(sessionId))
      } else {
        // Remove from retrying set
        setRetryingIds(prev => {
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })

        // Update the session in-place with new data
        if (data) {
          setSessions(prev => prev.map(s =>
            s.id === sessionId ? { ...s, ...data } : s
          ))
        }
      }
    })

    return () => {
      window.electronAPI.removeAllListeners('session:retry-status')
    }
  }, [])

  async function loadSessions() {
    try {
      const data = await window.electronAPI.getSessions()
      setSessions(data)
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      setLoading(false)
    }
  }

  async function loadScratchpads() {
    try {
      const data = await captureHistoryApi().remoteListCaptureHistory?.('scratchpad')
      if (data) setScratchpads(data)
    } catch (err) {
      console.error('Failed to load scratchpad history:', err)
    }
  }

  async function loadDictationCaptures() {
    try {
      const data = await captureHistoryApi().remoteListCaptureHistory?.('dictation')
      if (data) setDictationCaptures(data)
    } catch (err) {
      console.error('Failed to load dictation capture history:', err)
    }
  }

  async function setScratchpadSaved(entry: CaptureHistoryEntry, saved: boolean) {
    const ok = await captureHistoryApi().remoteSetCaptureHistorySaved?.(entry.id, saved)
    if (ok) setScratchpads(prev => prev.map(item => item.id === entry.id ? { ...item, saved } : item))
  }

  async function deleteScratchpad(entry: CaptureHistoryEntry) {
    const ok = await captureHistoryApi().remoteDeleteCaptureHistory?.(entry.id)
    if (ok) setScratchpads(prev => prev.filter(item => item.id !== entry.id))
  }

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  async function copyOutput(text: string, sessionId: string, capture?: CaptureHistoryEntry) {
    const copied = capture
      ? await captureHistoryApi().remoteCopyCaptureHistory?.(capture.id)
      : false
    if (!copied) await navigator.clipboard.writeText(text)
    setCopiedId(sessionId)
    setTimeout(() => setCopiedId(null), 1500)
  }

  function retrySession(sessionId: string) {
    window.electronAPI.retrySession(sessionId)
  }

  if (loading) {
    return (
      <div>
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Dictation</h2>
        <div className="flex items-center gap-3 py-20 justify-center">
          <div className="w-[5px] h-[5px] rounded-full bg-accent animate-dot-bounce" />
          <div className="w-[5px] h-[5px] rounded-full bg-accent animate-dot-bounce" style={{ animationDelay: '0.15s' }} />
          <div className="w-[5px] h-[5px] rounded-full bg-accent animate-dot-bounce" style={{ animationDelay: '0.3s' }} />
        </div>
      </div>
    )
  }

  if (sessions.length === 0 && scratchpads.length === 0) {
    return (
      <div>
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Dictation</h2>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-20 h-20 rounded-2xl bg-ink-07 flex items-center justify-center mb-5">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-35">
              <rect x="9" y="1" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <p className="font-display font-bold text-ink text-lg mb-1">No dictations yet</p>
          <p className="text-ink-35 text-sm max-w-[260px] leading-relaxed">
            Press{' '}
            <kbd className="inline-flex px-1.5 py-0.5 rounded-md bg-gradient-to-b from-[#2E2A25] to-ink text-[10px] font-bold text-white/90 border border-black/50 shadow-[0_2px_0_rgba(0,0,0,0.55),0_1px_3px_rgba(0,0,0,0.25)]">Fn</kbd>
            {' '}to start your first dictation.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* RETENTION IS A PRIVACY CLAIM, so it says what the code does.
       *
       * Both halves of the old line were wrong. "Only today's sessions" — the
       * cutoff is a ROLLING 24 hours (db.ts:239), not a calendar day, which is
       * why a 3am screen still shows yesterday evening. And "the last 5
       * recordings" — audio is pruned by SESSION (audio.ts:5,
       * MAX_AUDIO_SESSIONS = 5, grouping files by session id), and one dictation
       * can write several chunks, so the count was not what it said either.
       *
       * The heading said "Today" for the same reason and was equally wrong.
       *
       * Not mentioned here on purpose: sessions are ALSO capped at 100 rows
       * (db.ts:242), oldest dropped first. It bites only on a very heavy day,
       * and a retention line that lists two rules is one nobody finishes
       * reading. Settings → Privacy is where the full posture belongs. */}
      <div className="mb-4">
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight">Dictation</h2>
        <p className="text-[11px] text-ink-35 mt-1">
          Unsaved captures are removed after 24 hours. Saved scratchpads stay until you delete them.
        </p>
      </div>

      <div className="mb-5 w-fit">
        <SegmentedControl
          options={[{ value: 'dictations', label: 'History' }, { value: 'scratchpads', label: 'Scratchpads' }]}
          value={tab}
          onChange={(value) => setTab(value as 'dictations' | 'scratchpads')}
        />
      </div>

      {tab === 'dictations' && <div className="flex flex-col gap-2.5">
        {sessions.map((session, index) => {
          const flow = FLOW_CONFIG[session.flowType] || FLOW_CONFIG.dictation
          const isCopied = copiedId === session.id
          const isRetrying = retryingIds.has(session.id)
          const hasAudio = !!session.audioFilePath
          const capture = dictationCaptures.find(entry => entry.id === session.id)
          // Copy whatever text is actually shown (line-clamped below). A recovered
          // dictation has no `output` — its text lives in `dictationTranscript` — so
          // gating copy on `output` alone hid the button for recovered rows.
          const copyText = session.output || session.dictationTranscript || ''

          return (
            <div
              key={session.id}
              className={`group relative p-4 rounded-2xl border transition-all duration-200 hover:shadow-md animate-slide-in-up ${
                isRetrying
                  ? 'border-accent/25 bg-accent/[0.03]'
                  : session.status === 'error'
                    ? 'border-error/15 bg-error-soft hover:border-error/25'
                    : 'border-border bg-surface-2 hover:border-border-md'
              }`}
              style={{ animationDelay: `${index * 0.05}s` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Header row */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[11px] text-ink-35 font-medium">{formatTime(session.createdAt)}</span>
                    <span className={`text-[10px] font-semibold ${flow.color} ${flow.bg} px-2 py-0.5 rounded-full`}>
                      {flow.label}
                    </span>
                    {(() => {
                      const eng = ENGINE_CONFIG[(session as unknown as { engine?: string }).engine ?? '']
                      return eng ? (
                        <span className={`text-[10px] font-semibold ${eng.color} ${eng.bg} px-2 py-0.5 rounded-full`}>
                          {eng.label}
                        </span>
                      ) : null
                    })()}
                    {isRetrying ? (
                      <span className="text-[10px] font-semibold text-accent bg-accent/[0.08] px-2 py-0.5 rounded-full">
                        Retrying...
                      </span>
                    ) : session.status === 'error' ? (
                      <span className="text-[10px] font-semibold text-error bg-error/[0.08] px-2 py-0.5 rounded-full">
                        Failed
                      </span>
                    ) : null}
                    {capture?.attachments.length ? <span className="text-[10px] text-ink-35">{capture.attachments.length} image{capture.attachments.length === 1 ? '' : 's'}</span> : null}
                  </div>

                  {/* Output text or retrying animation */}
                  {isRetrying ? (
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-[3px]">
                        {[6, 14, 10, 18, 8, 16, 12, 20].map((h, i) => (
                          <div
                            key={i}
                            className="w-[2.5px] rounded-sm bg-accent animate-dot-bounce"
                            style={{ height: `${h}px`, animationDelay: `${i * 0.1}s` }}
                          />
                        ))}
                      </div>
                      <span className="text-[13px] text-accent font-medium">Re-processing audio...</span>
                    </div>
                  ) : (
                    <>
                      <p className="text-[13px] text-ink leading-relaxed line-clamp-2">
                        {session.output || session.dictationTranscript || session.errorMessage || 'No output'}
                      </p>
                      {capture?.attachments.length ? <div className="flex gap-1.5 mt-2 overflow-hidden">{capture.attachments.slice(0, 4).map((attachment) => <img key={attachment} src={`file://${attachment}`} className="w-10 h-10 object-cover rounded-lg border border-border" />)}</div> : null}
                    </>
                  )}
                </div>

                {/* Waveform decoration — hidden while retrying */}
                {!isRetrying && (
                  <div className="flex items-center gap-[2px] h-[28px] opacity-[0.06] shrink-0 mr-1">
                    {[6, 14, 10, 18, 8, 16, 12, 20].map((h, i) => (
                      <div key={i} className="w-[2.5px] rounded-sm bg-ink" style={{ height: `${h}px` }} />
                    ))}
                  </div>
                )}

                {/* Actions — hidden while retrying */}
                {!isRetrying && (
                  <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200 shrink-0 translate-y-1 group-hover:translate-y-0">
                    {copyText && (
                      <button
                        onClick={() => void copyOutput(copyText, session.id, capture)}
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200 ${
                          isCopied
                            ? 'bg-success/10 text-success'
                            : 'bg-ink-07 text-ink-35 hover:bg-accent/10 hover:text-accent'
                        }`}
                        title="Copy"
                      >
                        {isCopied ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </button>
                    )}
                    {hasAudio && (
                      <button
                        onClick={() => retrySession(session.id)}
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200 ${
                          session.status === 'error'
                            ? 'bg-accent/[0.08] text-accent hover:bg-accent/15'
                            : 'bg-ink-07 text-ink-35 hover:bg-accent/10 hover:text-accent'
                        }`}
                        title="Re-process from saved audio"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="23 4 23 10 17 10" />
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>}

      {tab === 'scratchpads' && <div className="flex flex-col gap-2.5">
        {scratchpads.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-35">No delivered scratchpads in the last 24 hours.</p>
        ) : scratchpads.map((entry, index) => (
          <div key={entry.id} className="group relative p-4 rounded-2xl border border-border bg-surface-2 hover:border-border-md transition-all" style={{ animationDelay: `${index * 0.05}s` }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] text-ink-35 font-medium">{formatTime(entry.finalizedAt)}</span>
                  <span className="text-[10px] font-semibold text-accent bg-accent/[0.08] px-2 py-0.5 rounded-full">Scratchpad</span>
                  <span className="text-[10px] font-semibold text-ink-35 bg-ink-07 px-2 py-0.5 rounded-full">{entry.destination === 'cursor' ? 'Pasted' : 'Sent to task'}</span>
                  {entry.attachments.length > 0 && <span className="text-[10px] text-ink-35">{entry.attachments.length} image{entry.attachments.length === 1 ? '' : 's'}</span>}
                </div>
                <p className="text-[13px] text-ink leading-relaxed line-clamp-3">{entry.text}</p>
                {entry.attachments.length > 0 && <div className="flex gap-1.5 mt-2 overflow-hidden">{entry.attachments.slice(0, 4).map((attachment) => <img key={attachment} src={`file://${attachment}`} className="w-10 h-10 object-cover rounded-lg border border-border" />)}</div>}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => void copyOutput(entry.text, entry.id, entry)} className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${copiedId === entry.id ? 'bg-success/10 text-success' : 'bg-ink-07 text-ink-35 hover:bg-accent/10 hover:text-accent'}`} title="Copy text and images">
                  {copiedId === entry.id ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
                </button>
                <button onClick={() => void setScratchpadSaved(entry, !entry.saved)} className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${entry.saved ? 'bg-accent/10 text-accent' : 'bg-ink-07 text-ink-35 hover:bg-accent/10 hover:text-accent'}`} title={entry.saved ? 'Saved permanently' : 'Save permanently'}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={entry.saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
                </button>
                <button onClick={() => void deleteScratchpad(entry)} className="w-8 h-8 rounded-xl flex items-center justify-center bg-ink-07 text-ink-35 hover:bg-error/10 hover:text-error transition-colors" title="Delete scratchpad">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /></svg>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>}
    </div>
  )
}
