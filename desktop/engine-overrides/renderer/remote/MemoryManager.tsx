import { useEffect, useMemo, useState } from 'react'
import {
  filterMemories,
  memoryAction,
  memoryAttachmentLabel,
  memoryKindLabel,
  memoryScopeChips,
  memorySourceLabel,
  memoryVersionLabel,
  type MemoryPresentationRecord,
} from './memoryPresentation'

interface MemoryRecord extends MemoryPresentationRecord {
  content?: string
  createdAt?: number
}

interface MemoryApi {
  remoteListMemories?: () => Promise<MemoryRecord[]>
  remoteGetMemory?: (id: string) => Promise<MemoryRecord | null>
  remoteForgetMemory?: (id: string) => Promise<boolean>
  remoteRestoreMemory?: (id: string) => Promise<boolean>
}

const api = (): MemoryApi =>
  (window as unknown as { electronAPI?: MemoryApi }).electronAPI ?? {}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export default function MemoryManager({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, MemoryRecord>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      setRecords(await api().remoteListMemories?.() ?? [])
      setError(null)
    } catch {
      setError('Memory is unavailable right now.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const visible = useMemo(() => filterMemories(records, query), [records, query])

  async function expand(record: MemoryRecord): Promise<void> {
    if (expanded === record.id) { setExpanded(null); return }
    setExpanded(record.id)
    if (details[record.id]) return
    const detail = await api().remoteGetMemory?.(record.id)
    if (detail) setDetails((current) => ({ ...current, [record.id]: detail }))
  }

  async function changeTrash(record: MemoryRecord): Promise<void> {
    setBusy(record.id)
    try {
      const action = memoryAction(record)
      const ok = action === 'restore'
        ? await api().remoteRestoreMemory?.(record.id)
        : await api().remoteForgetMemory?.(record.id)
      if (!ok) { setError(action === 'restore' ? 'That memory could not be restored.' : 'That memory could not be forgotten.'); return }
      setExpanded(null)
      setDetails((current) => {
        const next = { ...current }
        delete next[record.id]
        return next
      })
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-3xl">
      <button
        onClick={onBack}
        className="text-[11px] font-semibold text-ink-35 hover:text-ink transition-colors mb-4 flex items-center gap-1"
      >
        ← Back to privacy
      </button>
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-2">What Unmute keeps</h2>
      <p className="text-[13px] text-ink-60 leading-relaxed mb-5">
        Inspect and manage the memory you asked Unmute to keep. Forgotten items stay in Trash and can be restored.
      </p>

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search memory…"
        aria-label="Search memory"
        className="w-full px-4 py-2.5 rounded-xl border border-border bg-surface-2 text-[13px] text-ink placeholder:text-ink-35 focus:outline-none focus:border-accent transition-colors mb-3"
      />

      {error && <p className="text-[12.5px] text-warm bg-warm-soft rounded-xl px-4 py-3 mb-3">{error}</p>}
      {loading && <p className="text-[12.5px] text-ink-35 px-1 py-5">Loading memory…</p>}
      {!loading && visible.length === 0 && (
        <div className="bg-surface-2 border border-border rounded-2xl px-5 py-8 text-center shadow-sm">
          <p className="text-[13px] font-semibold text-ink">{query ? 'No matching memory' : 'Nothing kept yet'}</p>
          <p className="text-[11px] text-ink-35 mt-1">{query ? 'Try a different search.' : 'Things you explicitly ask Unmute to remember will appear here.'}</p>
        </div>
      )}

      <div className="space-y-2.5">
        {visible.map((record) => {
          const isOpen = expanded === record.id
          const detail = details[record.id]
          const trashed = record.deletedAt !== undefined
          return (
            <article key={record.id} className={`bg-surface-2 border rounded-2xl overflow-hidden shadow-sm ${trashed ? 'border-border opacity-75' : 'border-border'}`}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => { void expand(record) }}
                className="w-full text-left px-5 py-4 hover:bg-cream-mid transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[14px] font-semibold text-ink truncate">{record.title}</h3>
                      {trashed && <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-cream-dark text-ink-60">Trash</span>}
                    </div>
                    <p className="text-[11px] text-ink-35 mt-1">
                      {memoryKindLabel(record.kind)} · {memorySourceLabel(record.provenance?.source)} · Updated {dateTime.format(record.updatedAt)}
                    </p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {memoryScopeChips(record.scope).map((scope) => (
                        <span key={scope} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cream-mid text-ink-60">{scope}</span>
                      ))}
                    </div>
                  </div>
                  <span className="text-[13px] text-ink-35 shrink-0">{isOpen ? '⌃' : '⌄'}</span>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-border px-5 py-4">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-35 mb-3">
                    <span>{memoryAttachmentLabel(record.attachmentCount)}</span>
                    <span>{memoryVersionLabel(record.version)}</span>
                    {trashed && <span>Forgotten {dateTime.format(record.deletedAt!)}</span>}
                  </div>

                  <div className="rounded-xl border border-border bg-cream-mid px-4 py-3 text-[12.5px] text-ink-60 leading-relaxed whitespace-pre-wrap break-words">
                    {detail ? (detail.content?.trim() || 'This memory has no text content.') : 'Loading content…'}
                  </div>

                  <div className="flex items-center justify-between gap-3 mt-4">
                    <p className="text-[11px] text-ink-35">Permanent deletion is not available here.</p>
                    <button
                      type="button"
                      disabled={busy === record.id}
                      onClick={() => { void changeTrash(record) }}
                      className="px-3 py-1.5 rounded-full border border-border text-[11px] font-semibold text-ink-60 hover:bg-cream-mid disabled:opacity-50 shrink-0"
                    >
                      {busy === record.id ? 'Working…' : trashed ? 'Restore' : 'Forget'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}
