export type GuideSectionId = 'dictation' | 'sessions' | 'notetaker' | 'notch'

export interface GuideEntry {
  id: string
  title: string
  summary: string
  shortcut?: string
  steps?: string[]
  example?: string
  keywords: string[]
  source: string
}

export interface GuideSection {
  id: GuideSectionId
  title: string
  intro: string
  entries: GuideEntry[]
}

export interface GuideData {
  title: string
  intro: string
  settings: { dictationKey: string; sessionKey: string; activationMode: string }
  sections: GuideSection[]
}

const SECTION_ORDER: GuideSectionId[] = ['dictation', 'sessions', 'notetaker', 'notch']

export function makeGuideViewModel(guide: GuideData): GuideSection[] {
  return SECTION_ORDER.flatMap((id) => {
    const section = guide.sections.find((candidate) => candidate.id === id)
    return section ? [section] : []
  })
}

function Shortcut({ children }: { children: string }) {
  return (
    <div className="mt-3 rounded-[10px] border border-border bg-cream-mid px-3 py-2 text-[12.5px] font-semibold leading-relaxed text-ink">
      {children}
    </div>
  )
}

function EntryCard({ entry }: { entry: GuideEntry }) {
  return (
    <article className="rounded-[14px] border border-border bg-white p-4 shadow-[0_1px_2px_rgba(34,30,24,0.03)]">
      <h3 className="text-[14px] font-bold text-ink">{entry.title}</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-60">{entry.summary}</p>
      {entry.shortcut && <Shortcut>{entry.shortcut}</Shortcut>}
      {entry.steps && entry.steps.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-ink-60">
          {entry.steps.map((step) => <li key={step}>• {step}</li>)}
        </ul>
      )}
      {entry.example && (
        <p className="mt-3 border-l-2 border-accent/45 pl-3 text-[12.5px] italic leading-relaxed text-ink-60">
          Example: {entry.example}
        </p>
      )}
    </article>
  )
}

export default function HowToUseUnmute({ guide, loading = false }: { guide: GuideData | null; loading?: boolean }) {
  if (loading || !guide) {
    return <div className="py-14 text-center text-[13px] text-ink-35">Loading your shortcuts…</div>
  }

  const sections = makeGuideViewModel(guide)
  return (
    <div className="max-w-2xl">
      <div className="mb-7">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-accent">Keep this close</div>
        <h1 className="font-display text-[26px] font-bold tracking-tight text-ink">{guide.title}</h1>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-60">{guide.intro}</p>
      </div>

      <div className="space-y-7">
        {sections.map((section) => (
          <section key={section.id}>
            <div className="mb-3">
              <h2 className="font-display text-[18px] font-bold tracking-tight text-ink">{section.title}</h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-60">{section.intro}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {section.entries.map((entry) => <EntryCard key={entry.id} entry={entry} />)}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-7 rounded-[14px] bg-accent/[0.08] px-4 py-3 text-[12.5px] leading-relaxed text-ink">
        Still unsure? Ask the Unmute Agent any “How do I…?” question. It can explain Unmute and help you manage your sessions.
      </div>
    </div>
  )
}
